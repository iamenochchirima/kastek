import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import { extractUser, resolveActiveOrgId } from "../identity/session.js";
import * as inbox from "../services/whatsapp/inbox.js";

const string = { type: ["string", "null"] },
  boolean = { type: ["boolean", "null"] };
const body = (properties: Record<string, unknown>) => ({
  body: { type: "object", properties },
});
export function registerWhatsappInboxRoutes(
  app: FastifyInstance,
  context: CoreContext,
  options: inbox.InboxDeliveryOptions = inbox.createInboxDeliveryOptions(
    context,
  ),
): void {
  const prefix = "/api/whatsapp/inbox";
  async function scope(request: FastifyRequest) {
    const user = await extractUser(request, context),
      org = await resolveActiveOrgId(request, context, user.id);
    return { userId: user.id, orgId: org };
  }
  const params = (request: FastifyRequest) =>
    request.params as { id: string; message_id: string; attachment_id: string };
  app.get(`${prefix}/conversations`, async (request) =>
    inbox.listInboxConversations(context.pool, (await scope(request)).orgId),
  );
  app.post<{ Body: inbox.StartConversationInput }>(
    `${prefix}/conversations`,
    {
      schema: body({
        connectionId: string,
        templateId: string,
        phone: string,
        customerName: string,
        bodyParameters: { type: ["array", "null"], items: { type: "string" } },
      }),
    },
    async (request) => {
      const s = await scope(request);
      return inbox.startInboxConversation(
        context,
        s.userId,
        s.orgId,
        request.body,
        options,
      );
    },
  );
  app.get(`${prefix}/unread-count`, async (request) =>
    inbox.inboxUnreadCount(context.pool, (await scope(request)).orgId),
  );
  app.get(`${prefix}/:id/messages`, async (request) =>
    inbox.listConversationMessages(
      context.pool,
      (await scope(request)).orgId,
      params(request).id,
    ),
  );
  app.patch<{ Body: { starred?: boolean | null } }>(
    `${prefix}/:id`,
    { schema: body({ starred: boolean }) },
    async (request) => {
      const s = await scope(request);
      return inbox.updateConversation(
        context,
        s.userId,
        s.orgId,
        params(request).id,
        request.body,
        options,
      );
    },
  );
  app.delete(`${prefix}/:id`, async (request) =>
    inbox.deleteConversation(
      context,
      (await scope(request)).orgId,
      params(request).id,
    ),
  );
  app.post<{
    Body: { text?: string | null; replyToMessageId?: string | null };
  }>(
    `${prefix}/:id/messages`,
    { schema: body({ text: string, replyToMessageId: string }) },
    async (request, reply) => {
      const s = await scope(request);
      return reply
        .code(202)
        .send(
          await inbox.sendConversationMessage(
            context,
            s.userId,
            s.orgId,
            params(request).id,
            request.body,
            options,
          ),
        );
    },
  );
  app.post(`${prefix}/:id/messages/media`, async (request) => {
    const s = await scope(request);
    return inbox.sendConversationMedia(
      context,
      s.userId,
      s.orgId,
      params(request).id,
      await inbox.readWhatsappMultipart(request),
      options,
    );
  });
  app.post(`${prefix}/:id/read`, async (request) => {
    const s = await scope(request);
    return inbox.markConversationRead(
      context,
      s.userId,
      s.orgId,
      params(request).id,
      options,
    );
  });
  app.post<{ Body: { emoji?: string | null; remove?: boolean | null } }>(
    `${prefix}/:id/messages/:message_id/reaction`,
    { schema: body({ emoji: string, remove: boolean }) },
    async (request) =>
      inbox.sendMessageReaction(
        context,
        (await scope(request)).orgId,
        params(request).id,
        params(request).message_id,
        request.body,
        options,
      ),
  );
  app.delete(`${prefix}/:id/messages/:message_id`, async (request) =>
    inbox.deleteConversationMessage(
      context,
      (await scope(request)).orgId,
      params(request).id,
      params(request).message_id,
    ),
  );
  app.get(
    `${prefix}/media/:message_id/attachments/:attachment_id`,
    async (request, reply) => {
      const download = await inbox.downloadMessageAttachment(
        context.pool,
        (await scope(request)).orgId,
        params(request).message_id,
        params(request).attachment_id,
        options,
      );
      return reply
        .header("content-type", download.contentType)
        .header(
          "content-disposition",
          `inline; filename="${download.fileName}"`,
        )
        .header("cache-control", download.cacheControl)
        .send(Buffer.from(download.bytes));
    },
  );
}
