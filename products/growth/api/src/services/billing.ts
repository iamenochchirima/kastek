import type { Pool } from "pg";
import { createId } from "@paralleldrive/cuid2";
import type {
  BillingEntitlementSnapshot,
  BillingInvoiceSummary,
} from "@kasitek-labs/contracts";
import { ApiError } from "../error.js";
import {
  billingServiceConfig,
  getBillingSnapshot,
  invalidateBillingSnapshot,
  recordServiceUsage,
  serviceAccount,
  serviceInvoices,
  type BillingServiceConfig,
} from "./billing-service.js";

export const CAPABILITIES = [
  { key: "feature.agents.manage", name: "AI agents", description: "Create, configure, and deploy workspace agents." },
  { key: "feature.campaigns.manage", name: "Campaigns", description: "Create and manage customer messaging campaigns." },
  { key: "feature.campaigns.send", name: "Campaign sending", description: "Launch campaigns and send messages to campaign recipients." },
  { key: "feature.bookings.access", name: "Bookings", description: "Manage workspace booking services and appointments." },
  { key: "feature.templates.manage", name: "Message templates", description: "Create and manage reusable provider message templates." },
  { key: "feature.contacts.access", name: "Contacts", description: "Access and manage workspace customer records." },
  { key: "feature.content.manage", name: "Content workspace", description: "Plan, create, schedule, and manage multi-platform content." },
  { key: "feature.content.publish", name: "Content publishing", description: "Publish approved content to connected social accounts." },
  { key: "feature.analytics.view", name: "Analytics", description: "View workspace, campaign, and connected-channel analytics." },
  { key: "feature.inbox.access", name: "Shared inbox", description: "Access connected customer conversations in one inbox." },
] as const;
export const METERS = [
  { key: "growth_agent_tokens", name: "AI tokens", description: "Accounted model tokens during the current month." },
  { key: "agent_deployments", name: "Agent deployments", description: "Agent deployment operations during the current month." },
  { key: "campaign_recipients", name: "Campaign recipients", description: "Recipients processed by campaigns during the current month." },
  { key: "social_publishes", name: "Published content", description: "Social publishing operations during the current month." },
  { key: "public_api_requests", name: "Public API requests", description: "Authenticated public API requests during the current month." },
] as const;
const WRITE_CAPABILITIES = new Set([
  "feature.agents.manage",
  "feature.campaigns.manage",
  "feature.campaigns.send",
  "feature.templates.manage",
  "feature.bookings.access",
  "feature.content.manage",
  "feature.content.publish",
]);

function serviceConfig(): BillingServiceConfig {
  const config = billingServiceConfig(process.env);
  if (!config)
    throw new ApiError(
      503,
      "service_unavailable",
      "Central billing is not configured",
    );
  return config;
}

export function billingEnforcementEnabled(): boolean {
  return billingServiceConfig(process.env) !== null;
}

export async function requireCapability(
  pool: Pool,
  orgId: string,
  key: string,
): Promise<void> {
  const definition = CAPABILITIES.find((item) => item.key === key);
  if (!definition) throw new ApiError(500, "internal_error", `Unknown capability: ${key}`);
  const snapshot = await getBillingSnapshot(pool, serviceConfig(), orgId);
  if (snapshot.access === "none")
    throw new ApiError(
      403,
      "forbidden",
      `${definition.name} requires an active billing plan`,
    );
  if (
    (snapshot.access === "grace" || snapshot.access === "read_only") &&
    WRITE_CAPABILITIES.has(definition.key)
  )
    throw new ApiError(
      403,
      "forbidden",
      `${definition.name} is read-only while billing is past due`,
    );
  if (snapshot.features[definition.key] !== true)
    throw new ApiError(
      403,
      "forbidden",
      `${definition.name} is not included in this workspace's current plan`,
    );
}

export async function meterLimit(
  pool: Pool,
  orgId: string,
  key: string,
): Promise<bigint | null> {
  const snapshot = await getBillingSnapshot(pool, serviceConfig(), orgId);
  const limit = snapshot.meters[key]?.limit;
  return limit == null ? null : BigInt(limit);
}


