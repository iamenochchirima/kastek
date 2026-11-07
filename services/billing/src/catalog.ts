import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type {
  BillingPlanSummary,
  BillingProduct,
} from "@kasitek-labs/contracts";
import { transaction } from "./db.js";
import { taxBreakdown } from "./money.js";
import {
  arrayValue,
  bad,
  booleanValue,
  conflict,
  integerValue,
  missing,
  objectValue,
  optionalText,
  slug,
  text,
  wire,
} from "./util.js";

export interface PlanVersionRow {
  id: string;
  plan_id: string;
  plan_key: string;
  plan_name: string;
  plan_status: string;
  product_key: BillingProduct;
  version: number;
  interval: "monthly";
  currency: string;
  amount_minor: string;
  tax_inclusive: boolean;
  tax_rate_bps: number;
  credits_per_period: string | null;
  paystack_plan_code: string | null;
  active: boolean;
  effective_from: Date;
}

export interface PlanEntitlementRow {
  key: string;
  value: unknown;
}

export async function getPlanVersionById(
  pool: Pool | PoolClient,
  id: string,
  forUpdate = false,
): Promise<PlanVersionRow> {
  const result = await pool.query<PlanVersionRow>(
    `SELECT v.id, v.plan_id, p.key AS plan_key, p.name AS plan_name,
            p.status AS plan_status, p.product_key, v.version, v.interval,
            v.currency, v.amount_minor::text, v.tax_inclusive, v.tax_rate_bps,
            v.credits_per_period::text, v.paystack_plan_code, v.active, v.effective_from
       FROM billing.plan_versions v
       JOIN billing.plans p ON p.id=v.plan_id
      WHERE v.id=$1${forUpdate ? " FOR UPDATE OF v" : ""}`,
    [id],
  );
  if (!result.rows[0]) missing("Plan version not found");
  return result.rows[0];
}

export async function getActivePlanVersion(
  pool: Pool | PoolClient,
  planKey: string,
): Promise<PlanVersionRow> {
  const result = await pool.query<PlanVersionRow>(
    `SELECT v.id, v.plan_id, p.key AS plan_key, p.name AS plan_name,
            p.status AS plan_status, p.product_key, v.version, v.interval,
            v.currency, v.amount_minor::text, v.tax_inclusive, v.tax_rate_bps,
            v.credits_per_period::text, v.paystack_plan_code, v.active, v.effective_from
       FROM billing.plan_versions v
       JOIN billing.plans p ON p.id=v.plan_id
      WHERE p.key=$1 AND p.status='active' AND v.active=true
        AND v.effective_from<=now()
      ORDER BY v.version DESC LIMIT 1`,
    [planKey],
  );
  if (!result.rows[0]) missing("Active plan not found");
  return result.rows[0];
}

export async function getPlanEntitlements(
  pool: Pool | PoolClient,
  planVersionId: string,
): Promise<PlanEntitlementRow[]> {
  const result = await pool.query<PlanEntitlementRow>(
    `SELECT key, value FROM billing.plan_entitlements
      WHERE plan_version_id=$1 ORDER BY key`,
    [planVersionId],
  );
  return result.rows;
}

export async function getLatestPlanVersion(
  pool: Pool | PoolClient,
  planKey: string,
): Promise<PlanVersionRow> {
  const result = await pool.query<PlanVersionRow>(
    `SELECT v.id, v.plan_id, p.key AS plan_key, p.name AS plan_name,
            p.status AS plan_status, p.product_key, v.version, v.interval,
            v.currency, v.amount_minor::text, v.tax_inclusive, v.tax_rate_bps,
            v.credits_per_period::text, v.paystack_plan_code, v.active, v.effective_from
       FROM billing.plan_versions v
       JOIN billing.plans p ON p.id=v.plan_id
      WHERE p.key=$1 ORDER BY v.version DESC LIMIT 1`,
    [planKey],
  );
  if (!result.rows[0]) missing("Plan not found");
  return result.rows[0];
}

