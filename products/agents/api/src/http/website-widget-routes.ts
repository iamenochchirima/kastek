import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { runWithRequiredDatabaseContext } from "../db/context";
import type { WebsiteVisitorRepository } from "../db/repositories/website-visitor-repository";
import type { PlatformChatRepository } from "../db/repositories/platform-chat-repository";
import type { ConversationRepository } from "../db/repositories/conversation-repository";
import { normalizeWebsiteOrigin } from "./website-deployment-routes";
import { WEBSITE_WIDGET_LOADER, WEBSITE_WIDGET_FRAME } from "../website/assets";

const prefix = "/api/widget/v1";
const unavailable = () => Object.assign(new Error("Website chat is unavailable or this visitor session has expired"), { statusCode: 401 });

export function registerWebsiteWidgetRoutes(app: FastifyInstance, dependencies: {
  visitors: WebsiteVisitorRepository;
  chat: Pick<PlatformChatRepository, "acceptExternalMessage">;
  conversations: Pick<ConversationRepository, "listMessages">;
  dispatch?: (runId: string) => Promise<unknown>;
}) {
  const discover = <T>(operation: () => Promise<T>) => runWithRequiredDatabaseContext("website-visitor-discovery",
    { organizationId: "platform", actorId: "system:website-visitor-discovery", operator: true }, operation);
  function origin(request: FastifyRequest, reply: FastifyReply) {
    if (typeof request.headers.origin !== "string") throw unavailable();
    const value = normalizeWebsiteOrigin(request.headers.origin);
    reply.header("access-control-allow-origin", value).header("vary", "Origin").header("cache-control", "no-store");
    return value;
  }
  async function deployment(request: FastifyRequest, reply: FastifyReply) {
    const publicId = z.uuid().parse((request.params as { publicId: string }).publicId);
    const websiteOrigin = origin(request, reply);
    const row = await discover(() => dependencies.visitors.findDeployment(publicId, websiteOrigin));
    if (!row) throw unavailable();
    return { row, websiteOrigin };
  }
  async function session(request: FastifyRequest, reply: FastifyReply) {
    const sessionId = z.uuid().parse((request.params as { sessionId: string }).sessionId);
    const websiteOrigin = origin(request, reply), authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) throw unavailable();
    const admitted = await discover(() => dependencies.visitors.authenticate(sessionId, authorization.slice(7), websiteOrigin));
    if (!admitted) throw unavailable();
    return admitted;
  }
  const scope = <T>(organizationId: string, actorId: string, operation: () => Promise<T>) =>
    runWithRequiredDatabaseContext("website-visitor-request", { organizationId, actorId }, operation);

  app.get(`${prefix}/loader.js`, async (_request, reply) => reply.type("application/javascript; charset=utf-8").send(WEBSITE_WIDGET_LOADER));
  app.get(`${prefix}/frame.html`, async (_request, reply) => reply.type("text/html; charset=utf-8").send(WEBSITE_WIDGET_FRAME));
  // Preflight carries no visitor token. Actual handlers enforce deployment/session origin.
  for (const path of ["/deployments/:publicId", "/deployments/:publicId/sessions", "/sessions/:sessionId/messages", "/sessions/:sessionId/conversation", "/sessions/:sessionId/events/stream"]) {
    app.options(`${prefix}${path}`, async (request, reply) => {
      origin(request, reply);
      return reply.header("access-control-allow-methods", "GET, POST, OPTIONS")
        .header("access-control-allow-headers", "Authorization, Content-Type").code(204).send();
    });
  }
  app.get(`${prefix}/deployments/:publicId`, async (request, reply) => {
    const { row } = await deployment(request, reply);
    return { publicId: row.public_id, ...row.configuration };
  });
  app.post(`${prefix}/deployments/:publicId/sessions`, async (request, reply) => {
    const { row, websiteOrigin } = await deployment(request, reply);
    z.object({}).strict().parse(request.body ?? {});
    const { session: created, token } = await scope(row.organization_id, `website:${row.public_id}`,
      () => dependencies.visitors.create(row, websiteOrigin));
    return reply.code(201).send({ sessionId: created.id, token, expiresAt: created.expires_at });
  });
  app.post(`${prefix}/sessions/:sessionId/messages`, async (request, reply) => {
    const admitted = await session(request, reply);
    const input = z.object({ text: z.string().trim().min(1).max(20_000), idempotencyKey: z.string().trim().min(8).max(240) }).strict().parse(request.body);
    if (!dependencies.dispatch) return reply.code(503).send({ error: "Website agent execution is not configured" });
    return scope(admitted.session.organization_id, `website:${admitted.session.id}`, async () => {
      const accepted = await dependencies.chat.acceptExternalMessage({
        organizationId: admitted.session.organization_id, installationId: admitted.deployment.installation_id,
        channelType: "website", channelKey: admitted.deployment.public_id, provider: "kasitek-website",
        providerEventId: `${admitted.session.id}:${input.idempotencyKey}`, providerMessageId: `${admitted.session.id}:${input.idempotencyKey}`,
        externalIdentity: admitted.session.id, externalConversationId: admitted.session.id,
        messageType: "text", content: { text: input.text }, displayName: "Website visitor",
      });
      await dependencies.visitors.attachConversation(admitted.session, accepted.conversation.id);
      if (accepted.created && accepted.run?.status === "received") await dependencies.dispatch!(accepted.run.id);
      return reply.code(accepted.created ? 202 : 200).send({ messageId: accepted.message.id,
        runId: accepted.run?.id ?? null, status: accepted.handoffActive ? "handoff_active" : accepted.run?.status ?? "received" });
    });
  });
  async function readConversation(admitted: NonNullable<Awaited<ReturnType<WebsiteVisitorRepository["authenticate"]>>>) {
    return scope(admitted.session.organization_id, `website:${admitted.session.id}`, async () => {
      const rows = admitted.session.conversation_id
        ? await dependencies.conversations.listMessages(admitted.session.organization_id, admitted.session.conversation_id) : [];
      const messages = rows.filter(row => row.message_type === "text"
        && (row.direction === "inbound" || row.direction === "outbound" && ["sent", "delivered", "read"].includes(row.delivery_status ?? "")))
        .map(row => ({ id: row.id, direction: row.direction, text: typeof row.content.text === "string" ? row.content.text : "", sequence: row.sequence_number }));
      return { messages, run: await dependencies.visitors.latestRun(admitted.session) };
    });
  }
  app.get(`${prefix}/sessions/:sessionId/conversation`, async (request, reply) => {
    return readConversation(await session(request, reply));
  });
  app.get(`${prefix}/sessions/:sessionId/events/stream`, async (request, reply) => {
    let admitted = await session(request, reply);
    const input = z.object({ after: z.string().regex(/^\d{1,20}$/).default("0") }).parse(request.query);
    let cursor = BigInt(input.after), closed = false, busy = false, lastRun = "";
    const websiteOrigin = admitted.session.origin;
    const sessionId = admitted.session.id, token = request.headers.authorization!.slice(7);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store",
      "access-control-allow-origin": websiteOrigin, "vary": "Origin", "x-accel-buffering": "no" });
    reply.raw.write(": connected\n\n");
    const timer = setInterval(() => void tick(), 1500);
    const lifetime = setTimeout(() => finish(), 60_000);
    function finish() {
      if (closed) return;
      closed = true; clearInterval(timer); clearTimeout(lifetime); reply.raw.end();
    }
    reply.raw.on("close", finish);
    async function tick() {
      if (closed || busy) return;
      busy = true;
      try {
        const current = await discover(() => dependencies.visitors.authenticate(sessionId, token, websiteOrigin));
        if (!current) {
          reply.raw.write(`event: unavailable\ndata: ${JSON.stringify({ error: "Website chat is paused or this session has expired" })}\n\n`);
          finish(); return;
        }
        admitted = current;
        const result = await readConversation(admitted);
        const messages = result.messages.filter(message => BigInt(message.sequence) > cursor);
        if (messages.length) cursor = messages.reduce((highest, message) => BigInt(message.sequence) > highest ? BigInt(message.sequence) : highest, cursor);
        const runState = JSON.stringify(result.run);
        if (messages.length || runState !== lastRun) {
          reply.raw.write(`id: ${cursor}\nevent: conversation\ndata: ${JSON.stringify({ messages, run: result.run })}\n\n`);
          lastRun = runState;
        } else reply.raw.write(": keep-alive\n\n");
      } catch {
        if (!closed) reply.raw.write(`event: unavailable\ndata: ${JSON.stringify({ error: "Website chat connection interrupted", retryable: true })}\n\n`);
        finish();
      } finally { busy = false; }
    }
    await tick();
  });
}
