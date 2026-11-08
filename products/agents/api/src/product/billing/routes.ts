import type { FastifyInstance, FastifyRequest } from "fastify";
import { PlatformError } from "../../contracts/contracts";
import type { Pool } from "pg";
import {
  agentsBillingClient,
  ensureAgentsBillingAccount,
} from "./billing";

type Scope = { accountId: string; organizationId: string };

export function registerBillingRoutes(
  app: FastifyInstance,
  options: {
    pool: Pool;
    publicUrl: string;
    resolveScope(request: FastifyRequest): Promise<Scope>;
  },
): void {
  app.get("/api/organizations/:organizationId/billing", async (request) => {
    const scope = await options.resolveScope(request);
    const client = agentsBillingClient();
    if (!client)
      return {
        configured: false,
        account: null,
        invoices: [],
        plans: [],
      };
    await ensureAgentsBillingAccount(
      options.pool,
      client,
      scope.organizationId,
    );
    const account = await client.account(scope.organizationId);
    const accountRecord =
      account.account && typeof account.account === "object"
        ? (account.account as Record<string, unknown>)
        : {};
    const currency =
      typeof accountRecord.currency === "string" ? accountRecord.currency : undefined;
    const [invoices, plans] = await Promise.all([
      client.invoices(scope.organizationId),
      client.plans(currency),
    ]);
    return {
      configured: true,
      account,
      invoices,
      plans,
    };
  });

  app.post("/api/organizations/:organizationId/billing/checkout", async (request) => {
    const scope = await options.resolveScope(request);
    const client = agentsBillingClient();
    if (!client)
      throw new PlatformError("BILLING_UNAVAILABLE", 503, "Customer billing is not configured");
    const body = (request.body ?? {}) as { planKey?: unknown; idempotencyKey?: unknown };
    if (typeof body.planKey !== "string" || !body.planKey.trim())
      throw new PlatformError("BILLING_PLAN_REQUIRED", 400, "Plan key is required");
    if (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim())
      throw new PlatformError("BILLING_REQUEST_INVALID", 400, "Checkout idempotency key is required");
    await ensureAgentsBillingAccount(options.pool, client, scope.organizationId);
    const account = await client.account(scope.organizationId);
    const accountRecord =
      account.account && typeof account.account === "object"
        ? (account.account as Record<string, unknown>)
        : {};
    const email =
      typeof accountRecord.billing_email === "string"
        ? accountRecord.billing_email
        : "";
    if (!email) throw new PlatformError("BILLING_EMAIL_REQUIRED", 409, "The billing account has no email");
    const result = await client.checkout({
      tenantId: scope.organizationId,
      planKey: body.planKey.trim(),
      email,
      idempotencyKey: body.idempotencyKey.trim(),
      returnUrl: `${options.publicUrl.replace(/\/+$/, "")}/app/settings?payment=complete`,
    });
    return result;
  });

  app.post(
    "/api/organizations/:organizationId/billing/checkout/:reference/verify",
    async (request) => {
      const scope = await options.resolveScope(request);
      const client = agentsBillingClient();
      if (!client)
        throw new PlatformError("BILLING_UNAVAILABLE", 503, "Customer billing is not configured");
      const reference = (request.params as { reference: string }).reference;
      return client.verifyCheckout(scope.organizationId, reference);
    },
  );
}
