import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WorkflowRevisions } from "../../execution/procedures/workflow-revisions";

/** Workspace-scoped publication of declarative workflow revisions. */
export function registerWorkflowRoutes(app: FastifyInstance, options: {
  store: WorkflowRevisions;
  resolveScope(request: FastifyRequest): Promise<{ accountId: string; organizationId: string }>;
}) {
  const base = "/api/organizations/:organizationId/workflow-revisions";
  app.get(base, async request => ({ workflows: await options.store.list(await options.resolveScope(request)) }));
  app.post(base, async (request, reply) => reply.code(201)
    .header("cache-control", "no-store")
    .send({ workflow: await options.store.publish(await options.resolveScope(request), request.body) }));
}
