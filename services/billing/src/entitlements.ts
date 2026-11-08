import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type {
  BillingAccessState,
  BillingEntitlementSnapshot,
  BillingProduct,
  BillingSubscriptionSummary,
  BillingUsageEventInput,
  BillingUsageEventResult,
} from "@kasitek-labs/contracts";
import type { BillingConfig } from "./config.js";
import { getAccountById, getAccountForTenant, bumpEntitlementRevision } from "./accounts.js";
import { getPlanEntitlements, getPlanVersionById } from "./catalog.js";
import { creditCost, debitCreditsTx, getCreditSummary } from "./credits.js";
import { transaction } from "./db.js";
import { currentSubscription } from "./subscriptions.js";
import { listInvoices } from "./invoices.js";
import {
  bad,
  bigValue,
  dateValue,
  iso,
  jsonObject,
  optionalText,
  text,
  wire,
} from "./util.js";
import { billingSnapshotToken } from "@kasitek-labs/server-support/billing-authority";

function mergeValue(existing: unknown, next: unknown): unknown {
  if (typeof existing === "boolean" && typeof next === "boolean")
    return existing || next;
  if (
    typeof existing === "number" &&
    typeof next === "number" &&
    Number.isFinite(existing) &&
    Number.isFinite(next)
  )
    return Math.max(existing, next);
  if (typeof existing === "string" && typeof next === "string")
    return existing.length >= next.length ? existing : next;
  return next;
}