function entitlementKind(
  key: string,
  capabilities: Map<string, { kind: string; name: string; description: string | null }>,
): "feature" | "limit" | "meter" {
  const capability = capabilities.get(key);
  if (capability?.kind === "meter") return "meter";
  if (capability?.kind === "limit" || key.startsWith("limit.")) return "limit";
  return "feature";
}

export function planSummary(
  version: PlanVersionRow,
  entitlements: PlanEntitlementRow[],
  capabilities: Map<string, { kind: string; name: string; description: string | null }>,
): BillingPlanSummary {
  const amount = BigInt(version.amount_minor);
  const tax = taxBreakdown(amount, version.tax_inclusive, version.tax_rate_bps);
  return {
    key: version.plan_key,
    name: version.plan_name,
    product: version.product_key,
    version: version.version,
    interval: version.interval,
    currency: version.currency,
    amountMinor: wire(amount),
    taxInclusive: version.tax_inclusive,
    taxRateBps: version.tax_rate_bps,
    grossAmountMinor: wire(tax.totalMinor),
    creditsPerPeriod: version.credits_per_period,
    checkoutReady: Boolean(version.paystack_plan_code) && version.amount_minor !== "0",
    entitlements: entitlements.map((item) => {
      const capability = capabilities.get(item.key);
      return {
        key: item.key,
        value: item.value,
        kind: entitlementKind(item.key, capabilities),
        name: capability?.name ?? item.key,
        description: capability?.description ?? null,
      };
    }),
  };
}

export async function loadCapabilityMap(
  pool: Pool | PoolClient,
): Promise<Map<string, { kind: string; name: string; description: string | null }>> {
  const result = await pool.query<{
    key: string;
    kind: string;
    name: string;
    description: string | null;
  }>(`SELECT key, kind, name, description FROM billing.capabilities WHERE active=true`);
  return new Map(
    result.rows.map((row) => [
      row.key,
      { kind: row.kind, name: row.name, description: row.description },
    ]),
  );
}

