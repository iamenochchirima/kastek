import type { FastifyInstance } from "fastify";
import type { TenantContext } from "../context.js";
import { access } from "./read-helpers.js";
import {
  agencyBillingClient,
  ensureAgencyBillingAccount,
} from "../capabilities/billing.js";

const BILLING_ROLES = ["owner", "admin"] as const;

export function registerBillingRoutes(
  app: FastifyInstance,
  context: TenantContext,
): void {
  app.get("/api/billing", async (request) => {
    const session = await access(request, context, BILLING_ROLES);
    const client = agencyBillingClient(context);
    if (!client)
      return { configured: false, account: null, invoices: [], plans: [] };
    await ensureAgencyBillingAccount(context, session.workspace_id);
    const account = await client.account(session.workspace_id);
    const record =
      account.account && typeof account.account === "object"
        ? (account.account as Record<string, unknown>)
        : {};
    const currency = typeof record.currency === "string" ? record.currency : undefined;
    const [invoices, plans] = await Promise.all([
      client.invoices(session.workspace_id),
      client.plans(currency),
    ]);
    return { configured: true, account, invoices, plans };
  });
}