export async function resolveEntitlementSnapshot(
  pool: Pool,
  accountId: string,
  product: BillingProduct,
  tenantId: string,
  config: BillingConfig,
): Promise<BillingEntitlementSnapshot> {
  const account = await getAccountById(pool, accountId);
  const subscription = await currentSubscription(pool, accountId, product);
  const plan = subscription
    ? await getPlanVersionById(pool, subscription.plan_version_id)
    : null;
  const values = new Map<string, unknown>();
  if (plan)
    for (const item of await getPlanEntitlements(pool, plan.id))
      values.set(item.key, mergeValue(values.get(item.key), item.value));
  const grants = await pool.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM billing.account_grants
      WHERE billing_account_id=$1 AND starts_at<=now()
        AND (ends_at IS NULL OR ends_at>now())`,
    [accountId],
  );
  for (const item of grants.rows)
    values.set(item.key, mergeValue(values.get(item.key), item.value));

  const access = accessState(subscription, account.status);
  const features: Record<string, boolean> = {};
  const limits: Record<string, string | number | null> = {};
  for (const [key, value] of values) {
    if (typeof value === "boolean") features[key] = value;
    else if (typeof value === "number" || typeof value === "string")
      limits[key] = value;
  }
  const capabilities = await pool.query<{ key: string; kind: string }>(
    `SELECT key, kind FROM billing.capabilities
      WHERE product=$1 AND active=true AND key = ANY($2::text[])`,
    [product, [...values.keys()]],
  );
  for (const capability of capabilities.rows) {
    if (capability.kind === "feature" && !(capability.key in features))
      features[capability.key] = false;
    if (capability.kind !== "feature" && !(capability.key in limits))
      limits[capability.key] = null;
  }
  const meterUsage = await pool.query<{
    meter_key: string;
    used: string;
  }>(
    `SELECT meter_key, COALESCE(SUM(quantity),0)::text AS used
       FROM billing.usage_events
      WHERE billing_account_id=$1 AND product=$2
        AND occurred_at>=date_trunc('month', now())
      GROUP BY meter_key`,
    [accountId, product],
  );
  const meters: Record<string, { used: string; limit: string | null }> = {};
  for (const capability of capabilities.rows) {
    if (capability.kind !== "meter") continue;
    const limit = limits[`limit.${capability.key}`];
    meters[capability.key] = {
      used: meterUsage.rows.find((row) => row.meter_key === capability.key)?.used ?? "0",
      limit: limit == null ? null : String(limit),
    };
  }
  const credits = await getCreditSummary(pool, accountId);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + config.snapshotTtlSeconds * 1000);
  return {
    version: 1,
    accountId,
    product,
    tenantId,
    revision: account.entitlements_revision,
    access,
    plan: plan
      ? { key: plan.plan_key, name: plan.plan_name, version: plan.version }
      : null,
    subscription: subscription ? subscriptionSummary(subscription, plan) : null,
    features,
    limits,
    meters,
    credits,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

function accessState(
  subscription: Awaited<ReturnType<typeof currentSubscription>>,
  accountStatus: string,
): BillingAccessState {
  if (accountStatus !== "active") return "none";
  if (!subscription) return "none";
  const now = Date.now();
  if (subscription.status === "active") return "active";
  if (subscription.status === "trialing")
    return subscription.trial_ends_at && subscription.trial_ends_at.getTime() > now
      ? "trialing"
      : "none";
  if (subscription.status === "past_due" || subscription.status === "grace") {
    if (subscription.grace_ends_at && subscription.grace_ends_at.getTime() > now)
      return "grace";
    return subscription.status === "grace" ? "none" : "read_only";
  }
  return "none";
}

function subscriptionSummary(
  subscription: NonNullable<Awaited<ReturnType<typeof currentSubscription>>>,
  plan: Awaited<ReturnType<typeof getPlanVersionById>> | null,
): BillingSubscriptionSummary {
  return {
    id: subscription.id,
    product: subscription.product_key,
    planKey: plan?.plan_key ?? "",
    planName: plan?.plan_name ?? "",
    planVersion: plan?.version ?? 0,
    status: subscription.status,
    currentPeriodStart: iso(subscription.current_period_start),
    currentPeriodEnd: iso(subscription.current_period_end),
    trialEndsAt: iso(subscription.trial_ends_at),
    graceEndsAt: iso(subscription.grace_ends_at),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    provider: subscription.provider,
  };
}

export async function signedEntitlementSnapshot(
  pool: Pool,
  product: BillingProduct,
  tenantId: string,
  config: BillingConfig,
): Promise<{ snapshot: BillingEntitlementSnapshot; token: string }> {
  const { account } = await getAccountForTenant(pool, product, tenantId);
  const snapshot = await resolveEntitlementSnapshot(
    pool,
    account.id,
    product,
    tenantId,
    config,
  );
  return {
    snapshot,
    token: billingSnapshotToken(snapshot, config.snapshotSecret),
  };
}

export async function recordUsage(
  pool: Pool,
  product: BillingProduct,
  tenantId: string,
  input: BillingUsageEventInput,
): Promise<BillingUsageEventResult> {
  const { account } = await getAccountForTenant(pool, product, tenantId);
  const meterKey = text(input.meterKey, "Meter key", 120);
  const idempotencyKey = text(input.idempotencyKey, "Usage idempotency key", 240);
  const quantity = bigValue(input.quantity, "Usage quantity", 0n, 9_007_199_254_740_991n);
  const occurredAt = input.occurredAt ? dateValue(input.occurredAt, "Occurred at") : new Date();
  const capability = await pool.query<{
    credit_cost_per_unit: string | null;
    credit_cost_minimum: string;
  }>(
    `SELECT credit_cost_per_unit::text, credit_cost_minimum::text
       FROM billing.capabilities WHERE product=$1 AND key=$2 AND active=true`,
    [product, meterKey],
  );

  return transaction(pool, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO billing.usage_events(
         id, billing_account_id, product, tenant_id, meter_key, quantity,
         occurred_at, source_type, source_id, idempotency_key,
         provider_cost_minor, currency, metadata
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        `use_${randomUUID()}`,
        account.id,
        product,
        tenantId,
        meterKey,
        quantity.toString(),
        occurredAt,
        optionalText(input.sourceType, 120),
        optionalText(input.sourceId, 200),
        idempotencyKey,
        input.providerCostMinor == null
          ? null
          : bigValue(input.providerCostMinor, "Provider cost", 0n).toString(),
        optionalText(input.currency, 3)?.toUpperCase() ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    if (!inserted.rows[0]) {
      const existing = await client.query<{
        credits_charged: string;
      }>(
        `SELECT credits_charged::text FROM billing.usage_events WHERE idempotency_key=$1`,
        [idempotencyKey],
      );
      const credits = await getCreditSummary(client, account.id);
      return {
        accepted: true,
        duplicate: true,
        creditsCharged: existing.rows[0]?.credits_charged ?? "0",
        balance: credits.balance,
        shortfall: "0",
      };
    }
    let charged = 0n;
    let shortfall = 0n;
    let ledgerId: string | null = null;
    if (capability.rows[0]) {
      const cost = creditCost(
        quantity.toString(),
        capability.rows[0].credit_cost_per_unit,
        capability.rows[0].credit_cost_minimum,
      );
      if (cost > 0n) {
        const debit = await debitCreditsTx(client, {
          billingAccountId: account.id,
          product,
          amount: cost,
          reference: `usage:${idempotencyKey}`,
          idempotencyKey: `usage:${idempotencyKey}`,
          metadata: { meterKey, quantity: quantity.toString(), sourceId: input.sourceId ?? null },
        });
        charged = debit.charged;
        shortfall = debit.shortfall;
        ledgerId = debit.ledgerId;
        if (charged > 0n)
          await client.query(
            `UPDATE billing.usage_events
                SET credits_charged=$2, credit_ledger_id=$3
              WHERE id=$1`,
            [inserted.rows[0].id, charged.toString(), ledgerId],
          );
        if (charged > 0n) await bumpEntitlementRevision(client, account.id);
      }
    }
    const credits = await getCreditSummary(client, account.id);
    return {
      accepted: true,
      duplicate: false,
      creditsCharged: wire(charged),
      balance: credits.balance,
      shortfall: wire(shortfall),
    };
  });
}

export async function usageSummary(
  pool: Pool,
  accountId: string,
  product: BillingProduct,
  range?: { from?: Date; to?: Date },
): Promise<{
  from: string;
  to: string;
  meters: Array<{ meterKey: string; quantity: string; creditsCharged: string }>;
  daily: Array<{ date: string; creditsUsed: string; operations: string }>;
  previousDaily: Array<{ date: string; creditsUsed: string; operations: string }>;
  breakdown: Array<{ meterKey: string; creditsUsed: string; operations: string }>;
  creditsUsed: string;
  operations: string;
  credits: Awaited<ReturnType<typeof getCreditSummary>>;
  grants: Array<Record<string, unknown>>;
  recent: Array<Record<string, unknown>>;
}> {
  const to = range?.to ?? new Date();
  const from =
    range?.from ??
    new Date(to.getTime() - 30 * 86_400_000);
  if (from > to) bad("Usage range start must be before its end");
  const duration = to.getTime() - from.getTime();
  const previousTo = new Date(from.getTime());
  const previousFrom = new Date(from.getTime() - duration);
  const dailyQuery = async (start: Date, end: Date) =>
    pool.query<{ date: string; credits_used: string; operations: string }>(
      `SELECT to_char(date_trunc('day', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
              COALESCE(SUM(credits_charged),0)::text AS credits_used,
              count(*)::text AS operations
         FROM billing.usage_events
        WHERE billing_account_id=$1 AND product=$2
          AND occurred_at >= $3 AND occurred_at <= $4
        GROUP BY 1 ORDER BY 1`,
      [accountId, product, start, end],
    );
  const [daily, previousDaily, meters, breakdown, recent, grants] =
    await Promise.all([
      dailyQuery(from, to),
      dailyQuery(previousFrom, previousTo),
      pool.query<{
        meter_key: string;
        quantity: string;
        credits_charged: string;
      }>(
        `SELECT meter_key, SUM(quantity)::text AS quantity,
                SUM(credits_charged)::text AS credits_charged
           FROM billing.usage_events
          WHERE billing_account_id=$1 AND product=$2
            AND occurred_at >= date_trunc('month', now())
          GROUP BY meter_key ORDER BY meter_key`,
        [accountId, product],
      ),
      pool.query<{
        meter_key: string;
        credits_used: string;
        operations: string;
      }>(
        `SELECT meter_key, COALESCE(SUM(credits_charged),0)::text AS credits_used,
                count(*)::text AS operations
           FROM billing.usage_events
          WHERE billing_account_id=$1 AND product=$2
            AND occurred_at >= $3 AND occurred_at <= $4
          GROUP BY meter_key ORDER BY meter_key`,
        [accountId, product, from, to],
      ),
      pool.query(
        `SELECT id, meter_key, quantity::text, credits_charged::text,
                occurred_at, source_type, source_id
           FROM billing.usage_events
          WHERE billing_account_id=$1 AND product=$2
            AND occurred_at >= $3 AND occurred_at <= $4
          ORDER BY occurred_at DESC LIMIT 50`,
        [accountId, product, from, to],
      ),
      pool.query(
        `SELECT g.id, g.source, g.amount::text, g.remaining::text,
                g.starts_at, g.ends_at, g.reference
           FROM billing.credit_grants g
           JOIN billing.credit_accounts c ON c.id=g.account_id
          WHERE c.billing_account_id=$1 AND g.product_key=$2
          ORDER BY g.created_at DESC LIMIT 100`,
        [accountId, product],
      ),
    ]);
  const creditsUsed = daily.rows.reduce(
    (total, row) => total + BigInt(row.credits_used),
    0n,
  );
  const operations = daily.rows.reduce(
    (total, row) => total + BigInt(row.operations),
    0n,
  );
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    meters: meters.rows.map((row) => ({
      meterKey: row.meter_key,
      quantity: row.quantity,
      creditsCharged: row.credits_charged,
    })),
    daily: daily.rows.map((row) => ({
      date: row.date,
      creditsUsed: row.credits_used,
      operations: row.operations,
    })),
    previousDaily: previousDaily.rows.map((row) => ({
      date: row.date,
      creditsUsed: row.credits_used,
      operations: row.operations,
    })),
    breakdown: breakdown.rows.map((row) => ({
      meterKey: row.meter_key,
      creditsUsed: row.credits_used,
      operations: row.operations,
    })),
    creditsUsed: creditsUsed.toString(),
    operations: operations.toString(),
    credits: await getCreditSummary(pool, accountId),
    grants: grants.rows.map((row) => ({
      id: row.id,
      source: row.source,
      amount: row.amount,
      remainingAmount: row.remaining,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      reference: row.reference,
    })),
    recent: recent.rows.map((row) => ({
      id: row.id,
      meterKey: row.meter_key,
      quantity: row.quantity,
      creditsCharged: row.credits_charged,
      occurredAt: row.occurred_at,
      sourceType: row.source_type,
      sourceId: row.source_id,
    })),
  };
}

export async function accountSummary(
  pool: Pool,
  accountId: string,
): Promise<Record<string, unknown>> {
  const account = await getAccountById(pool, accountId);
  const links = await pool.query(
    `SELECT product, tenant_id, role, status FROM billing.account_links
      WHERE billing_account_id=$1 ORDER BY product, tenant_id`,
    [accountId],
  );
  const subscriptions = await pool.query(
    `SELECT s.id, s.product_key, p.key AS plan_key, p.name AS plan_name,
            v.version, s.status, s.current_period_start, s.current_period_end,
            s.trial_ends_at, s.grace_ends_at, s.cancel_at_period_end, s.provider
       FROM billing.subscriptions s
       JOIN billing.plan_versions v ON v.id=s.plan_version_id
       JOIN billing.plans p ON p.id=v.plan_id
      WHERE s.billing_account_id=$1 ORDER BY s.created_at DESC`,
    [accountId],
  );
  const issues = await pool.query(
    `SELECT id, provider, resource_type, resource_id, issue_type, status,
            details, created_at, updated_at
       FROM billing.reconciliation_issues
      WHERE billing_account_id=$1 AND status='open'
      ORDER BY created_at DESC LIMIT 50`,
    [accountId],
  );
  return {
    account: {
      ...account,
      entitlements_revision: account.entitlements_revision,
    },
    links: links.rows.map((row) => ({
      product: row.product,
      tenantId: row.tenant_id,
      role: row.role,
      status: row.status,
    })),
    subscriptions: subscriptions.rows.map((row) => ({
      id: row.id,
      product: row.product_key,
      planKey: row.plan_key,
      planName: row.plan_name,
      planVersion: row.version,
      status: row.status,
      currentPeriodStart: row.current_period_start,
      currentPeriodEnd: row.current_period_end,
      trialEndsAt: row.trial_ends_at,
      graceEndsAt: row.grace_ends_at,
      cancelAtPeriodEnd: row.cancel_at_period_end,
      provider: row.provider,
    })),
    invoices: await listInvoices(pool, accountId),
    issues: issues.rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      issueType: row.issue_type,
      status: row.status,
      details: row.details,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    credits: await getCreditSummary(pool, accountId),
  };
}

export function parseTenantQuery(
  value: unknown,
): { product: BillingProduct; tenantId: string } {
  const query = jsonObject(value);
  const product = query.product;
  if (product !== "growth" && product !== "agents" && product !== "agency")
    bad("Product must be growth, agents, or agency");
  return { product, tenantId: text(query.tenantId, "Tenant id", 256) };
}
