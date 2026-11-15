import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CoreContext } from "../context.js";
import { extractUser, resolveActiveOrgId } from "../identity/session.js";
import { requireAdmin, requireMember } from "../services/orgs.js";
import { requestGrowthChannelAdmin } from "../agents/channel-admin-client.js";
import { growthAgentActor } from "../agents/security.js";
import { syncTelegramProjection } from "../agents/telegram-projection.js";

const botToken = z.string().regex(/^\d+:[A-Za-z0-9_-]{1,256}$/);
const connectionName = z.string().trim().min(1).max(120);
const connectionId = z.string().uuid();
const expectedRevision = z.number().int().positive();
const connectBody = z.strictObject({ name: connectionName, botToken });
const revisionBody = z.strictObject({ expectedRevision });
const rotateBody = z.strictObject({ expectedRevision, botToken });

function actor(config: CoreContext["config"], user: { id: string }) {
  return growthAgentActor(config, user.id);
}

async function scope(request: FastifyRequest, core: CoreContext, manage = true) {
  const user = await extractUser(request, core);
  const orgId = await resolveActiveOrgId(request, core, user.id);
  if (manage) await requireAdmin(core.pool, orgId, user.id);
  else await requireMember(core.pool, orgId, user.id);
  return { user, orgId };
}

export function registerTelegramConnectionRoutes(
  app: FastifyInstance,
  core: CoreContext,
): void {
  app.get("/api/telegram/connections", async (request) => {
    const { user, orgId } = await scope(request, core, false);
    const canManage = await requireAdmin(core.pool, orgId, user.id).then(
      () => true,
      () => false,
    );
    const result = await requestGrowthChannelAdmin(core.config, {
      version: "1",
      requestId: randomUUID(),
      operation: "channel.list",
      actor: actor(core.config, user),
      growthOrganizationId: orgId,
    });
    await syncTelegramProjection(core.pool, orgId, result.connections ?? [], {
      prune: true,
    });
    return { connections: result.connections ?? [], canManage };
  });

  app.post("/api/telegram/connections", async (request, reply) => {
    const { user, orgId } = await scope(request, core);
    const body = connectBody.parse(request.body ?? {});
    const result = await requestGrowthChannelAdmin(core.config, {
      version: "1",
      requestId: randomUUID(),
      operation: "telegram.connect",
      actor: actor(core.config, user),
      growthOrganizationId: orgId,
      name: body.name,
      botToken: body.botToken,
    });
    if (result.connection)
      await syncTelegramProjection(core.pool, orgId, [result.connection]);
    return reply.code(201).send({
      connection: result.connection,
      status: result.status,
    });
  });

  app.post<{ Params: { id: string } }>(
    "/api/telegram/connections/:id/health",
    async (request) => {
      const { user, orgId } = await scope(request, core);
      const body = revisionBody.parse(request.body ?? {});
      const result = await requestGrowthChannelAdmin(core.config, {
        version: "1",
        requestId: randomUUID(),
        operation: "telegram.health",
        actor: actor(core.config, user),
        growthOrganizationId: orgId,
        connectionId: connectionId.parse(request.params.id),
        expectedRevision: body.expectedRevision,
      });
      if (result.connection)
        await syncTelegramProjection(core.pool, orgId, [result.connection]);
      return { connection: result.connection, status: result.status };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/telegram/connections/:id/rotate",
    async (request) => {
      const { user, orgId } = await scope(request, core);
      const body = rotateBody.parse(request.body ?? {});
      const result = await requestGrowthChannelAdmin(core.config, {
        version: "1",
        requestId: randomUUID(),
        operation: "telegram.rotate",
        actor: actor(core.config, user),
        growthOrganizationId: orgId,
        connectionId: connectionId.parse(request.params.id),
        expectedRevision: body.expectedRevision,
        botToken: body.botToken,
      });
      if (result.connection)
        await syncTelegramProjection(core.pool, orgId, [result.connection]);
      return { connection: result.connection, status: result.status };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/telegram/connections/:id/disconnect",
    async (request) => {
      const { user, orgId } = await scope(request, core);
      const body = revisionBody.parse(request.body ?? {});
      const result = await requestGrowthChannelAdmin(core.config, {
        version: "1",
        requestId: randomUUID(),
        operation: "telegram.disconnect",
        actor: actor(core.config, user),
        growthOrganizationId: orgId,
        connectionId: connectionId.parse(request.params.id),
        expectedRevision: body.expectedRevision,
      });
      if (result.connection)
        await syncTelegramProjection(core.pool, orgId, [result.connection]);
      return { connection: result.connection, status: result.status };
    },
  );
}
