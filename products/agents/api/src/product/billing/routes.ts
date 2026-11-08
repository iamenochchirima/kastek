import type { FastifyInstance, FastifyRequest } from "fastify";
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
}
