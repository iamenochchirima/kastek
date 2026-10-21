import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { ActionScope } from "../../contracts/connections";
import { WebsiteAppearanceStore } from "./appearance-store";
export function registerWebsiteAppearanceRoutes(app: FastifyInstance, options: { pool: Pool; resolveScope(request: FastifyRequest): Promise<ActionScope> }): void {
  const store = new WebsiteAppearanceStore(options.pool);
  const path = "/api/organizations/:organizationId/agents/:agentId/deployments/:deploymentId/appearance";
  const ids = (request: FastifyRequest) => request.params as { agentId: string; deploymentId: string };
  app.get(path, async request => { const scope = await options.resolveScope(request), {agentId,deploymentId}=ids(request); return store.get(scope,agentId,deploymentId); });
  app.put(path, async request => { const scope = await options.resolveScope(request), {agentId,deploymentId}=ids(request); return store.update(scope,agentId,deploymentId,request.body); });
}
