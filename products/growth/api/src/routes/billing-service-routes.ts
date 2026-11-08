import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import { extractUser, resolveActiveOrgId } from "../identity/session.js";
import { requireMember } from "../services/orgs.js";
import * as billing from "../services/billing.js";
import { ApiError } from "../error.js";
import {
  billingAccountCurrency,
  billingPlan,
  billingPlans,
  cancelServiceSubscription,
  createServiceCheckout,
  getBillingSnapshot,
  reactivateServiceSubscription,
  serviceCredits,
  serviceUsage,
  verifyServiceCheckout,
  type BillingServiceConfig,
} from "../services/billing-service.js";

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}



export function registerBillingServiceRoutes(
  app: FastifyInstance,
  context: CoreContext,
  service: BillingServiceConfig,
): void {
  async function access(request: FastifyRequest) {
    const user = await extractUser(request, context);
    const org = await resolveActiveOrgId(request, context, user.id);
    await requireMember(context.pool, org, user.id);
    return { user, org };
  }

  app.get("/api/billing/summary", async (request) => {
    const { org } = await access(request);
    return billing.getBillingSummary(context.pool, org);
  });

  app.get("/api/billing/usage", async (request) => {
    const { org } = await access(request);
    const query = request.query as { range?: string };
    const range = query.range ?? "30d";
    const days = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : null;
    if (days == null)
      throw new ApiError(400, "bad_request", "Usage range must be 7d, 30d, or 90d");
    const [snapshot, usage] = await Promise.all([
      getBillingSnapshot(context.pool, service, org),
      serviceUsage(service, org),
    ]);
    const now = new Date();
    const start = new Date(now.getTime() - days * 86_400_000);
    const recent = Array.isArray(usage.recent)
      ? (usage.recent as Array<Record<string, unknown>>).slice(0, 20).map((item) => ({
          id: String(item.id ?? ""),
          actionKey: String(item.meterKey ?? ""),
          quantity: numberValue(item.quantity),
          creditsCharged: numberValue(item.creditsCharged),
          status: "COMPLETED",
          provider: null,
          model: null,
          fundingSource: null,
          inputTokens: null,
          outputTokens: null,
          pricingVersion: null,
          createdAt: String(item.occurredAt ?? now.toISOString()),
        }))
      : [];
    return {
      rangeStart: start.toISOString(),
      rangeEnd: now.toISOString(),
      timezone: "UTC",
      granularity: "day",
      daily: [],
      previousDaily: [],
      credits: {
        used: 0,
        balance: numberValue(snapshot.credits.balance),
        reserved: numberValue(snapshot.credits.reserved),
        available: numberValue(snapshot.credits.available),
      },
      operations: 0,
      breakdown: [],
      meters: billing.METERS.map((definition) => ({
        key: definition.key,
        name: definition.name,
        description: definition.description,
        used: numberValue(snapshot.meters[definition.key]?.used),
        limit:
          snapshot.meters[definition.key]?.limit == null
            ? null
            : numberValue(snapshot.meters[definition.key]!.limit),
      })),
      recent,
    };
  });

  app.get("/api/billing/credits", async (request) => {
    const { org } = await access(request);
    const [snapshot, credits] = await Promise.all([
      getBillingSnapshot(context.pool, service, org),
      serviceCredits(service, org),
    ]);
    const ledger = Array.isArray(credits.ledger)
      ? (credits.ledger as Array<Record<string, unknown>>).map((entry) => ({
          id: String(entry.id ?? ""),
          entryType: String(entry.type ?? ""),
          amount: numberValue(entry.amount),
          balanceAfter: numberValue(entry.balanceAfter),
          actionKey: null,
          sourceType: null,
          sourceId: null,
          pricingVersion: null,
          createdByAdminId: null,
          createdAt: String(entry.createdAt ?? new Date().toISOString()),
        }))
      : [];
    return {
      account: {
        orgId: org,
        balance: numberValue(snapshot.credits.balance),
        reservedBalance: numberValue(snapshot.credits.reserved),
        availableBalance: numberValue(snapshot.credits.available),
        grants: [],
        ledger,
      },
      usage: [],
    };
  });

  app.get("/api/billing/plans", async (request) => {
    const { org } = await access(request);
    const currency = await billingAccountCurrency(service, org).catch(() => null);
    const plans = await billingPlans(service, currency ?? undefined);
    return {
      plans: plans.map((plan) => ({
        key: plan.key,
        productKey: plan.product,
        name: plan.name,
        description: plan.description ?? null,
        interval: "MONTHLY",
        currency: plan.currency,
        amountMinor: numberValue(plan.amountMinor),
        creditsPerPeriod:
          plan.creditsPerPeriod == null ? null : numberValue(plan.creditsPerPeriod),
        checkoutReady: plan.checkoutReady,
        highlights: plan.entitlements
          .filter(
            (item) =>
              item.visibleToCustomer &&
              item.kind === "feature" &&
              item.value === true,
          )
          .slice(0, 6)
          .map((item) => item.name),
      })),
    };
  });

  app.get("/api/billing/plans/:planKey", async (request) => {
    const { org } = await access(request);
    const currency = await billingAccountCurrency(service, org).catch(() => null);
    const plan = await billingPlan(
      service,
      (request.params as { planKey: string }).planKey,
      currency ?? undefined,
    );
    return {
      key: plan.key,
      productKey: plan.product,
      name: plan.name,
      description: plan.description ?? null,
      interval: "MONTHLY",
      currency: plan.currency,
      amountMinor: numberValue(plan.amountMinor),
      creditsPerPeriod:
        plan.creditsPerPeriod == null ? null : numberValue(plan.creditsPerPeriod),
      checkoutReady: plan.checkoutReady,
      entitlements: plan.entitlements
        .filter((item) => item.visibleToCustomer)
        .map((item) => ({
          key: item.key,
          name: item.name,
          description: item.description,
          kind: item.kind === "meter" ? "limit" : item.kind,
          value: item.value,
          unit: item.unit,
          displayGroup: item.displayGroup,
          displayOrder: item.displayOrder,
          metadata: item.metadata,
        })),
    };
  });

  app.post("/api/billing/checkout", async (request) => {
    const { user, org } = await access(request);
    const body = request.body as
      | { planKey?: unknown; idempotencyKey?: unknown }
      | null;
    if (
      typeof body?.planKey !== "string" ||
      typeof body.idempotencyKey !== "string"
    )
      throw new ApiError(
        400,
        "bad_request",
        "Plan key and checkout idempotency key are required",
      );
    if (!user.email?.trim())
      throw new ApiError(
        400,
        "bad_request",
        "An account email is required for checkout",
      );
    const result = await createServiceCheckout(service, {
      orgId: org,
      planKey: body.planKey,
      email: user.email,
      idempotencyKey: body.idempotencyKey,
      returnUrl: `${context.config.frontendUrl.replace(/\/+$/, "")}/billing?payment=complete`,
    });
    return {
      authorizationUrl: result.authorizationUrl,
      reference: result.reference,
      planName: body.planKey,
      reused: result.reused,
    };
  });

  app.post("/api/billing/checkout/:reference/verify", async (request) => {
    const { org } = await access(request);
    const result = await verifyServiceCheckout(
      service,
      org,
      (request.params as { reference: string }).reference,
    );
    return {
      reference: result.reference,
      status: result.status,
      activated: result.status === "completed",
    };
  });

  app.post("/api/billing/subscriptions/:id/:action", async (request) => {
    const { org } = await access(request);
    const { id, action } = request.params as { id: string; action: string };
    if (action === "cancel") {
      const result = await cancelServiceSubscription(service, org, id);
      return {
        updated: true,
        cancelAtPeriodEnd: result.cancelAtPeriodEnd,
      };
    }
    if (action === "reactivate") {
      await reactivateServiceSubscription(service, org, id);
      return { updated: true, cancelAtPeriodEnd: false };
    }
    throw new ApiError(400, "bad_request", "Unsupported subscription action");
  });
}