export async function resourceLimit(
  pool: Pool,
  orgId: string,
  key: string,
): Promise<number | null> {
  const snapshot = await getBillingSnapshot(pool, serviceConfig(), orgId);
  const value = snapshot.limits[key];
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function requireResourceLimit(
  pool: Pool,
  orgId: string,
  key: string,
  current: number,
  increment = 1,
): Promise<void> {
  const limit = await resourceLimit(pool, orgId, key);
  if (limit != null && current + increment > limit)
    throw new ApiError(
      403,
      "forbidden",
      `This workspace has reached its ${key.replace("limit.", "").replaceAll("_", " ")} limit`,
    );
}

export async function requireMeterAvailable(
  pool: Pool,
  orgId: string,
  key: string,
  quantity: number | bigint | string,
): Promise<void> {
  const snapshot = await getBillingSnapshot(pool, serviceConfig(), orgId);
  const meter = snapshot.meters[key];
  if (
    meter?.limit != null &&
    BigInt(meter.used) + BigInt(quantity) > BigInt(meter.limit)
  )
    throw new ApiError(
      403,
      "forbidden",
      `The ${key} monthly limit for this workspace has been reached`,
    );
}

export async function recordMeterUsage(
  pool: Pool,
  orgId: string,
  key: string,
  quantity: number,
  sourceType: string,
  sourceId: string,
  idempotencyKey: string,
  metadata?: Record<string, unknown>,
): Promise<boolean> {
  const inserted = await pool.query(
    `INSERT INTO "BillingUsageOutbox"(
       id, "orgId", "meterKey", quantity, "sourceType", "sourceId",
       "idempotencyKey", metadata
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT ("idempotencyKey") DO NOTHING`,
    [
      createId(),
      orgId,
      key,
      quantity,
      sourceType,
      sourceId,
      idempotencyKey,
      JSON.stringify(metadata ?? {}),
    ],
  );
  if (inserted.rowCount) {
    const row = await pool.query<UsageOutboxRow>(
      `SELECT id, "orgId", "meterKey", quantity, "sourceType", "sourceId",
              "idempotencyKey", attempts, metadata
         FROM "BillingUsageOutbox"
        WHERE "idempotencyKey"=$1 AND "deliveredAt" IS NULL`,
      [idempotencyKey],
    );
    if (row.rows[0]) await forwardUsageRow(pool, serviceConfig(), row.rows[0]);
  }
  return (inserted.rowCount ?? 0) === 1;
}

export interface UsageOutboxRow {
  id: string;
  orgId: string;
  meterKey: string;
  quantity: number;
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
  attempts: number;
  metadata: Record<string, unknown>;
}

export async function forwardUsageRow(
  pool: Pool,
  config: BillingServiceConfig,
  row: UsageOutboxRow,
): Promise<void> {
  try {
    await recordServiceUsage(config, {
      orgId: row.orgId,
      meterKey: row.meterKey,
      quantity: row.quantity,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      idempotencyKey: row.idempotencyKey,
      metadata: row.metadata,
    });
    await pool.query(
      `UPDATE "BillingUsageOutbox"
          SET "deliveredAt"=NOW(), "lastError"=NULL, "attempts"="attempts"+1, "updatedAt"=NOW()
        WHERE id=$1`,
      [row.id],
    );
    invalidateBillingSnapshot(row.orgId);
  } catch (error) {
    const attempts = row.attempts + 1;
    const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
    await pool.query(
      `UPDATE "BillingUsageOutbox"
          SET "attempts"=$2, "nextAttemptAt"=NOW()+make_interval(secs=>$3),
              "lastError"=$4, "updatedAt"=NOW()
        WHERE id=$1`,
      [
        row.id,
        attempts,
        delaySeconds,
        error instanceof Error ? error.message.slice(0, 500) : "usage forward failed",
      ],
    );
  }
}

export async function forwardPendingUsage(
  pool: Pool,
  config: BillingServiceConfig,
  limit = 100,
): Promise<number> {
  const rows = await pool.query<UsageOutboxRow>(
    `SELECT id, "orgId", "meterKey", quantity, "sourceType", "sourceId",
            "idempotencyKey", attempts, metadata
       FROM "BillingUsageOutbox"
      WHERE "deliveredAt" IS NULL AND "nextAttemptAt" <= NOW()
      ORDER BY "createdAt" LIMIT $1`,
    [Math.min(500, Math.max(1, limit))],
  );
  let forwarded = 0;
  for (const row of rows.rows) {
    await forwardUsageRow(pool, config, row);
    forwarded++;
  }
  return forwarded;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function invoicePlanName(invoice: BillingInvoiceSummary): string {
  return invoice.lines[0]?.description ?? "KasiTek Growth";
}

export async function getBillingSummary(
  pool: Pool,
  orgId: string,
): Promise<Record<string, unknown>> {
  const config = serviceConfig();
  const [snapshot, invoices, account] = await Promise.all([
    getBillingSnapshot(pool, config, orgId),
    serviceInvoices(config, orgId),
    serviceAccount(config, orgId),
  ]);
  const features = CAPABILITIES.map((definition) => ({
    key: definition.key,
    name: definition.name,
    description: definition.description,
    enabled: snapshot.features[definition.key] === true,
  }));
  const meters = METERS.map((definition) => ({
    key: definition.key,
    name: definition.name,
    description: definition.description,
    used: numberValue(snapshot.meters[definition.key]?.used),
    limit:
      snapshot.meters[definition.key]?.limit == null
        ? null
        : numberValue(snapshot.meters[definition.key]!.limit),
  }));
  const usage: Record<string, number> = {};
  for (const [key, value] of Object.entries(snapshot.meters))
    usage[key] = numberValue(value.used);
  const limits: Record<string, number> = {};
  for (const [key, value] of Object.entries(snapshot.limits)) {
    if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)))
      limits[key] = numberValue(value);
  }
  const productDefinitions: Record<
    string,
    { name: string; description: string }
  > = {
    growth: {
      name: "KasiTek Growth",
      description:
        "Customer conversations, campaigns, content, bookings, and workspace agents.",
    },
    agents: {
      name: "KasiTek Agents",
      description: "Standalone customer-service agents and channels.",
    },
    agency: {
      name: "KasiTek Agency",
      description: "Partner workspaces, client agents, and reporting.",
    },
  };
  const accountSubscriptions = Array.isArray(account.subscriptions)
    ? (account.subscriptions as Array<Record<string, unknown>>).filter((item) =>
        ["trialing", "active", "past_due", "grace"].includes(
          String(item.status ?? ""),
        ),
      )
    : [];
  const products = accountSubscriptions.length
    ? accountSubscriptions.map((item) => {
        const key = String(item.product ?? "growth");
        const definition = productDefinitions[key] ?? {
          name: key,
          description: null,
        };
        const isGrowth = key === "growth";
        return {
          key,
          name: definition.name,
          description: definition.description,
          hasAccess: isGrowth
            ? snapshot.access !== "none"
            : ["trialing", "active", "past_due", "grace"].includes(
                String(item.status ?? ""),
              ),
          state:
            isGrowth && snapshot.access === "none"
              ? "upgrade_required"
              : "enabled",
          planName: String(item.planName ?? ""),
          subscriptionStatus: item.status ? String(item.status) : null,
          subscriptionId: String(item.id),
          currentPeriodStart: item.currentPeriodStart ?? null,
          currentPeriodEnd: item.currentPeriodEnd ?? null,
          trialEndsAt: item.trialEndsAt ?? null,
          cancelAtPeriodEnd: item.cancelAtPeriodEnd === true,
          usage: isGrowth ? usage : {},
          limits: isGrowth ? limits : {},
        };
      })
    : [
        {
          key: "growth",
          name: productDefinitions.growth!.name,
          description: productDefinitions.growth!.description,
          hasAccess: snapshot.access !== "none",
          state: snapshot.access === "none" ? "upgrade_required" : "enabled",
          planName: snapshot.plan?.name ?? null,
          subscriptionStatus: snapshot.subscription?.status ?? null,
          subscriptionId: snapshot.subscription?.id ?? null,
          currentPeriodStart: snapshot.subscription?.currentPeriodStart ?? null,
          currentPeriodEnd: snapshot.subscription?.currentPeriodEnd ?? null,
          trialEndsAt: snapshot.subscription?.trialEndsAt ?? null,
          cancelAtPeriodEnd: snapshot.subscription?.cancelAtPeriodEnd ?? false,
          usage,
          limits,
        },
      ];
  const invoiceItems = invoices.map((invoice) => {
    const product = invoice.lines[0]?.product ?? "growth";
    return {
      invoiceNumber: invoice.invoiceNumber,
      productName: productDefinitions[product]?.name ?? product,
      planName: invoicePlanName(invoice),
      status: invoice.status,
      currency: invoice.currency,
      amountMinor: numberValue(invoice.totalMinor),
      issuedAt: invoice.issuedAt,
      paidAt: invoice.paidAt,
    };
  });
  const payments = invoiceItems
    .filter((invoice) => invoice.status === "paid")
    .map((invoice) => ({
      reference: invoice.invoiceNumber,
      productName: invoice.productName,
      planName: invoice.planName,
      status: invoice.status,
      currency: invoice.currency,
      amountMinor: invoice.amountMinor,
      completedAt: invoice.paidAt,
      createdAt: invoice.issuedAt,
    }));
  return {
    orgId,
    accountId: snapshot.accountId,
    features,
    meters,
    products,
    manualGrants: [],
    payments,
    invoices: invoiceItems,
  };
}

export function mergeEntitlementValue(
  existing: unknown,
  next: unknown,
): unknown {
  if (typeof existing === "boolean" && typeof next === "boolean")
    return existing || next;
  if (typeof existing === "number" && typeof next === "number")
    return Math.max(existing, next);
  return next;
}

export function subscriptionGrantsAccess(status: string): boolean {
  return ["trialing", "active", "grace", "past_due"].includes(status);
}
