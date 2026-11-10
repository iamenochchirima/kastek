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
  plan_description: string | null;
  plan_status: string;
  plan_audience: "public" | "sandbox";
  product_key: BillingProduct;
  version: number;
  status: "draft" | "scheduled" | "active" | "retired";
  interval: "monthly";
  currency: string;
  amount_minor: string;
  tax_inclusive: boolean;
  tax_rate_bps: number;
  credits_per_period: string | null;
  paystack_plan_code: string | null;
  active: boolean;
  effective_from: Date;
  effective_to: Date | null;
  published_at: Date | null;
  published_by: string | null;
  notes: string | null;
}

export interface PlanEntitlementRow {
  key: string;
  value: unknown;
  metadata: Record<string, unknown>;
}

export interface CapabilityRow {
  key: string;
  product: BillingProduct;
  name: string;
  description: string | null;
  kind: "feature" | "limit" | "meter";
  unit: string | null;
  value_type: "boolean" | "integer" | "decimal" | "string";
  display_group: string | null;
  display_order: number;
  visible_to_customer: boolean;
  implementation_status: "implemented" | "product_pending" | "display_only";
  credit_cost_per_unit: string | null;
  credit_cost_minimum: string;
  active: boolean;
}

const VERSION_COLUMNS = `v.id, v.plan_id, p.key AS plan_key, p.name AS plan_name,
  p.description AS plan_description, p.status AS plan_status,
  p.audience AS plan_audience, p.product_key,
  v.version, v.status, v.interval, v.currency, v.amount_minor::text,
  v.tax_inclusive, v.tax_rate_bps, v.credits_per_period::text,
  v.paystack_plan_code, v.active, v.effective_from, v.effective_to,
  v.published_at, v.published_by, v.notes`;

export async function getPlanVersionById(
  pool: Pool | PoolClient,
  id: string,
  forUpdate = false,
): Promise<PlanVersionRow> {
  const result = await pool.query<PlanVersionRow>(
    `SELECT ${VERSION_COLUMNS}
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
  currency?: string,
): Promise<PlanVersionRow> {
  const result = await pool.query<PlanVersionRow>(
    `SELECT ${VERSION_COLUMNS}
       FROM billing.plan_versions v
       JOIN billing.plans p ON p.id=v.plan_id
      WHERE p.key=$1
        AND p.status='active'
        AND v.status='active'
        AND v.active=true
        AND v.effective_from<=now()
        AND (v.effective_to IS NULL OR v.effective_to>now())
        AND ($2::text IS NULL OR v.currency=$2)
      ORDER BY v.version DESC`,
    [planKey, currency ?? null],
  );
  if (!result.rows[0]) missing("Active plan not found");
  if (result.rows.length > 1 && !currency)
    bad("Plan has multiple active currencies; specify a currency");
  if (result.rows.length > 1)
    bad("Plan has multiple active versions for this currency");
  return result.rows[0];
}

export async function getPlanEntitlements(
  pool: Pool | PoolClient,
  planVersionId: string,
): Promise<PlanEntitlementRow[]> {
  const result = await pool.query<PlanEntitlementRow>(
    `SELECT key, value, metadata FROM billing.plan_entitlements
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
    `SELECT ${VERSION_COLUMNS}
       FROM billing.plan_versions v
       JOIN billing.plans p ON p.id=v.plan_id
      WHERE p.key=$1 ORDER BY v.version DESC LIMIT 1`,
    [planKey],
  );
  if (!result.rows[0]) missing("Plan not found");
  return result.rows[0];
}

export async function loadCapabilityMap(
  pool: Pool | PoolClient,
): Promise<Map<string, CapabilityRow>> {
  const result = await pool.query<CapabilityRow>(
    `SELECT key, product, name, description, kind, unit, value_type,
            display_group, display_order, visible_to_customer,
            implementation_status, credit_cost_per_unit::text,
            credit_cost_minimum::text, active
       FROM billing.capabilities WHERE active=true`,
  );
  return new Map(result.rows.map((row) => [row.key, row]));
}

function entitlementKind(
  key: string,
  capabilities: Map<string, CapabilityRow>,
): "feature" | "limit" | "meter" {
  const capability = capabilities.get(key);
  if (capability?.kind === "meter") return "meter";
  if (capability?.kind === "limit" || key.startsWith("limit.")) return "limit";
  return "feature";
}

