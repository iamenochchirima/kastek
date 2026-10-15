import type { FastifyInstance } from "fastify";
import type { TenantContext } from "../context.js";
import { access, USAGE_ROLES, count } from "./read-helpers.js";
import { SQL } from "./usage-sql.js";
export function registerUsageRoutes(
  app: FastifyInstance,
  context: TenantContext,
): void {
  app.get("/api/usage", async (request) => {
    const s = await access(request, context, USAGE_ROLES),
      args = [s.workspace_id];
    const usage = (await context.pool.query(SQL.get_usage[0], args)).rows[0],
      limits = (await context.pool.query(SQL.get_usage[1], args)).rows[0];
    return {
      workspaceId: s.workspace_id,
      usage: {
        requestsThisMonth: count(usage.requests_this_month),
        tokensThisMonth: count(usage.tokens_this_month),
        conversationsThisMonth: count(usage.conversations_this_month),
        limits: {
          requestsPerMonth: count(limits?.requests_per_month),
          tokensPerMonth: count(limits?.tokens_per_month),
          conversationsPerMonth: count(limits?.conversations_per_month),
        },
      },
    };
  });
}
