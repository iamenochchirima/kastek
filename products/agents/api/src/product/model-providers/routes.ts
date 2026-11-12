import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ActionScope } from "../../contracts/connections";
import type { ModelProviderStore } from "./store";
import { observeConnectionControl, type connectionFlowSchema } from "../../observability/connection-telemetry";
import { agentsManagedModelCatalogueAllowed } from "../billing/billing";

export function registerModelProviderRoutes(app: FastifyInstance, options: {
  store: ModelProviderStore; resolveScope(request: FastifyRequest): Promise<ActionScope>;
}): void {
  const base = "/api/organizations/:organizationId/model-providers";
  const connectionId = (request: FastifyRequest) => z.uuid().parse((request.params as Record<string, string>).connectionId);
  const revision = z.strictObject({ expectedRevision: z.number().int().positive() });
  const control = async <T>(request: FastifyRequest, flow: z.infer<typeof connectionFlowSchema>, run: (scope: ActionScope) => Promise<T>) => {
    const scope = await options.resolveScope(request);
    return observeConnectionControl(options.store.pool, "model_provider", flow, { organizationId: scope.organizationId }, () => run(scope));
  };
  app.get(`${base}/catalogue`, async request => {
    await options.resolveScope(request);
    return { providers: options.store.registry };
  });
  app.get(base, async request => ({ connections: await options.store.list(await options.resolveScope(request)) }));
  app.get(`${base}/default`, async request => options.store.getDefault(await options.resolveScope(request)));
  app.put(`${base}/default`, async request => control(request, "connect", scope => options.store.setDefault(scope, request.body)));
  app.post(base, { bodyLimit: 16384 }, async request => control(request, "connect", async scope => ({ connection: await options.store.create(scope, request.body) })));
  app.get(`${base}/:connectionId`, async request => ({ connection: await options.store.get(await options.resolveScope(request), connectionId(request)) }));
  app.get(`${base}/:connectionId/models`, async request => {
    const scope = await options.resolveScope(request);
    const paidModelsAllowed = await agentsManagedModelCatalogueAllowed(options.store.pool, scope.organizationId);
    return options.store.cachedModels(scope, connectionId(request),
      z.strictObject({ agentId: z.uuid().optional() }).parse(request.query).agentId,
      paidModelsAllowed);
  });
  app.post(`${base}/:connectionId/models/manual`, { bodyLimit: 16384 }, async request => control(request, "discover", scope =>
    options.store.addManualModel(scope, connectionId(request), request.body)));
  app.post(`${base}/:connectionId/probe`, async request => control(request, "discover", scope =>
    options.store.probe(scope, connectionId(request), request.body)));
  app.post(`${base}/:connectionId/models/refresh`, async request => control(request, "discover", scope =>
    options.store.refreshModels(scope, connectionId(request), revision.parse(request.body).expectedRevision)));
  app.patch(`${base}/:connectionId`, { bodyLimit: 16384 }, async request => control(request, "reconnect", async scope => ({ connection: await options.store.update(scope, connectionId(request), request.body) })));
  app.post(`${base}/:connectionId/revoke`, async request => control(request, "disconnect", async scope => ({ connection: await options.store.revoke(scope, connectionId(request), revision.parse(request.body).expectedRevision) })));
  app.delete(`${base}/:connectionId`, async request => control(request, "disconnect", async scope => ({ connection: await options.store.revoke(scope, connectionId(request), revision.parse(request.body).expectedRevision, true) })));
}