export function planSummary(
  version: PlanVersionRow,
  entitlements: PlanEntitlementRow[],
  capabilities: Map<string, CapabilityRow>,
): BillingPlanSummary {
  const amount = BigInt(version.amount_minor);
  const tax = taxBreakdown(amount, version.tax_inclusive, version.tax_rate_bps);
  return {
    key: version.plan_key,
    name: version.plan_name,
    description: version.plan_description,
    product: version.product_key,
    version: version.version,
    versionId: version.id,
    status: version.status,
    interval: version.interval,
    currency: version.currency,
    amountMinor: wire(amount),
    taxInclusive: version.tax_inclusive,
    taxRateBps: version.tax_rate_bps,
    grossAmountMinor: wire(tax.totalMinor),
    creditsPerPeriod: version.credits_per_period,
    checkoutReady: Boolean(version.paystack_plan_code) && amount > 0n,
    effectiveFrom: version.effective_from.toISOString(),
    effectiveTo: version.effective_to?.toISOString() ?? null,
    notes: version.notes,
    entitlements: entitlements
      .map((item) => {
        const capability = capabilities.get(item.key);
        return {
          key: item.key,
          value: item.value,
          kind: entitlementKind(item.key, capabilities),
          name: capability?.name ?? item.key,
          description: capability?.description ?? null,
          unit: capability?.unit ?? null,
          metadata: item.metadata ?? {},
          implementationStatus:
            capability?.implementation_status ?? "product_pending",
          visibleToCustomer: capability?.visible_to_customer ?? true,
          displayGroup: capability?.display_group ?? null,
          displayOrder: capability?.display_order ?? 0,
        };
      })
      .sort((left, right) => {
        const group = (left.displayGroup ?? "").localeCompare(
          right.displayGroup ?? "",
        );
        return group || left.displayOrder - right.displayOrder || left.key.localeCompare(right.key);
      }),
  };
}

