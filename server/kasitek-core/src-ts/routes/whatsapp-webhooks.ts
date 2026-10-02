import { parseSerdeValueJson } from "../json.js";
import type { FastifyInstance } from "fastify";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { verifyMetaWebhookSignature } from "../services/inbox/meta-provider.js";
import {
  processWebhookPayload,
  type WhatsappWebhookOptions,
} from "../services/whatsapp/webhooks.js";
export function verifyWhatsappWebhookRequest(
  core: CoreContext,
  query: Record<string, string>,
): string {
  const mode = query["hub.mode"] ?? "",
    token = query["hub.verify_token"] ?? "",
    challenge = query["hub.challenge"] ?? "";
  if (mode !== "subscribe" || !challenge)
    throw new ApiError(400, "bad_request", "Invalid verification request");
  if (token !== (core.config.rawEnv.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? ""))
    throw new ApiError(403, "forbidden", "Invalid verify token");
  return challenge;
}
export async function registerWhatsappWebhookRoutes(
  app: FastifyInstance,
  core: CoreContext,
  options: WhatsappWebhookOptions,
): Promise<void> {
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "*",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
    scope.get("/api/webhooks/whatsapp", async (request, reply) =>
      reply
        .type("text/plain")
        .send(
          verifyWhatsappWebhookRequest(
            core,
            (request.query ?? {}) as Record<string, string>,
          ),
        ),
    );
    scope.post("/api/webhooks/whatsapp", async (request) => {
      const raw = request.body;
      if (!Buffer.isBuffer(raw))
        throw new ApiError(
          400,
          "bad_request",
          "Invalid WhatsApp webhook payload",
        );
      const signature = request.headers["x-hub-signature-256"];
      verifyMetaWebhookSignature(
        core.config,
        typeof signature === "string" ? signature : undefined,
        raw,
      );
      let payload: unknown;
      try {
        payload = parseSerdeValueJson(
          new TextDecoder("utf-8", { fatal: true }).decode(raw),
        );
      } catch {
        throw new ApiError(
          400,
          "bad_request",
          "Invalid WhatsApp webhook payload",
        );
      }
      await processWebhookPayload(core.pool, core.config, payload, options);
      return { success: true, queued: false };
    });
  });
}
