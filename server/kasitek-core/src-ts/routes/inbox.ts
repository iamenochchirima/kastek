import { parseSerdeValueJson } from "../json.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { extractUser, resolveActiveOrgId } from "../identity/session.js";
import * as inbox from "../services/inbox/index.js";
export function registerInboxRoutes(
  app: FastifyInstance,
  context: CoreContext,
  options: inbox.InboxOptions,
): void {
  async function scope(request: FastifyRequest) {
    const user = await extractUser(request, context),
      org = await resolveActiveOrgId(request, context, user.id);
    return { user, org };
  }
  app.get("/api/inbox/conversations", async (request) =>
    inbox.listInboxConversations(
      context.pool,
      (await scope(request)).org,
      options,
    ),
  );
  app.get<{ Params: { id: string } }>(
    "/api/inbox/:id/messages",
    async (request) =>
      inbox.listConversationMessages(
        context.pool,
        (await scope(request)).org,
        request.params.id,
        options,
      ),
  );
  app.post<{ Params: { id: string }; Body: inbox.SendMessageInput }>(
    "/api/inbox/:id/messages",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            text: { type: ["string", "null"] },
            replyToMessageId: { type: ["string", "null"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { user, org } = await scope(request);
      return reply
        .code(202)
        .send(
          await inbox.sendConversationMessage(
            context.pool,
            user.id,
            org,
            request.params.id,
            request.body,
            options,
          ),
        );
    },
  );
  app.post<{ Params: { id: string; message_id: string } }>(
    "/api/inbox/:id/messages/:message_id/retry",
    async (request, reply) => {
      const { user, org } = await scope(request);
      return reply
        .code(202)
        .send(
          await inbox.retryConversationMessage(
            context.pool,
            user.id,
            org,
            request.params.id,
            request.params.message_id,
            options,
          ),
        );
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/inbox/:id/read",
    async (request) => {
      const { user, org } = await scope(request);
      return inbox.markConversationRead(
        context.pool,
        user.id,
        org,
        request.params.id,
        options,
      );
    },
  );
  app.get<{ Params: { message_id: string; attachment_id: string } }>(
    "/api/inbox/messages/:message_id/attachments/:attachment_id",
    async (request, reply) => {
      const { org } = await scope(request),
        result = await inbox.downloadMessageAttachment(
          context.pool,
          org,
          request.params.message_id,
          request.params.attachment_id,
          options,
        );
      reply
        .header("Content-Type", result.contentType)
        .header("Content-Disposition", `inline; filename="${result.fileName}"`)
        .header("Cache-Control", result.cacheControl);
      if (result.mediaSource)
        reply.header("X-KasiTek-Media-Source", result.mediaSource);
      return reply.send(Buffer.from(result.bytes));
    },
  );
  app.get<{ Querystring: Record<string, string> }>(
    "/api/webhooks/meta",
    async (request) =>
      inbox.verifyMetaWebhookRequest(context.config, request.query),
  );
  void app.register(async (webhook) => {
    webhook.removeAllContentTypeParsers();
    webhook.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: 262_144 },
      (_request, body, done) => done(null, body),
    );
    webhook.post<{ Body: Buffer }>(
      "/api/webhooks/meta",
      { bodyLimit: 262_144 },
      async (request) => {
        const signature = request.headers["x-hub-signature-256"];
        inbox.verifyMetaWebhookSignature(
          context.config,
          typeof signature === "string" ? signature : undefined,
          request.body,
        );
        let payload: unknown;
        try {
          payload = parseSerdeValueJson(
            new TextDecoder("utf-8", { fatal: true }).decode(request.body),
          );
        } catch {
          throw new ApiError(
            400,
            "bad_request",
            "Invalid Meta webhook payload",
          );
        }
        await inbox.processMetaWebhookPayload(context.pool, payload, options);
        return { success: true };
      },
    );
  });
}