export async function listPlans(
  pool: Pool,
  product?: BillingProduct,
  currency?: string,
): Promise<BillingPlanSummary[]> {
  const result = await pool.query<PlanVersionRow>(
    `SELECT DISTINCT ON (p.id) ${VERSION_COLUMNS}
       FROM billing.plan_versions v
       JOIN billing.plans p ON p.id=v.plan_id
      WHERE p.status='active' AND p.audience='public'
        AND v.status='active' AND v.active=true
        AND v.effective_from<=now()
        AND (v.effective_to IS NULL OR v.effective_to>now())
        AND ($1::text IS NULL OR p.product_key=$1)
        AND ($2::text IS NULL OR v.currency=$2)
      ORDER BY p.id, v.version DESC`,
    [product ?? null, currency ?? null],
  );
  const capabilities = await loadCapabilityMap(pool);
  const summaries: BillingPlanSummary[] = [];
  for (const version of result.rows)
    summaries.push(
      planSummary(version, await getPlanEntitlements(pool, version.id), capabilities),
    );
  return summaries.sort((a, b) => {
    const productSort = a.product.localeCompare(b.product);
    if (productSort !== 0) return productSort;
    const left = BigInt(a.amountMinor);
    const right = BigInt(b.amountMinor);
    if (left !== right) return left < right ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function getPlanDetails(
  pool: Pool,
  planKey: string,
  currency?: string,
): Promise<BillingPlanSummary> {
  const version = await getActivePlanVersion(pool, planKey, currency);
  if (version.plan_audience === "sandbox") missing("Plan not found");
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
    valueType: "boolean" | "integer" | "decimal" | "string";
    displayGroup: string | null;
    displayOrder: number;
    visibleToCustomer: boolean;
    implementationStatus: "implemented" | "product_pending" | "display_only";
    creditCostPerUnit: string | null;
    creditCostMinimum: string;
    active: boolean;
  },
): Promise<unknown> {
  const key = slug(input.key, "Capability key");
  const result = await pool.query(
    `INSERT INTO billing.capabilities(
       key, product, name, description, kind, unit, value_type,
       display_group, display_order, visible_to_customer,
       implementation_status, credit_cost_per_unit, credit_cost_minimum, active
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (key) DO UPDATE SET
       product=EXCLUDED.product, name=EXCLUDED.name,
       description=EXCLUDED.description, kind=EXCLUDED.kind,
       unit=EXCLUDED.unit, value_type=EXCLUDED.value_type,
       display_group=EXCLUDED.display_group,
       display_order=EXCLUDED.display_order,
       visible_to_customer=EXCLUDED.visible_to_customer,
       implementation_status=EXCLUDED.implementation_status,
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
      input.valueType,
      input.displayGroup,
      input.displayOrder,
      input.visibleToCustomer,
      input.implementationStatus,
      input.creditCostPerUnit,
      input.creditCostMinimum,
      input.active,
    ],
  );
  return result.rows[0];
}

function validatePlanInput(input: {
  amountMinor: string;
  currency: string;
  taxRateBps: number;
  creditsPerPeriod: string | null;
  active: boolean;
  paystackPlanCode: string | null;
}): void {
  const amount = BigInt(input.amountMinor);
  if (amount < 0n) bad("Plan amount cannot be negative");
  if (!/^[A-Z]{3}$/.test(input.currency)) bad("Plan currency is invalid");
  if (!Number.isInteger(input.taxRateBps) || input.taxRateBps < 0 || input.taxRateBps > 10_000)
    bad("Plan tax rate is invalid");
  if (input.active && amount > 0n && !input.paystackPlanCode)
    bad("An active paid plan requires a Paystack plan code");
  if (input.creditsPerPeriod != null && BigInt(input.creditsPerPeriod) < 0n)
    bad("Plan credits cannot be negative");
}

export async function upsertPlan(
  pool: Pool,
  input: {
    product: BillingProduct;
    key: string;
    name: string;
    description?: string | null;
    amountMinor: string;
    currency: string;
    taxInclusive: boolean;
    taxRateBps: number;
    creditsPerPeriod: string | null;
    paystackPlanCode: string | null;
    active: boolean;
    entitlements: Array<{ key: string; value: unknown; metadata?: Record<string, unknown> }>;
  },
): Promise<BillingPlanSummary> {
  validatePlanInput(input);
  return transaction(pool, async (client) => {
    const key = slug(input.key, "Plan key");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `plan:${key}`,
    ]);
    const existing = await client.query<{ id: string; product_key: string }>(
      `SELECT id, product_key FROM billing.plans WHERE key=$1 FOR UPDATE`,
      [key],
    );
    let planId: string;
    if (existing.rows[0]) {
      if (existing.rows[0].product_key !== input.product)
        conflict("Plan already belongs to another product");
      planId = existing.rows[0].id;
      await client.query(
        `UPDATE billing.plans SET name=$2, description=$3, status=$4, updated_at=now() WHERE id=$1`,
        [
          planId,
          text(input.name, "Plan name", 120),
          input.description ?? null,
          input.active ? "active" : "draft",
        ],
      );
    } else {
      planId = `pln_${randomUUID()}`;
      await client.query(
        `INSERT INTO billing.plans(id, product_key, key, name, description, status)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          planId,
          input.product,
          key,
          text(input.name, "Plan name", 120),
          input.description ?? null,
          input.active ? "active" : "draft",
        ],
      );
    }
    const next = await client.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0)::int + 1 AS version
         FROM billing.plan_versions WHERE plan_id=$1`,
      [planId],
    );
    if (input.active)
      await client.query(
        `UPDATE billing.plan_versions
            SET status='retired', active=false, updated_at=now()
          WHERE plan_id=$1 AND currency=$2 AND status='active'`,
        [planId, input.currency],
      );
    const versionId = `plv_${randomUUID()}`;
    await client.query(
      `INSERT INTO billing.plan_versions(
         id, plan_id, version, status, interval, currency, amount_minor,
         tax_inclusive, tax_rate_bps, credits_per_period, paystack_plan_code,
         active, published_at, published_by
       ) VALUES($1,$2,$3,$4,'monthly',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        versionId,
        planId,
        next.rows[0]!.version,
        input.active ? "active" : "draft",
        input.currency,
        input.amountMinor,
        input.taxInclusive,
        input.taxRateBps,
        input.creditsPerPeriod,
        input.paystackPlanCode,
        input.active,
        input.active ? new Date() : null,
        input.active ? "catalog" : null,
      ],
    );
    await replacePlanEntitlementsTx(client, versionId, input.entitlements, true);
    return planSummary(
      await getPlanVersionById(client, versionId),
      await getPlanEntitlements(client, versionId),
      await loadCapabilityMap(client),
    );
  });
}

