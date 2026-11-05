import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { ActionScope } from "../../contracts/connections";
import { WebsiteAppearanceStore } from "./appearance-store";
export function registerWebsiteAppearanceRoutes(app: FastifyInstance, options: { pool: Pool; resolveScope(request: FastifyRequest): Promise<ActionScope> }): void {
  const store = new WebsiteAppearanceStore(options.pool);
  const path = "/api/organizations/:organizationId/agents/:agentId/deployments/:deploymentId/appearance";
  const ids = (request: FastifyRequest) => request.params as { agentId: string; deploymentId: string };
  const draftPath = "/api/organizations/:organizationId/agents/:agentId/website-appearance-draft";
  app.get(draftPath, async request => store.getDraft(await options.resolveScope(request), ids(request).agentId));
  app.put(draftPath, async request => store.updateDraft(await options.resolveScope(request), ids(request).agentId, request.body));
  app.get(path, async request => { const scope = await options.resolveScope(request), {agentId,deploymentId}=ids(request); return store.get(scope,agentId,deploymentId); });
  app.put(path, async request => { const scope = await options.resolveScope(request), {agentId,deploymentId}=ids(request); return store.update(scope,agentId,deploymentId,request.body); });
}