export async function listPlans(
  pool: Pool,
  product?: BillingProduct,
): Promise<BillingPlanSummary[]> {
  const result = await pool.query<PlanVersionRow>(
    `SELECT DISTINCT ON (p.id)
            v.id, v.plan_id, p.key AS plan_key, p.name AS plan_name,
            p.status AS plan_status, p.product_key, v.version, v.interval,
            v.currency, v.amount_minor::text, v.tax_inclusive, v.tax_rate_bps,
            v.credits_per_period::text, v.paystack_plan_code, v.active, v.effective_from
       FROM billing.plan_versions v
       JOIN billing.plans p ON p.id=v.plan_id
      WHERE p.status='active' AND v.active=true AND v.effective_from<=now()
        AND ($1::text IS NULL OR p.product_key=$1)
      ORDER BY p.id, v.version DESC`,
    [product ?? null],
  );
  const capabilities = await loadCapabilityMap(pool);
  const summaries: BillingPlanSummary[] = [];
  for (const version of result.rows)
    summaries.push(
      planSummary(version, await getPlanEntitlements(pool, version.id), capabilities),
    );
  return summaries.sort((a, b) => {
    const product = a.product.localeCompare(b.product);
    if (product !== 0) return product;
    const left = BigInt(a.amountMinor);
    const right = BigInt(b.amountMinor);
    if (left !== right) return left < right ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function getPlanDetails(
  pool: Pool,
  planKey: string,
): Promise<BillingPlanSummary> {
  const version = await getActivePlanVersion(pool, planKey);
  return planSummary(
    version,
    await getPlanEntitlements(pool, version.id),
    await loadCapabilityMap(pool),
  );
}

export async function upsertProduct(
  pool: Pool,
  input: { key: string; name: string; description: string | null; active: boolean },
): Promise<unknown> {
  const key = slug(input.key, "Product key");
  const result = await pool.query(
    `INSERT INTO billing.catalog_products(key, name, description, active)
     VALUES($1,$2,$3,$4)
     ON CONFLICT (key) DO UPDATE SET
       name=EXCLUDED.name, description=EXCLUDED.description, active=EXCLUDED.active, updated_at=now()
     RETURNING key, name, description, active`,
    [key, text(input.name, "Product name", 120), input.description, input.active],
  );
  return result.rows[0];
}

export async function upsertCapability(
  pool: Pool,
  input: {
    key: string;
    product: BillingProduct;
    name: string;
    description: string | null;
    kind: "feature" | "limit" | "meter";
    unit: string | null;
    creditCostPerUnit: string | null;
    creditCostMinimum: string;
    active: boolean;
  },
): Promise<unknown> {
  const key = slug(input.key, "Capability key");
  const result = await pool.query(
    `INSERT INTO billing.capabilities(
       key, product, name, description, kind, unit,
       credit_cost_per_unit, credit_cost_minimum, active
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (key) DO UPDATE SET
       product=EXCLUDED.product, name=EXCLUDED.name, description=EXCLUDED.description,
       kind=EXCLUDED.kind, unit=EXCLUDED.unit,
       credit_cost_per_unit=EXCLUDED.credit_cost_per_unit,
       credit_cost_minimum=EXCLUDED.credit_cost_minimum,
       active=EXCLUDED.active, updated_at=now()
     RETURNING key, product, name, kind, active`,
    [
      key,
      input.product,
      text(input.name, "Capability name", 120),
      input.description,
      input.kind,
      input.unit,
      input.creditCostPerUnit,
      input.creditCostMinimum,
      input.active,
    ],
  );
  return result.rows[0];
}

export async function upsertPlan(
  pool: Pool,
  input: {
    product: BillingProduct;
    key: string;
    name: string;
    amountMinor: string;
    currency: string;
    taxInclusive: boolean;
    taxRateBps: number;
    creditsPerPeriod: string | null;
    paystackPlanCode: string | null;
    active: boolean;
    entitlements: Array<{ key: string; value: unknown }>;
  },
): Promise<BillingPlanSummary> {
  const key = slug(input.key, "Plan key");
  const product = input.product;
  const amount = BigInt(input.amountMinor);
  if (amount < 0n) bad("Plan amount cannot be negative");
  if (!/^[A-Z]{3}$/.test(input.currency)) bad("Plan currency is invalid");
  if (!Number.isInteger(input.taxRateBps) || input.taxRateBps < 0 || input.taxRateBps > 10_000)
    bad("Plan tax rate is invalid");
  if (input.active && amount > 0n && !input.paystackPlanCode)
    bad("An active paid plan requires a Paystack plan code");
  if (input.creditsPerPeriod != null && BigInt(input.creditsPerPeriod) < 0n)
    bad("Plan credits cannot be negative");

  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `plan:${key}`,
    ]);
    const existing = await client.query<{ id: string; product_key: string }>(
      `SELECT id, product_key FROM billing.plans WHERE key=$1 FOR UPDATE`,
      [key],
    );
    let planId: string;
    if (existing.rows[0]) {
      if (existing.rows[0].product_key !== product)
        conflict("Plan already belongs to another product");
      planId = existing.rows[0].id;
      await client.query(
        `UPDATE billing.plans SET name=$2, status=$3, updated_at=now() WHERE id=$1`,
        [planId, text(input.name, "Plan name", 120), input.active ? "active" : "draft"],
      );
    } else {
      planId = `pln_${randomUUID()}`;
      await client.query(
        `INSERT INTO billing.plans(id, product_key, key, name, status)
         VALUES($1,$2,$3,$4,$5)`,
        [planId, product, key, text(input.name, "Plan name", 120), input.active ? "active" : "draft"],
      );
    }
    const next = await client.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0)::int + 1 AS version
         FROM billing.plan_versions WHERE plan_id=$1`,
      [planId],
    );
    const version = next.rows[0]!.version;
    const versionId = `plv_${randomUUID()}`;
    if (input.active)
      await client.query(
        `UPDATE billing.plan_versions SET active=false, updated_at=now() WHERE plan_id=$1 AND active=true`,
        [planId],
      );
    await client.query(
      `INSERT INTO billing.plan_versions(
         id, plan_id, version, interval, currency, amount_minor,
         tax_inclusive, tax_rate_bps, credits_per_period, paystack_plan_code, active
       ) VALUES($1,$2,$3,'monthly',$4,$5,$6,$7,$8,$9,$10)`,
      [
        versionId,
        planId,
        version,
        input.currency,
        amount.toString(),
        input.taxInclusive,
        input.taxRateBps,
        input.creditsPerPeriod,
        input.paystackPlanCode,
        input.active,
      ],
    );
    await replacePlanEntitlementsTx(client, versionId, input.entitlements);
    return planSummary(
      await getPlanVersionById(client, versionId),
      await getPlanEntitlements(client, versionId),
      await loadCapabilityMap(client),
    );
  });
}

export async function createPlanVersion(
  pool: Pool,
  planKey: string,
  input: {
    amountMinor: string;
    currency: string;
    taxInclusive: boolean;
    taxRateBps: number;
    creditsPerPeriod: string | null;
    paystackPlanCode: string | null;
    active: boolean;
    entitlements: Array<{ key: string; value: unknown }>;
  },
): Promise<BillingPlanSummary> {
  return transaction(pool, async (client) => {
    const plan = await client.query<{ id: string; product_key: BillingProduct; name: string }>(
      `SELECT id, product_key, name FROM billing.plans WHERE key=$1 FOR UPDATE`,
      [planKey],
    );
    if (!plan.rows[0]) missing("Plan not found");
    const amount = BigInt(input.amountMinor);
    if (amount < 0n) bad("Plan amount cannot be negative");
    if (input.active && amount > 0n && !input.paystackPlanCode)
      bad("An active paid plan requires a Paystack plan code");
    const next = await client.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0)::int + 1 AS version FROM billing.plan_versions WHERE plan_id=$1`,
      [plan.rows[0].id],
    );
    if (input.active)
      await client.query(
        `UPDATE billing.plan_versions SET active=false, updated_at=now() WHERE plan_id=$1 AND active=true`,
        [plan.rows[0].id],
      );
    const versionId = `plv_${randomUUID()}`;
    await client.query(
      `INSERT INTO billing.plan_versions(
         id, plan_id, version, interval, currency, amount_minor,
         tax_inclusive, tax_rate_bps, credits_per_period, paystack_plan_code, active
       ) VALUES($1,$2,$3,'monthly',$4,$5,$6,$7,$8,$9,$10)`,
      [
        versionId,
        plan.rows[0].id,
        next.rows[0]!.version,
        input.currency,
        amount.toString(),
        input.taxInclusive,
        input.taxRateBps,
        input.creditsPerPeriod,
        input.paystackPlanCode,
        input.active,
      ],
    );
    await replacePlanEntitlementsTx(client, versionId, input.entitlements);
    return planSummary(
      await getPlanVersionById(client, versionId),
      await getPlanEntitlements(client, versionId),
      await loadCapabilityMap(client),
    );
  });
}