export async function createPlanDraft(
  pool: Pool,
  input: {
    product: BillingProduct;
    key: string;
    name: string;
    description: string | null;
    amountMinor: string;
    currency: string;
    taxInclusive: boolean;
    taxRateBps: number;
    creditsPerPeriod: string | null;
    paystackPlanCode: string | null;
    entitlements?: Array<{ key: string; value: unknown; metadata?: Record<string, unknown> }>;
  },
): Promise<BillingPlanSummary> {
  validatePlanInput({ ...input, active: false });
  return transaction(pool, async (client) => {
    const key = slug(input.key, "Plan key");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `plan:${key}`,
    ]);
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM billing.plans WHERE key=$1`,
      [key],
    );
    if (existing.rows[0]) conflict("Plan key is already in use");
    const planId = `pln_${randomUUID()}`;
    await client.query(
      `INSERT INTO billing.plans(id, product_key, key, name, description, status)
       VALUES($1,$2,$3,$4,$5,'draft')`,
      [planId, input.product, key, text(input.name, "Plan name", 120), input.description],
    );
    const versionId = `plv_${randomUUID()}`;
    await client.query(
      `INSERT INTO billing.plan_versions(
         id, plan_id, version, status, interval, currency, amount_minor,
         tax_inclusive, tax_rate_bps, credits_per_period, paystack_plan_code, active
       ) VALUES($1,$2,1,'draft','monthly',$3,$4,$5,$6,$7,$8,false)`,
      [
        versionId,
        planId,
        input.currency,
        input.amountMinor,
        input.taxInclusive,
        input.taxRateBps,
        input.creditsPerPeriod,
        input.paystackPlanCode,
      ],
    );
    await replacePlanEntitlementsTx(client, versionId, input.entitlements ?? [], true);
    return planSummary(
      await getPlanVersionById(client, versionId),
      await getPlanEntitlements(client, versionId),
      await loadCapabilityMap(client),
    );
  });
}

export async function createPlanVersionDraft(
  pool: Pool,
  planKey: string,
  input?: {
    amountMinor?: string;
    currency?: string;
    taxInclusive?: boolean;
    taxRateBps?: number;
    creditsPerPeriod?: string | null;
    paystackPlanCode?: string | null;
    notes?: string | null;
    entitlements?: Array<{ key: string; value: unknown; metadata?: Record<string, unknown> }>;
  },
): Promise<BillingPlanSummary> {
  return transaction(pool, async (client) => {
    const plan = await client.query<{
      id: string;
      product_key: BillingProduct;
      name: string;
      description: string | null;
    }>(
      `SELECT id, product_key, name, description FROM billing.plans WHERE key=$1 FOR UPDATE`,
      [planKey],
    );
    if (!plan.rows[0]) missing("Plan not found");
    const latest = await client.query<PlanVersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM billing.plan_versions v
         JOIN billing.plans p ON p.id=v.plan_id
        WHERE v.plan_id=$1 ORDER BY v.version DESC LIMIT 1`,
      [plan.rows[0].id],
    );
    if (!latest.rows[0]) conflict("Plan has no version to clone");
    const source = latest.rows[0];
    const amount = input?.amountMinor ?? source.amount_minor;
    const currency = input?.currency ?? source.currency;
    const taxInclusive = input?.taxInclusive ?? source.tax_inclusive;
    const taxRateBps = input?.taxRateBps ?? source.tax_rate_bps;
    const credits = input?.creditsPerPeriod ?? source.credits_per_period;
    const priceChanged =
      amount !== source.amount_minor || currency !== source.currency;
    const paystack =
      input?.paystackPlanCode !== undefined
        ? input.paystackPlanCode
        : priceChanged
          ? null
          : source.paystack_plan_code;
    validatePlanInput({
      amountMinor: amount,
      currency,
      taxRateBps,
      creditsPerPeriod: credits,
      active: false,
      paystackPlanCode: paystack,
    });
    const next = await client.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0)::int + 1 AS version FROM billing.plan_versions WHERE plan_id=$1`,
      [plan.rows[0].id],
    );
    const versionId = `plv_${randomUUID()}`;
    await client.query(
      `INSERT INTO billing.plan_versions(
         id, plan_id, version, status, interval, currency, amount_minor,
         tax_inclusive, tax_rate_bps, credits_per_period, paystack_plan_code,
         active, notes
       ) VALUES($1,$2,$3,'draft','monthly',$4,$5,$6,$7,$8,$9,false,$10)`,
      [
        versionId,
        plan.rows[0].id,
        next.rows[0]!.version,
        currency,
        amount,
        taxInclusive,
        taxRateBps,
        credits,
        paystack,
        input?.notes ?? null,
      ],
    );
    const entitlements =
      input?.entitlements ??
      (await getPlanEntitlements(client, source.id)).map((item) => ({
        key: item.key,
        value: item.value,
        metadata: item.metadata,
      }));
    await replacePlanEntitlementsTx(client, versionId, entitlements, true);
    return planSummary(
      await getPlanVersionById(client, versionId),
      await getPlanEntitlements(client, versionId),
      await loadCapabilityMap(client),
    );
  });
}

export async function updatePlanVersionDraft(
  pool: Pool,
  versionId: string,
  input: {
    amountMinor?: string;
    currency?: string;
    taxInclusive?: boolean;
    taxRateBps?: number;
    creditsPerPeriod?: string | null;
    paystackPlanCode?: string | null;
    notes?: string | null;
    effectiveFrom?: Date | null;
  },
): Promise<BillingPlanSummary> {
  return transaction(pool, async (client) => {
    const version = await getPlanVersionById(client, versionId, true);
    if (version.status !== "draft" && version.status !== "scheduled")
      conflict("Only draft or scheduled plan versions can be edited");
    const amount = input.amountMinor ?? version.amount_minor;
    const currency = input.currency ?? version.currency;
    const taxRateBps = input.taxRateBps ?? version.tax_rate_bps;
    const credits = input.creditsPerPeriod ?? version.credits_per_period;
    const paystack = input.paystackPlanCode ?? version.paystack_plan_code;
    validatePlanInput({
      amountMinor: amount,
      currency,
      taxRateBps,
      creditsPerPeriod: credits,
      active: false,
      paystackPlanCode: paystack,
    });
    await client.query(
      `UPDATE billing.plan_versions
          SET amount_minor=$2, currency=$3, tax_inclusive=$4,
              tax_rate_bps=$5, credits_per_period=$6, paystack_plan_code=$7,
              notes=$8, effective_from=COALESCE($9,effective_from), updated_at=now()
        WHERE id=$1`,
      [
        versionId,
        amount,
        currency,
        input.taxInclusive ?? version.tax_inclusive,
        taxRateBps,
        credits,
        paystack,
        input.notes ?? version.notes,
        input.effectiveFrom ?? null,
      ],
    );
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
  entitlements: Array<{ key: string; value: unknown; metadata?: Record<string, unknown> }>,
): Promise<void> {
  await transaction(pool, (client) =>
    replacePlanEntitlementsTx(client, planVersionId, entitlements),
  );
}

async function replacePlanEntitlementsTx(
  client: PoolClient,
  planVersionId: string,
  entitlements: Array<{ key: string; value: unknown; metadata?: Record<string, unknown> }>,
  allowPublished = false,
): Promise<void> {
  const version = await client.query<{ status: string }>(
    `SELECT status FROM billing.plan_versions WHERE id=$1`,
    [planVersionId],
  );
  if (!version.rows[0]) missing("Plan version not found");
  if (!allowPublished && version.rows[0].status !== "draft" && version.rows[0].status !== "scheduled")
    conflict("Only draft or scheduled plan versions can be edited");
  const capabilities = await loadCapabilityMap(client);
  const seen = new Set<string>();
  for (const item of entitlements) {
    const key = slug(item.key, "Entitlement key");
    if (seen.has(key)) conflict(`Duplicate entitlement ${key}`);
    if (!capabilities.has(key)) bad(`Unknown capability: ${key}`);
    seen.add(key);
    await client.query(
      `INSERT INTO billing.plan_entitlements(id, plan_version_id, key, value, metadata)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (plan_version_id, key) DO UPDATE SET
         value=EXCLUDED.value, metadata=EXCLUDED.metadata, updated_at=now()`,
      [
        `ple_${randomUUID()}`,
        planVersionId,
        key,
        JSON.stringify(item.value),
        JSON.stringify(item.metadata ?? {}),
      ],
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

async function validatePublishableVersion(
  client: PoolClient,
  version: PlanVersionRow,
): Promise<Map<string, CapabilityRow>> {
  validatePlanInput({
    amountMinor: version.amount_minor,
    currency: version.currency,
    taxRateBps: version.tax_rate_bps,
    creditsPerPeriod: version.credits_per_period,
    active: true,
    paystackPlanCode: version.paystack_plan_code,
  });
  if (version.paystack_plan_code) {
    const mismatch = await client.query(
      `SELECT 1 FROM billing.plan_versions
        WHERE paystack_plan_code=$1 AND id<>$2
          AND (amount_minor<>$3 OR currency<>$4 OR interval<>$5)
        LIMIT 1`,
      [
        version.paystack_plan_code,
        version.id,
        version.amount_minor,
        version.currency,
        version.interval,
      ],
    );
    if (mismatch.rowCount)
      conflict(
        "That Paystack plan code belongs to a different price, currency, or interval",
      );
  }
  const capabilities = await loadCapabilityMap(client);
  const entitlements = await getPlanEntitlements(client, version.id);
  for (const item of entitlements) {
    const capability = capabilities.get(item.key);
    const enforcement = String(item.metadata?.enforcement ?? "hard");
    if (
      (item.key.startsWith("limit.") || capability?.kind === "limit") &&
      enforcement !== "display_only" &&
      capability?.implementation_status !== "implemented"
    )
      conflict(
        `Limit ${item.key} has no implemented guard; mark it display_only or implement the guard`,
      );
  }
  return capabilities;
}

export async function publishPlanVersion(
  pool: Pool,
  versionId: string,
  actorId: string,
): Promise<BillingPlanSummary> {
  return transaction(pool, async (client) => {
    const version = await getPlanVersionById(client, versionId, true);
    if (version.status === "active")
      return planSummary(
        version,
        await getPlanEntitlements(client, versionId),
        await loadCapabilityMap(client),
      );
    if (version.status === "retired") conflict("Retired plan versions cannot be published");
    const capabilities = await validatePublishableVersion(client, version);
    await client.query(
      `UPDATE billing.plan_versions
          SET status='retired', active=false, updated_at=now()
        WHERE plan_id=$1 AND currency=$2 AND status='active' AND id<>$3`,
      [version.plan_id, version.currency, versionId],
    );
    await client.query(
      `UPDATE billing.plan_versions
          SET status='active', active=true, published_at=now(), published_by=$2,
              effective_from=LEAST(effective_from, now()), updated_at=now()
        WHERE id=$1`,
      [versionId, actorId],
    );
    await client.query(
      `UPDATE billing.plans SET status='active', updated_at=now() WHERE id=$1`,
      [version.plan_id],
    );
    return planSummary(
      await getPlanVersionById(client, versionId),
      await getPlanEntitlements(client, versionId),
      capabilities,
    );
  });
}

export async function schedulePlanVersion(
  pool: Pool,
  versionId: string,
  effectiveFrom: Date,
  actorId: string,
): Promise<BillingPlanSummary> {
  if (effectiveFrom.getTime() <= Date.now())
    bad("Scheduled plan versions require a future effective date");
  return transaction(pool, async (client) => {
    const version = await getPlanVersionById(client, versionId, true);
    if (version.status !== "draft")
      conflict("Only draft plan versions can be scheduled");
    const capabilities = await validatePublishableVersion(client, version);
    await client.query(
      `UPDATE billing.plan_versions
          SET status='scheduled', active=false, effective_from=$2,
              published_at=now(), published_by=$3, updated_at=now()
        WHERE id=$1`,
      [versionId, effectiveFrom, actorId],
    );
    return planSummary(
      await getPlanVersionById(client, versionId),
      await getPlanEntitlements(client, versionId),
      capabilities,
    );
  });
}

export async function activateDueScheduledPlanVersions(
  pool: Pool,
  limit = 100,
): Promise<number> {
  const due = await pool.query<{ id: string; plan_id: string; currency: string }>(
    `SELECT id, plan_id, currency FROM billing.plan_versions
      WHERE status='scheduled' AND effective_from<=now()
      ORDER BY effective_from LIMIT $1`,
    [Math.min(500, Math.max(1, limit))],
  );
  let activated = 0;
  for (const row of due.rows) {
    try {
      const changed = await transaction(pool, async (client) => {
        const version = await getPlanVersionById(client, row.id, true);
        if (version.status !== "scheduled" || version.effective_from > new Date())
          return false;
        await client.query(
          `UPDATE billing.plan_versions
              SET status='retired', active=false, updated_at=now()
            WHERE plan_id=$1 AND currency=$2 AND status='active' AND id<>$3`,
          [version.plan_id, version.currency, version.id],
        );
        await client.query(
          `UPDATE billing.plan_versions
              SET status='active', active=true, updated_at=now()
            WHERE id=$1`,
          [version.id],
        );
        await client.query(
          `UPDATE billing.plans SET status='active', updated_at=now() WHERE id=$1`,
          [version.plan_id],
        );
        return true;
      });
      if (changed) activated++;
    } catch {
      // A later pass retries. Scheduled activation must never take down the
      // worker loop.
    }
  }
  return activated;
}

export async function retirePlanVersion(
  pool: Pool,
  versionId: string,
): Promise<{ retired: true }> {
  return transaction(pool, async (client) => {
    const version = await getPlanVersionById(client, versionId, true);
    if (version.status === "retired") return { retired: true };
    await client.query(
      `UPDATE billing.plan_versions SET status='retired', active=false, updated_at=now() WHERE id=$1`,
      [versionId],
    );
    return { retired: true };
  });
}

export async function clonePlan(
  pool: Pool,
  planKey: string,
  input: { key: string; name: string },
): Promise<BillingPlanSummary> {
  return transaction(pool, async (client) => {
    const source = await client.query<{
      id: string;
      product_key: BillingProduct;
      name: string;
      description: string | null;
    }>(
      `SELECT id, product_key, name, description FROM billing.plans WHERE key=$1`,
      [planKey],
    );
    if (!source.rows[0]) missing("Plan not found");
    const latest = await client.query<PlanVersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM billing.plan_versions v
         JOIN billing.plans p ON p.id=v.plan_id
        WHERE v.plan_id=$1 ORDER BY v.version DESC LIMIT 1`,
      [source.rows[0].id],
    );
    if (!latest.rows[0]) conflict("Plan has no version to clone");
    const version = latest.rows[0];
    const key = slug(input.key, "Plan key");
    const existing = await client.query(`SELECT 1 FROM billing.plans WHERE key=$1`, [key]);
    if (existing.rowCount) conflict("Plan key is already in use");
    const planId = `pln_${randomUUID()}`;
    await client.query(
      `INSERT INTO billing.plans(id, product_key, key, name, description, status)
       VALUES($1,$2,$3,$4,$5,'draft')`,
      [
        planId,
        source.rows[0].product_key,
        key,
        text(input.name, "Plan name", 120),
        source.rows[0].description,
      ],
    );
    const versionId = `plv_${randomUUID()}`;
    await client.query(
      `INSERT INTO billing.plan_versions(
         id, plan_id, version, status, interval, currency, amount_minor,
         tax_inclusive, tax_rate_bps, credits_per_period, paystack_plan_code,
         active, notes
       ) VALUES($1,$2,1,'draft','monthly',$3,$4,$5,$6,$7,$8,false,$9)`,
      [
        versionId,
        planId,
        version.currency,
        version.amount_minor,
        version.tax_inclusive,
        version.tax_rate_bps,
        version.credits_per_period,
        version.paystack_plan_code,
        version.notes,
      ],
    );
    await replacePlanEntitlementsTx(
      client,
      versionId,
      (await getPlanEntitlements(client, version.id)).map((item) => ({
        key: item.key,
        value: item.value,
        metadata: item.metadata,
      })),
      true,
    );
    return planSummary(
      await getPlanVersionById(client, versionId),
      await getPlanEntitlements(client, versionId),
      await loadCapabilityMap(client),
    );
  });
}

