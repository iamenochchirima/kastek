import type { FastifyInstance, FastifyRequest } from "fastify";

type Scope = { accountId: string; organizationId: string };

/** Empty catalogue responses when optional connection services are not composed. */
export function registerConnectionFallbackRoutes(app: FastifyInstance, options: {
  resolveScope(request: FastifyRequest): Promise<Scope>;
  connections: boolean;
  toolBindings: boolean;
}) {
  if (options.connections) app.get("/api/organizations/:organizationId/connections", async request => {
    await options.resolveScope(request);
    return { connections: [], targets: [], profiles: [], available: false };
  });
  if (options.toolBindings) app.get("/api/organizations/:organizationId/tool-bindings", async request => {
    await options.resolveScope(request);
    return { bindings: [], available: false };
  });
}