export async function replacePlanEntitlements(
  pool: Pool,
  planVersionId: string,
  entitlements: Array<{ key: string; value: unknown }>,
): Promise<void> {
  await transaction(pool, (client) =>
    replacePlanEntitlementsTx(client, planVersionId, entitlements),
  );
}

async function replacePlanEntitlementsTx(
  client: PoolClient,
  planVersionId: string,
  entitlements: Array<{ key: string; value: unknown }>,
): Promise<void> {
  const version = await client.query<{ plan_id: string }>(
    `SELECT plan_id FROM billing.plan_versions WHERE id=$1`,
    [planVersionId],
  );
  if (!version.rows[0]) missing("Plan version not found");
  const seen = new Set<string>();
  for (const item of entitlements) {
    const key = slug(item.key, "Entitlement key");
    if (seen.has(key)) conflict(`Duplicate entitlement ${key}`);
    seen.add(key);
    await client.query(
      `INSERT INTO billing.plan_entitlements(id, plan_version_id, key, value)
       VALUES($1,$2,$3,$4)
       ON CONFLICT (plan_version_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [`ple_${randomUUID()}`, planVersionId, key, JSON.stringify(item.value)],
    );
  }
  if (seen.size === 0)
    await client.query(`DELETE FROM billing.plan_entitlements WHERE plan_version_id=$1`, [
      planVersionId,
    ]);
  else
    await client.query(
      `DELETE FROM billing.plan_entitlements WHERE plan_version_id=$1 AND NOT (key = ANY($2::text[]))`,
      [planVersionId, [...seen]],
    );
}

export async function adminCatalog(pool: Pool): Promise<unknown> {
  const products = await pool.query(
    `SELECT key, name, description, active FROM billing.catalog_products ORDER BY name`,
  );
  const plans = await pool.query(
    `SELECT p.key, p.product_key, p.name, p.status,
            v.id AS version_id, v.version, v.interval, v.currency,
            v.amount_minor::text, v.tax_inclusive, v.tax_rate_bps,
            v.credits_per_period::text, v.paystack_plan_code, v.active,
            v.effective_from
       FROM billing.plans p
       LEFT JOIN LATERAL (
         SELECT * FROM billing.plan_versions q
          WHERE q.plan_id=p.id ORDER BY q.version DESC LIMIT 1
       ) v ON true
      ORDER BY p.product_key, p.name`,
  );
  const entitlements = await pool.query(
    `SELECT p.key AS plan_key, v.id AS version_id, e.key, e.value
       FROM billing.plan_entitlements e
       JOIN billing.plan_versions v ON v.id=e.plan_version_id
       JOIN billing.plans p ON p.id=v.plan_id
      ORDER BY p.key, e.key`,
  );
  const capabilities = await pool.query(
    `SELECT key, product, name, description, kind, unit,
            credit_cost_per_unit::text, credit_cost_minimum::text, active
       FROM billing.capabilities ORDER BY product, key`,
  );
  return {
    products: products.rows,
    plans: plans.rows.map((row) => ({
      key: row.key,
      productKey: row.product_key,
      name: row.name,
      status: row.status,
      versionId: row.version_id,
      version: row.version,
      interval: String(row.interval ?? "monthly").toUpperCase(),
      currency: row.currency,
      amountMinor: row.amount_minor == null ? null : Number(row.amount_minor),
      taxInclusive: row.tax_inclusive,
      taxRateBps: row.tax_rate_bps,
      creditsPerPeriod:
        row.credits_per_period == null ? null : Number(row.credits_per_period),
      paystackPlanCode: row.paystack_plan_code,
      active: row.active,
      effectiveFrom: row.effective_from,
    })),
    entitlements: entitlements.rows.map((row) => ({
      planKey: row.plan_key,
      versionId: row.version_id,
      key: row.key,
      value: row.value,
    })),
    capabilities: capabilities.rows.map((row) => ({
      key: row.key,
      product: row.product,
      name: row.name,
      description: row.description,
      kind: row.kind,
      unit: row.unit,
      creditCostPerUnit: row.credit_cost_per_unit,
      creditCostMinimum: row.credit_cost_minimum,
      active: row.active,
    })),
    accessDefinitions: capabilities.rows.map((row) => ({
      key: row.key,
      name: row.name,
      kind: row.kind === "meter" ? "meter" : "capability",
    })),
  };
}

export function parsePlanEntitlements(value: unknown): Array<{ key: string; value: unknown }> {
  return arrayValue(value, "Entitlements").map((item) => {
    const row = objectValue(item, "Entitlement");
    return {
      key: text(row.key, "Entitlement key", 120),
      value: row.value,
    };
  });
}

export function parseProduct(value: unknown): BillingProduct {
  if (value !== "growth" && value !== "agents" && value !== "agency")
    bad("Product must be growth, agents, or agency");
  return value;
}

export function parseCapabilityKind(value: unknown): "feature" | "limit" | "meter" {
  if (value === "feature" || value === "limit" || value === "meter") return value;
  bad("Capability kind must be feature, limit, or meter");
}

export function parseOptionalWire(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed = BigInt(String(value));
    if (parsed < 0n) bad(`${name} cannot be negative`);
    return parsed.toString();
  } catch {
    return bad(`${name} is invalid`);
  }
}

export function parseTaxRate(value: unknown): number {
  return integerValue(value, "Tax rate", 0, 10_000);
}

export function parseBoolean(value: unknown, fallback: boolean): boolean {
  return booleanValue(value, fallback);
}

export function optionalString(value: unknown, max = 2000): string | null {
  return optionalText(value, max);
}
