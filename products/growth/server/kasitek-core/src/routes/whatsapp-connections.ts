import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import { extractUser, resolveActiveOrgId } from "../identity/session.js";
import { requireAdmin } from "../services/orgs.js";
import type { ProviderOptions } from "../services/whatsapp/common.js";
import { bad } from "../services/whatsapp/common.js";
import * as connections from "../services/whatsapp/connections.js";

const nullableString = { type: ["string", "null"] };
type IdParams = { id: string };
export function registerWhatsappConnectionRoutes(
  app: FastifyInstance,
  core: CoreContext,
  options: ProviderOptions = { config: core.config },
): void {
  const scope = async (request: FastifyRequest, admin = true) => {
    const user = await extractUser(request, core);
    const orgId = await resolveActiveOrgId(request, core, user.id);
    if (admin) await requireAdmin(core.pool, orgId, user.id);
    return { userId: user.id, orgId };
  };
  app.get("/api/whatsapp/connections", async (request) => {
    const { orgId } = await scope(request, false);
    return {
      connections: await connections.listWhatsappConnections(core.pool, orgId),
    };
  });
  app.post<{
    Body: {
      wabaId?: string | null;
      phoneNumberId?: string | null;
      accessToken?: string | null;
      phoneDisplayNumber?: string | null;
    };
  }>(
    "/api/whatsapp/connections",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            wabaId: nullableString,
            phoneNumberId: nullableString,
            accessToken: nullableString,
            phoneDisplayNumber: nullableString,
          },
        },
      },
    },
    async (request, reply) => {
      const { userId, orgId } = await scope(request);
      const body = request.body;
      return reply
        .code(201)
        .send(
          await connections.connectManualConnection(
            core.pool,
            userId,
            orgId,
            body.wabaId ?? "",
            body.phoneNumberId ?? "",
            body.accessToken ?? "",
            body.phoneDisplayNumber ?? null,
            options,
          ),
        );
    },
  );
  app.post<{
    Body: {
      code?: string | null;
      wabaId?: string | null;
      phoneNumberId?: string | null;
    };
  }>(
    "/api/whatsapp/onboarding/complete",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            code: nullableString,
            wabaId: nullableString,
            phoneNumberId: nullableString,
          },
        },
      },
    },
    async (request) => {
      const { userId, orgId } = await scope(request);
      const code = request.body.code?.trim();
      if (!code) throw bad("Missing embedded signup code");
      return connections.completeEmbeddedSignup(
        core.pool,
        userId,
        orgId,
        code,
        request.body.wabaId ?? null,
        request.body.phoneNumberId ?? null,
        options,
      );
    },
  );
  app.post<{ Params: IdParams; Body: { accessToken?: string | null } }>(
    "/api/whatsapp/connections/:id/token",
    {
      schema: {
        body: { type: "object", properties: { accessToken: nullableString } },
      },
    },
    async (request) => {
      const { orgId } = await scope(request);
      return connections.updateWhatsappAccessToken(
        core.pool,
        orgId,
        request.params.id,
        request.body.accessToken ?? "",
        options,
      );
    },
  );
  app.post<{ Params: IdParams }>(
    "/api/whatsapp/connections/:id/refresh",
    async (request) => {
      const { orgId } = await scope(request);
      return connections.refreshWhatsappConnection(
        core.pool,
        orgId,
        request.params.id,
        options,
      );
    },
  );
  app.get<{ Params: IdParams }>(
    "/api/whatsapp/connections/:id/health",
    async (request) => {
      const { orgId } = await scope(request);
      return connections.whatsappConnectionHealth(
        core.pool,
        orgId,
        request.params.id,
        options,
      );
    },
  );
}
