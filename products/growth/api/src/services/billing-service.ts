import type { Pool } from "pg";
import type {
  BillingCheckoutResult,
  BillingCheckoutVerification,
  BillingEntitlementSnapshot,
  BillingInvoiceSummary,
  BillingPlanSummary,
  BillingProduct,
} from "@kasitek-labs/contracts";
import {
  BILLING_AUTHORITY_HEADER,
  createBillingAuthority,
  parseBillingSnapshotToken,
} from "@kasitek-labs/server-support/billing-authority";
import { ApiError } from "../error.js";

export interface BillingServiceConfig {
  url: string;
  secret: string;
  snapshotSecret: string;
  timeoutMs: number;
}

interface CacheEntry {
  snapshot: BillingEntitlementSnapshot;
  expiresAt: number;
}

const snapshots = new Map<string, CacheEntry>();

export function billingServiceConfig(
  env: Record<string, string | undefined>,
): BillingServiceConfig | null {
  const url = env.BILLING_SERVICE_URL?.trim().replace(/\/+$/, "");
  const secret = env.BILLING_SERVICE_SECRET?.trim();
  const snapshotSecret = env.BILLING_SNAPSHOT_SECRET?.trim();
  if (!url || !secret || !snapshotSecret) return null;
  if (Buffer.byteLength(secret) < 32 || Buffer.byteLength(snapshotSecret) < 32)
    throw new Error("Billing service secrets require at least 32 bytes");
  return {
    url,
    secret,
    snapshotSecret,
    timeoutMs: Number(env.BILLING_SERVICE_TIMEOUT_MS ?? 3000),
  };
}

async function request(
  config: BillingServiceConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const authority = createBillingAuthority({
    secret: config.secret,
    product: "growth",
    method,
    path,
    body: raw,
  });
  let response: Response;
  try {
    response = await fetch(`${config.url}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        [BILLING_AUTHORITY_HEADER]: authority,
      },
      body: body === undefined ? undefined : raw,
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch {
    throw new ApiError(503, "service_unavailable", "Billing service is unavailable");
  }
  return response;
}

async function json<T>(response: Response): Promise<T> {
  const value = (await response.json().catch(() => null)) as
    | { error?: string }
    | null;
  if (!response.ok)
    throw new ApiError(
      response.status >= 500 ? 503 : response.status,
      response.status === 404 ? "not_found" : "billing_unavailable",
      value?.error ?? "Billing request failed",
    );
  return value as T;
}

export async function ensureBillingAccount(
  pool: Pool,
  config: BillingServiceConfig,
  orgId: string,
): Promise<{ accountId: string; revision: string }> {
  const org = await pool.query<{ name: string; email: string | null }>(
    `SELECT o.name, u.email
       FROM "Organization" o
       JOIN "User" u ON u.id=o."ownerId"
      WHERE o.id=$1`,
    [orgId],
  );
  if (!org.rows[0]) throw new ApiError(404, "not_found", "Organization not found");
  const email = org.rows[0].email?.trim();
  if (!email)
    throw new ApiError(
      409,
      "conflict",
      "The organization owner needs an email before billing can start",
    );
  const response = await request(
    config,
    "POST",
    "/internal/accounts/ensure",
    {
      product: "growth",
      tenantId: orgId,
      name: org.rows[0].name,
      billingEmail: email,
    },
  );
  const result = await json<{
    accountId: string;
    revision: string;
  }>(response);
  snapshots.delete(orgId);
  return result;
}

export async function getBillingSnapshot(
  pool: Pool,
  config: BillingServiceConfig,
  orgId: string,
  force = false,
): Promise<BillingEntitlementSnapshot> {
  const cached = snapshots.get(orgId);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.snapshot;
  let response = await request(
    config,
    "GET",
    `/internal/entitlements?product=growth&tenantId=${encodeURIComponent(orgId)}`,
  );
  if (response.status === 404) {
    await ensureBillingAccount(pool, config, orgId);
    response = await request(
      config,
      "GET",
      `/internal/entitlements?product=growth&tenantId=${encodeURIComponent(orgId)}`,
    );
  }
  const body = await json<{ snapshot: BillingEntitlementSnapshot; token: string }>(
    response,
  );
  const snapshot = parseBillingSnapshotToken(body.token, config.snapshotSecret);
  if (
    snapshot.accountId !== body.snapshot.accountId ||
    snapshot.tenantId !== orgId ||
    snapshot.product !== "growth"
  )
    throw new ApiError(503, "service_unavailable", "Billing snapshot identity mismatch");
  snapshots.set(orgId, {
    snapshot,
    expiresAt: Math.min(Date.parse(snapshot.expiresAt), Date.now() + 60_000),
  });
  return snapshot;
}

export function invalidateBillingSnapshot(orgId: string): void {
  snapshots.delete(orgId);
}

export async function billingPlans(
  config: BillingServiceConfig,
  currency?: string,
): Promise<BillingPlanSummary[]> {
  const query = currency
    ? `?currency=${encodeURIComponent(currency.toUpperCase())}`
    : "";
  const response = await request(config, "GET", `/internal/plans${query}`);
  return (await json<{ plans: BillingPlanSummary[] }>(response)).plans;
}

export async function billingPlan(
  config: BillingServiceConfig,
  planKey: string,
  currency?: string,
): Promise<BillingPlanSummary> {
  const query = currency
    ? `?currency=${encodeURIComponent(currency.toUpperCase())}`
    : "";
  return json<BillingPlanSummary>(
    await request(
      config,
      "GET",
      `/internal/plans/${encodeURIComponent(planKey)}${query}`,
    ),
  );
}

export async function billingAccountCurrency(
  config: BillingServiceConfig,
  orgId: string,
): Promise<string | null> {
  const summary = await serviceAccount(config, orgId);
  const account = summary.account;
  if (!account || typeof account !== "object" || Array.isArray(account)) return null;
  const currency = (account as Record<string, unknown>).currency;
  return typeof currency === "string" ? currency : null;
}

export async function createServiceCheckout(
  config: BillingServiceConfig,
  input: {
    orgId: string;
    planKey: string;
    email: string;
    idempotencyKey: string;
    returnUrl: string;
  },
): Promise<BillingCheckoutResult> {
  return json<BillingCheckoutResult>(
    await request(config, "POST", "/internal/checkout", {
      product: "growth",
      tenantId: input.orgId,
      planKey: input.planKey,
      email: input.email,
      idempotencyKey: input.idempotencyKey,
      returnUrl: input.returnUrl,
    }),
  );
}

export async function verifyServiceCheckout(
  config: BillingServiceConfig,
  orgId: string,
  reference: string,
): Promise<BillingCheckoutVerification> {
  const result = await json<BillingCheckoutVerification>(
    await request(
      config,
      "POST",
      `/internal/checkout/${encodeURIComponent(reference)}/verify`,
      { tenantId: orgId },
    ),
  );
  invalidateBillingSnapshot(orgId);
  return result;
}

export async function cancelServiceSubscription(
  config: BillingServiceConfig,
  orgId: string,
  subscriptionId: string,
): Promise<{ canceled: boolean; cancelAtPeriodEnd: boolean }> {
  const result = await json<{ canceled: boolean; cancelAtPeriodEnd: boolean }>(
    await request(
      config,
      "POST",
      `/internal/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
      { tenantId: orgId },
    ),
  );
  invalidateBillingSnapshot(orgId);
  return result;
}

