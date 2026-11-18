import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

type Scope = { accountId: string; organizationId: string };

/** Organization assistant and member-channel routes. Paths and payloads stay unchanged. */
export function registerAssistantRoutes(app: FastifyInstance, options: {
  assistant: {
    getOrganizationAssistant(accountId: string, organizationId: string): Promise<unknown>;
    repairOrganizationAssistant(accountId: string, organizationId: string): Promise<unknown>;
  };
  memberChannels: {
    list(scope: Scope): Promise<unknown>;
    challenge(scope: Scope, raw: unknown): Promise<unknown>;
    confirm(scope: Scope, linkId: string): Promise<unknown>;
    revoke(scope: Scope, linkId: string): Promise<unknown>;
  };
  resolveScope(request: FastifyRequest): Promise<Scope>;
}) {
  const uuid = z.uuid();
  const base = "/api/organizations/:organizationId";
  const parameters = (request: FastifyRequest) => request.params as Record<string, string>;

  app.get(`${base}/assistant`, async request => {
    const scope = await options.resolveScope(request);
    return options.assistant.getOrganizationAssistant(scope.accountId, scope.organizationId);
  });

  app.post(`${base}/assistant/repair`, async request => {
    z.strictObject({}).parse(request.body ?? {});
    const scope = await options.resolveScope(request);
    return options.assistant.repairOrganizationAssistant(scope.accountId, scope.organizationId);
  });

  app.get(`${base}/member-channels`, async request => options.memberChannels.list(await options.resolveScope(request)));

  app.post(`${base}/member-channels/challenges`, async request =>
    options.memberChannels.challenge(await options.resolveScope(request), request.body));

  app.post(`${base}/member-channels/:linkId/confirm`, async request => {
    z.strictObject({}).parse(request.body ?? {});
    return options.memberChannels.confirm(await options.resolveScope(request), uuid.parse(parameters(request).linkId));
  });

  app.delete(`${base}/member-channels/:linkId`, async request =>
    options.memberChannels.revoke(await options.resolveScope(request), uuid.parse(parameters(request).linkId)));
}
