import type { FastifyInstance } from "fastify";
import type { TenantContext } from "../context.js";
import { extractTenantUserSession, requireTenantRoles } from "../middleware.js";
import { WORKSPACE_READ_ROLES, count } from "./read-helpers.js";
import { SQL } from "./dashboard-sql.js";
export function registerDashboardRoutes(
  app: FastifyInstance,
  context: TenantContext,
): void {
  app.get("/api/dashboard/summary", async (request) => {
    const s = await extractTenantUserSession(request, context);
    requireTenantRoles(s.roles, WORKSPACE_READ_ROLES);
    const row = (await context.pool.query(SQL.get_summary[0], [s.workspace_id]))
      .rows[0];
    return {
      summary: {
        workspaceId: s.workspace_id,
        workspaceSlug: s.workspace_slug,
        totalClients: count(row.total_clients),
        activeAgents: count(row.active_agents),
        totalConversations: count(row.total_conversations),
        totalLeads: count(row.total_leads),
        requestsThisMonth: count(row.requests_this_month),
      },
    };
  });
  app.get("/api/dashboard/activity", async (request) => {
    const s = await extractTenantUserSession(request, context);
    requireTenantRoles(s.roles, WORKSPACE_READ_ROLES);
    return {
      activity: (
        await context.pool.query(SQL.get_activity[0], [s.workspace_id])
      ).rows,
    };
  });
  app.get("/api/dashboard/services", async (request) => {
    const s = await extractTenantUserSession(request, context);
    requireTenantRoles(s.roles, WORKSPACE_READ_ROLES);
    const values: bigint[] = [];
    for (const sql of SQL.list_services)
      values.push(
        BigInt((await context.pool.query(sql, [s.workspace_id])).rows[0].count),
      );
    return {
      services: [
        { id: "workspace", name: "Workspace Access", is_active: true },
        {
          id: "clients",
          name: "Client Management",
          is_active: values[1]! > 0n,
        },
        { id: "agents", name: "Automation Agents", is_active: values[0]! > 0n },
        {
          id: "conversations",
          name: "Conversation Hub",
          is_active: values[2]! > 0n,
        },
        { id: "leads", name: "Lead Pipeline", is_active: values[3]! > 0n },
      ],
    };
  });
}
