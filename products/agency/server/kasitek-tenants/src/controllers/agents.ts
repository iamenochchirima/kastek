import type { FastifyInstance } from "fastify";
import type { TenantContext } from "../context.js";
import { missing } from "../error.js";
import { access, AGENT_ROLES, id } from "./read-helpers.js";
import { SQL } from "./agents-sql.js";
export function registerAgentsRoutes(
  app: FastifyInstance,
  context: TenantContext,
): void {
  app.get("/api/agents", async (request) => {
    const s = await access(request, context, AGENT_ROLES);
    return {
      workspaceId: s.workspace_id,
      agents: (await context.pool.query(SQL.list_agents[0], [s.workspace_id]))
        .rows,
    };
  });
  app.get("/api/agents/:id", async (request) => {
    const s = await access(request, context, AGENT_ROLES);
    const row = (
      await context.pool.query(SQL.get_agent[0], [s.workspace_id, id(request)])
    ).rows[0];
    if (!row) throw missing("agent not found");
    return { workspaceId: s.workspace_id, agent: row };
  });
}