export async function reactivateServiceSubscription(
  config: BillingServiceConfig,
  orgId: string,
  subscriptionId: string,
): Promise<{ reactivated: boolean }> {
  const result = await json<{ reactivated: boolean }>(
    await request(
      config,
      "POST",
      `/internal/subscriptions/${encodeURIComponent(subscriptionId)}/reactivate`,
      { tenantId: orgId },
    ),
  );
  invalidateBillingSnapshot(orgId);
  return result;
}

export async function serviceAccount(
  config: BillingServiceConfig,
  orgId: string,
): Promise<Record<string, unknown>> {
  return json<Record<string, unknown>>(
    await request(
      config,
      "GET",
      `/internal/account?product=growth&tenantId=${encodeURIComponent(orgId)}`,
    ),
  );
}

export async function serviceInvoices(
  config: BillingServiceConfig,
  orgId: string,
): Promise<BillingInvoiceSummary[]> {
  return (
    await json<{ invoices: BillingInvoiceSummary[] }>(
      await request(
        config,
        "GET",
        `/internal/invoices?product=growth&tenantId=${encodeURIComponent(orgId)}`,
      ),
    )
  ).invoices;
}

export async function serviceCredits(
  config: BillingServiceConfig,
  orgId: string,
): Promise<Record<string, unknown>> {
  return json<Record<string, unknown>>(
    await request(
      config,
      "GET",
      `/internal/credits?product=growth&tenantId=${encodeURIComponent(orgId)}`,
    ),
  );
}

export async function serviceUsage(
  config: BillingServiceConfig,
  orgId: string,
): Promise<Record<string, unknown>> {
  return json<Record<string, unknown>>(
    await request(
      config,
      "GET",
      `/internal/usage?product=growth&tenantId=${encodeURIComponent(orgId)}`,
    ),
  );
}

export async function recordServiceUsage(
  config: BillingServiceConfig,
  input: {
    orgId: string;
    meterKey: string;
    quantity: number;
    sourceType: string;
    sourceId: string;
    idempotencyKey: string;
  },
): Promise<void> {
  await json(
    await request(config, "POST", "/internal/usage", {
      product: "growth",
      tenantId: input.orgId,
      meterKey: input.meterKey,
      quantity: String(input.quantity),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      idempotencyKey: input.idempotencyKey,
    }),
  );
}

export function planProduct(plan: BillingPlanSummary): BillingProduct {
  return plan.product;
}
