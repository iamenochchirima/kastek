import type {
  BillingAccountEnsureInput,
  BillingAccountEnsureResult,
  BillingCheckoutInput,
  BillingCheckoutResult,
  BillingCheckoutVerification,
  BillingCreditSummary,
  BillingEntitlementSnapshot,
  BillingInvoiceSummary,
  BillingPlanSummary,
  BillingProduct,
  BillingUsageEventInput,
  BillingUsageEventResult,
} from "@kasitek-labs/contracts";
import {
  BILLING_AUTHORITY_HEADER,
  createBillingAuthority,
  parseBillingSnapshotToken,
} from "./billing-authority.js";

export interface BillingClientConfig {
  url: string;
  secret: string;
  snapshotSecret: string;
  product: BillingProduct;
  timeoutMs?: number;
}

interface CacheEntry {
  snapshot: BillingEntitlementSnapshot;
  expiresAt: number;
}

export class BillingClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly config: BillingClientConfig) {
    if (Buffer.byteLength(config.secret) < 32)
      throw new Error("BILLING_SERVICE_SECRET requires at least 32 bytes");
    if (Buffer.byteLength(config.snapshotSecret) < 32)
      throw new Error("BILLING_SNAPSHOT_SECRET requires at least 32 bytes");
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 3_000;
  }

  static fromEnvironment(
    product: BillingProduct,
    env: NodeJS.ProcessEnv = process.env,
  ): BillingClient | null {
    const url = env.BILLING_SERVICE_URL?.trim();
    const secret = env.BILLING_SERVICE_SECRET?.trim();
    const snapshotSecret = env.BILLING_SNAPSHOT_SECRET?.trim();
    if (!url || !secret || !snapshotSecret) return null;
    return new BillingClient({
      url,
      secret,
      snapshotSecret,
      product,
      timeoutMs: Number(env.BILLING_SERVICE_TIMEOUT_MS ?? 3000),
    });
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const authority = createBillingAuthority({
      secret: this.config.secret,
      product: this.config.product,
      method,
      path,
      body: raw,
    });
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          [BILLING_AUTHORITY_HEADER]: authority,
        },
        body: body === undefined ? undefined : raw,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new Error("Billing service is unavailable");
    }
    return response;
  }

  private async json<T>(response: Response): Promise<T> {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    if (!response.ok)
      throw new Error(
        payload?.error ?? `Billing request failed (${response.status})`,
      );
    return payload as T;
  }

  async ensureAccount(
    input: Omit<BillingAccountEnsureInput, "product">,
  ): Promise<BillingAccountEnsureResult> {
    const result = await this.json<BillingAccountEnsureResult>(
      await this.request("POST", "/internal/accounts/ensure", {
        ...input,
        product: this.config.product,
      }),
    );
    this.cache.delete(input.tenantId);
    return result;
  }

  async snapshot(tenantId: string, force = false): Promise<BillingEntitlementSnapshot> {
    const cached = this.cache.get(tenantId);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.snapshot;
    let response = await this.request(
      "GET",
      `/internal/entitlements?product=${this.config.product}&tenantId=${encodeURIComponent(tenantId)}`,
    );
    if (response.status === 404) {
      throw new Error("Billing account is not linked for this tenant");
    }
    const body = await this.json<{
      snapshot: BillingEntitlementSnapshot;
      token: string;
    }>(response);
    const snapshot = parseBillingSnapshotToken(
      body.token,
      this.config.snapshotSecret,
    );
    if (
      snapshot.accountId !== body.snapshot.accountId ||
      snapshot.tenantId !== tenantId ||
      snapshot.product !== this.config.product
    )
      throw new Error("Billing snapshot identity mismatch");
    this.cache.set(tenantId, {
      snapshot,
      expiresAt: Math.min(Date.parse(snapshot.expiresAt), Date.now() + 60_000),
    });
    return snapshot;
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  async usage(
    input: Omit<BillingUsageEventInput, "product">,
  ): Promise<BillingUsageEventResult> {
    const result = await this.json<BillingUsageEventResult>(
      await this.request("POST", "/internal/usage", {
        ...input,
        product: this.config.product,
      }),
    );
    this.cache.delete(input.tenantId);
    return result;
  }

  async grantCredits(input: {
    tenantId: string;
    source: "TRIAL" | "PROMOTION" | "MIGRATION";
    amount: string;
    endsAt?: string | null;
    reference?: string | null;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ grantId: string; balance: string; replayed: boolean }> {
    const result = await this.json<{
      grantId: string;
      balance: string;
      replayed: boolean;
    }>(
      await this.request("POST", "/internal/credits/grant", {
        ...input,
        product: this.config.product,
      }),
    );
    this.cache.delete(input.tenantId);
    return result;
  }

  async revokeCredits(input: {
    tenantId: string;
    grantId: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<{ revoked: string; balance: string }> {
    const result = await this.json<{ revoked: string; balance: string }>(
      await this.request("POST", "/internal/credits/revoke", {
        ...input,
        product: this.config.product,
      }),
    );
    this.cache.delete(input.tenantId);
    return result;
  }

  async checkout(
    input: Omit<BillingCheckoutInput, "product">,
  ): Promise<BillingCheckoutResult> {
    return this.json<BillingCheckoutResult>(
      await this.request("POST", "/internal/checkout", {
        ...input,
        product: this.config.product,
      }),
    );
  }

  async verifyCheckout(
    tenantId: string,
    reference: string,
  ): Promise<BillingCheckoutVerification> {
    const result = await this.json<BillingCheckoutVerification>(
      await this.request(
        "POST",
        `/internal/checkout/${encodeURIComponent(reference)}/verify`,
        { tenantId },
      ),
    );
    this.cache.delete(tenantId);
    return result;
  }

  async cancelSubscription(
    tenantId: string,
    subscriptionId: string,
  ): Promise<{ canceled: boolean; cancelAtPeriodEnd: boolean }> {
    const result = await this.json<{
      canceled: boolean;
      cancelAtPeriodEnd: boolean;
    }>(
      await this.request(
        "POST",
        `/internal/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
        { tenantId },
      ),
    );
    this.cache.delete(tenantId);
    return result;
  }

  async reactivateSubscription(
    tenantId: string,
    subscriptionId: string,
  ): Promise<{ reactivated: boolean }> {
    const result = await this.json<{ reactivated: boolean }>(
      await this.request(
        "POST",
        `/internal/subscriptions/${encodeURIComponent(subscriptionId)}/reactivate`,
        { tenantId },
      ),
    );
    this.cache.delete(tenantId);
    return result;
  }

  async plans(currency?: string): Promise<BillingPlanSummary[]> {
    const query = currency
      ? `?currency=${encodeURIComponent(currency.toUpperCase())}`
      : "";
    return (
      await this.json<{ plans: BillingPlanSummary[] }>(
        await this.request("GET", `/internal/plans${query}`),
      )
    ).plans;
  }

  async plan(planKey: string, currency?: string): Promise<BillingPlanSummary> {
    const query = currency
      ? `?currency=${encodeURIComponent(currency.toUpperCase())}`
      : "";
    return this.json<BillingPlanSummary>(
      await this.request(
        "GET",
        `/internal/plans/${encodeURIComponent(planKey)}${query}`,
      ),
    );
  }

  async account(tenantId: string): Promise<Record<string, unknown>> {
    return this.json<Record<string, unknown>>(
      await this.request(
        "GET",
        `/internal/account?product=${this.config.product}&tenantId=${encodeURIComponent(tenantId)}`,
      ),
    );
  }

  async invoices(tenantId: string): Promise<BillingInvoiceSummary[]> {
    return (
      await this.json<{ invoices: BillingInvoiceSummary[] }>(
        await this.request(
          "GET",
          `/internal/invoices?product=${this.config.product}&tenantId=${encodeURIComponent(tenantId)}`,
        ),
      )
    ).invoices;
  }

  async credits(
    tenantId: string,
  ): Promise<{ credits: BillingCreditSummary; ledger: unknown[]; grants: unknown[] }> {
    return this.json<{
      credits: BillingCreditSummary;
      ledger: unknown[];
      grants: unknown[];
    }>(
      await this.request(
        "GET",
        `/internal/credits?product=${this.config.product}&tenantId=${encodeURIComponent(tenantId)}`,
      ),
    );
  }
}