export async function adminCatalog(pool: Pool): Promise<unknown> {
  const products = await pool.query(
    `SELECT key, name, description, active FROM billing.catalog_products ORDER BY name`,
  );
  const capabilities = await pool.query<CapabilityRow>(
    `SELECT key, product, name, description, kind, unit, value_type,
            display_group, display_order, visible_to_customer,
            implementation_status, credit_cost_per_unit::text,
            credit_cost_minimum::text, active
       FROM billing.capabilities ORDER BY product, display_group NULLS FIRST, display_order, key`,
  );
  const versions = await pool.query<PlanVersionRow>(
    `SELECT ${VERSION_COLUMNS}
       FROM billing.plan_versions v
       JOIN billing.plans p ON p.id=v.plan_id
      ORDER BY p.product_key, p.name, v.version DESC`,
  );
  const entitlements = await pool.query<{
    version_id: string;
    key: string;
    value: unknown;
    metadata: Record<string, unknown>;
  }>(
    `SELECT plan_version_id AS version_id, key, value, metadata FROM billing.plan_entitlements ORDER BY plan_version_id, key`,
  );
  const capabilityMap = new Map(capabilities.rows.map((row) => [row.key, row]));
  const summaries = new Map<string, BillingPlanSummary>();
  for (const version of versions.rows)
    if (!summaries.has(version.plan_key))
      summaries.set(
        version.plan_key,
        planSummary(
          version,
          entitlements.rows
            .filter((item) => item.version_id === version.id)
            .map((item) => ({
              key: item.key,
              value: item.value,
              metadata: item.metadata,
            })),
          capabilityMap,
        ),
      );
  return {
    products: products.rows,
    capabilities: capabilities.rows.map((row) => ({
      key: row.key,
      product: row.product,
      name: row.name,
      description: row.description,
      kind: row.kind,
      unit: row.unit,
      valueType: row.value_type,
      displayGroup: row.display_group,
      displayOrder: row.display_order,
      visibleToCustomer: row.visible_to_customer,
      implementationStatus: row.implementation_status,
      creditCostPerUnit: row.credit_cost_per_unit,
      creditCostMinimum: row.credit_cost_minimum,
      active: row.active,
    })),
    plans: [...summaries.values()],
    entitlements: entitlements.rows.map((row) => ({
      key: row.key,
      value: row.value,
      metadata: row.metadata,
      planVersionId: row.version_id,
    })),
    versions: versions.rows.map((row) => ({
      ...planSummary(
        row,
        entitlements.rows
          .filter((item) => item.version_id === row.id)
          .map((item) => ({
            key: item.key,
            value: item.value,
            metadata: item.metadata,
          })),
        capabilityMap,
      ),
      planKey: row.plan_key,
      paystackPlanCode: row.paystack_plan_code,
    })),
    accessDefinitions: capabilities.rows.map((row) => ({
      key: row.key,
      name: row.name,
      kind: row.kind === "meter" ? "meter" : "capability",
    })),
  };
}

