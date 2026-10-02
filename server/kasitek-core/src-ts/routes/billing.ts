import { parseSerdeValueJson } from "../json.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import { extractUser, resolveActiveOrgId } from "../identity/session.js";
import { requireMember, requireAdmin } from "../services/orgs.js";
import * as billing from "../services/billing.js";
import * as credits from "../services/credits.js";
import {
  getReferralSummary,
  referralRewardConfig,
} from "../services/referrals.js";
import { ApiError } from "../error.js";
export function paystackProvider(
  context: CoreContext,
): billing.PaystackProvider {
  const env = context.config.env;
  const live = (env.PAYSTACK_MODE?.trim() ?? "test").toLowerCase() === "live";
  const secret =
    (live ? env.PAYSTACK_LIVE_SECRET_KEY : env.PAYSTACK_TEST_SECRET_KEY) ??
    env.PAYSTACK_SECRET_KEY;
  if (!secret?.trim())
    throw new ApiError(500, "internal_error", "Paystack is not configured");
  return new billing.PaystackProvider(
    secret,
    env.PAYSTACK_API_BASE_URL?.trim() || "https://api.paystack.co",
  );
}
export function registerBillingRoutes(
  app: FastifyInstance,
  context: CoreContext,
): void {
  const config = () => referralRewardConfig(context.config);
  async function access(request: FastifyRequest, admin = false) {
    const user = await extractUser(request, context),
      org = await resolveActiveOrgId(request, context, user.id);
    if (admin) await requireAdmin(context.pool, org, user.id);
    else await requireMember(context.pool, org, user.id);
    return { user, org };
  }
  app.get("/api/billing/summary", async (request) =>
    billing.getBillingSummary(context.pool, (await access(request)).org),
  );
  app.get("/api/billing/usage", async (request) => {
    const { org } = await access(request),
      range = (request.query as { range?: string }).range ?? "30d",
      days =
        range === "7d"
          ? 7
          : range === "30d"
            ? 30
            : range === "90d"
              ? 90
              : undefined;
    if (days == null)
      throw new ApiError(
        400,
        "bad_request",
        "Usage range must be 7d, 30d, or 90d",
      );
    const usage = await billing.getBillingUsage(context.pool, org, days),
      summary = await billing.getBillingSummary(context.pool, org),
      account = await credits.getCreditAccount(context.pool, org);
    return {
      rangeStart: usage.rangeStart,
      rangeEnd: usage.rangeEnd,
      timezone: usage.timezone,
      granularity: usage.granularity,
      daily: usage.daily,
      previousDaily: usage.previousDaily,
      credits: {
        used: usage.creditsUsed,
        balance: account.balance,
        reserved: account.reservedBalance,
        available: account.availableBalance,
      },
      operations: usage.operations,
      breakdown: usage.breakdown,
      meters: summary.meters,
      recent: await credits.getCreditUsage(context.pool, org, 20),
    };
  });
  app.get("/api/billing/credits", async (request) => {
    const { org } = await access(request);
    return {
      account: await credits.getCreditAccount(context.pool, org),
      usage: await credits.getCreditUsage(context.pool, org, 100),
      referral: await getReferralSummary(
        context.pool,
        org,
        config(),
        context.config.frontendUrl,
      ),
    };
  });
  app.get("/api/billing/plans", async (request) => {
    await access(request);
    return { plans: await billing.listAvailablePlans(context.pool) };
  });
  app.get("/api/billing/plans/:planKey", async (request) => {
    await access(request);
    return billing.getAvailablePlanDetails(
      context.pool,
      (request.params as { planKey: string }).planKey,
    );
  });
  app.post("/api/billing/checkout", async (request) => {
    const { org, user } = await access(request, true),
      body = request.body as {
        planKey?: unknown;
        idempotencyKey?: unknown;
      } | null;
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
    return billing.createCheckout(
      context.pool,
      paystackProvider(context),
      context.config.frontendUrl,
      org,
      user.id,
      user.email,
      body.planKey,
      body.idempotencyKey,
    );
  });
  app.post("/api/billing/checkout/:reference/verify", async (request) => {
    const { org } = await access(request, true);
    return billing.verifyCheckout(
      context.pool,
      paystackProvider(context),
      org,
      (request.params as { reference: string }).reference,
      config(),
    );
  });
  app.post("/api/billing/subscriptions/:id/:action", async (request) => {
    const { org } = await access(request, true),
      { id, action } = request.params as { id: string; action: string };
    if (action !== "reactivate" && action !== "cancel")
      throw new ApiError(400, "bad_request", "Unsupported subscription action");
    const enabled = action === "reactivate";
    await billing.setSubscriptionEnabled(
      context.pool,
      paystackProvider(context),
      org,
      id,
      enabled,
    );
    return { updated: true, cancelAtPeriodEnd: !enabled };
  });
  // Encapsulation retains the original payload bytes without changing other JSON routes.
  app.register(async (webhook) => {
    webhook.removeAllContentTypeParsers();
    webhook.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: 262_144 },
      (_request, payload, done) => done(null, payload),
    );
    webhook.post(
      "/api/webhooks/paystack",
      { bodyLimit: 262_144 },
      async (request) => {
        const provider = paystackProvider(context),
          signature = request.headers["x-paystack-signature"];
        if (
          !Buffer.isBuffer(request.body) ||
          typeof signature !== "string" ||
          !provider.verifyWebhook(request.body, signature)
        )
          throw new ApiError(401, "unauthorized", "Unauthorized");
        let value: unknown;
        try {
          value = parseSerdeValueJson(
            new TextDecoder("utf-8", { fatal: true }).decode(request.body),
          );
        } catch {
          throw new ApiError(
            400,
            "bad_request",
            "Invalid Paystack webhook payload",
          );
        }
        const event = provider.parseWebhook(value),
          key = billing.paystackEventKey(value);
        if (!(await billing.recordPaystackEvent(context.pool, key, value)))
          return { received: true, duplicate: true };
        try {
          const processed = await billing.processProviderEvent(
            context.pool,
            provider.name,
            event,
            config(),
          );
          await billing.finishPaystackEvent(
            context.pool,
            key,
            processed ? "PROCESSED" : "IGNORED",
            null,
          );
          return { received: true, processed };
        } catch (error) {
          await billing.finishPaystackEvent(
            context.pool,
            key,
            "FAILED",
            String(error),
          );
          throw error;
        }
      },
    );
  });
}
