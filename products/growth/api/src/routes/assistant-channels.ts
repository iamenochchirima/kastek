import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CoreContext } from "../context.js";
import { extractUser, resolveActiveOrgId } from "../identity/session.js";
import { requireAdmin, requireMember } from "../services/orgs.js";
import {
  linkAssistantChannel,
  listAssistantChannels,
  unlinkAssistantChannel,
} from "../agents/assistant-channels.js";
import { growthAgentActor } from "../agents/security.js";

const provider = z.enum(["telegram", "whatsapp"]);
const linkBody = z.strictObject({
  provider,
  expectedRevision: z.number().int().positive().optional(),
});
const unlinkBody = z.strictObject({ provider });

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

export function registerAssistantChannelRoutes(
  app: FastifyInstance,
  core: CoreContext,
): void {
  app.get("/api/assistant/channels", async (request) => {
    const { user, orgId } = await scope(request, core, false);
    const canManage = await requireAdmin(core.pool, orgId, user.id).then(
      () => true,
      () => false,
    );
    return {
      ...(await listAssistantChannels(core, actor(core.config, user), orgId)),
      canManage,
    };
  });

  app.post<{ Params: { id: string } }>(
    "/api/assistant/channels/:id/link",
    async (request) => {
      const { user, orgId } = await scope(request, core);
      const body = linkBody.parse(request.body ?? {});
      return linkAssistantChannel(core, {
        actor: actor(core.config, user),
        orgId,
        userId: user.id,
        provider: body.provider,
        connectionId: request.params.id,
        expectedRevision: body.expectedRevision,
      });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/assistant/channels/:id/link",
    async (request) => {
      const { user, orgId } = await scope(request, core);
      const body = unlinkBody.parse(request.body ?? {});
      return unlinkAssistantChannel(core, {
        actor: actor(core.config, user),
        orgId,
        provider: body.provider,
        connectionId: request.params.id,
      });
    },
  );
}