export async function adminPlanDetail(
  pool: Pool,
  planKey: string,
): Promise<unknown> {
  const plan = await pool.query<{
    id: string;
    key: string;
    product_key: BillingProduct;
    name: string;
    description: string | null;
    status: string;
  }>(
    `SELECT id, key, product_key, name, description, status
       FROM billing.plans WHERE key=$1`,
    [planKey],
  );
  if (!plan.rows[0]) missing("Plan not found");
  const versions = await pool.query<PlanVersionRow>(
    `SELECT ${VERSION_COLUMNS}
       FROM billing.plan_versions v
       JOIN billing.plans p ON p.id=v.plan_id
      WHERE p.key=$1 ORDER BY v.version DESC`,
    [planKey],
  );
  const capabilities = await loadCapabilityMap(pool);
  const counts = await pool.query<{ plan_version_id: string; count: string }>(
    `SELECT plan_version_id, count(*)::text AS count
       FROM billing.subscriptions
      WHERE plan_version_id = ANY($1::text[])
      GROUP BY plan_version_id`,
    [versions.rows.map((version) => version.id)],
  );
  const countMap = new Map(counts.rows.map((row) => [row.plan_version_id, row.count]));
  const entitlements = new Map<string, PlanEntitlementRow[]>();
  for (const version of versions.rows)
    entitlements.set(version.id, await getPlanEntitlements(pool, version.id));
  return {
    plan: plan.rows[0],
    versions: versions.rows.map((version) => ({
      ...planSummary(version, entitlements.get(version.id) ?? [], capabilities),
      planKey: version.plan_key,
      paystackPlanCode: version.paystack_plan_code,
      activeSubscriptions: Number(countMap.get(version.id) ?? "0"),
    })),
  };
}

export function parsePlanEntitlements(
  value: unknown,
): Array<{ key: string; value: unknown; metadata: Record<string, unknown> }> {
  return arrayValue(value, "Entitlements").map((item) => {
    const row = objectValue(item, "Entitlement");
    return {
      key: text(row.key, "Entitlement key", 120),
      value: row.value,
      metadata:
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {},
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

export function parseValueType(value: unknown): "boolean" | "integer" | "decimal" | "string" {
  if (value === "boolean" || value === "integer" || value === "decimal" || value === "string")
    return value;
  bad("Value type must be boolean, integer, decimal, or string");
}

export function parseImplementationStatus(
  value: unknown,
): "implemented" | "product_pending" | "display_only" {
  if (
    value === "implemented" ||
    value === "product_pending" ||
    value === "display_only"
  )
    return value;
  bad("Implementation status must be implemented, product_pending, or display_only");
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
