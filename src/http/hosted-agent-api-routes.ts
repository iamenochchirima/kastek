import type { FastifyInstance, HTTPMethods } from "fastify";
import { z } from "zod";
import { enterDatabaseContext, runWithRequiredDatabaseContext } from "../db/context";
import type { HostedAgentApiKeyRepository } from "../db/repositories/hosted-agent-api-key-repository";
import type { RunRepository } from "../db/repositories/run-repository";
import type { ConversationRepository } from "../db/repositories/conversation-repository";
import { admitInstallationApiRequest, installationApiAuthContext } from "./auth";

const routes: [HTTPMethods, string, string][] = [
  ["POST", "/v1/installations/:installationId/platform/conversation/new", "/api/v1/agent/conversations"],
  ["POST", "/v1/installations/:installationId/platform/messages", "/api/v1/agent/messages"],
  ["GET", "/v1/conversations/:conversationId", "/api/v1/agent/conversations/:conversationId"],
  ["GET", "/v1/runs/:runId", "/api/v1/agent/runs/:runId"],
  ["GET", "/v1/runs/:runId/events/stream", "/api/v1/agent/runs/:runId/events/stream"],
  ["POST", "/v1/runs/:runId/cancel", "/api/v1/agent/runs/:runId/cancel"],
];
const denied = () => Object.assign(new Error("Agent API key is invalid, expired, revoked or inactive"), { statusCode: 401 });

/** Explicit aliases reuse product admission and run handlers without opening /v1. */
export function registerHostedAgentApiRoutes(app: FastifyInstance, dependencies: {
  keys: Pick<HostedAgentApiKeyRepository, "authenticate" | "recordUse">;
  runs: Pick<RunRepository, "getRun">;
  conversations: Pick<ConversationRepository, "getConversation">;
}): void {
  const registered = new Set<string>();
  app.addHook("onRoute", options => {
    const methods = Array.isArray(options.method) ? options.method : [options.method];
    for (const [method, source, url] of routes) {
      if (source !== options.url || !methods.includes(method) || registered.has(`${method} ${url}`)) continue;
      registered.add(`${method} ${url}`);
      app.route({ ...options, method, url,
        onRequest: [...(options.onRequest ? Array.isArray(options.onRequest) ? options.onRequest : [options.onRequest] : []),
          async (request, reply) => {
            reply.header("cache-control", "no-store");
            // These credentials are for a trusted server. Website sessions have separate admission.
            if (request.headers.origin || request.headers["sec-fetch-site"]) {
              throw Object.assign(new Error("Use an agent API key from your server"), { statusCode: 403 });
            }
            const authorization = request.headers.authorization;
            if (!authorization?.startsWith("Bearer ")) throw denied();
            const secret = authorization.slice(7);
            const authenticate = () => runWithRequiredDatabaseContext("hosted-api-key-authentication",
              { organizationId: "platform", actorId: "system:hosted-api-key-authentication", operator: true },
              () => dependencies.keys.authenticate(secret));
            const key = await authenticate();
            if (!key) throw denied();
            const context = { organizationId: key.organization_id, actorId: key.created_by, operator: false,
              scopes: ["chat:read", "chat:write", "runs:read", "runs:cancel"] };
            enterDatabaseContext(context);
            await runWithRequiredDatabaseContext("hosted-api-key-use", context, () => dependencies.keys.recordUse(key));
            admitInstallationApiRequest(request, context, async () => {
              const active = await authenticate();
              if (!active || active.id !== key.id) throw denied();
            });
            (request.params as Record<string, string>).installationId = key.installation_id;
            const params = request.params as Record<string, string>;
            if (params.runId) {
              z.string().uuid().parse(params.runId);
              const run = await runWithRequiredDatabaseContext("hosted-api-key-run-read", context, () => dependencies.runs.getRun(key.organization_id, params.runId!));
              if (!run || run.installation_id !== key.installation_id) throw Object.assign(new Error("Run not found"), { statusCode: 404 });
            }
            if (params.conversationId) await requireConversation(key.organization_id, key.installation_id, params.conversationId);
          }],
        preValidation: [...(options.preValidation ? Array.isArray(options.preValidation) ? options.preValidation : [options.preValidation] : []),
          async request => {
            if (method !== "POST") return;
            const params = request.params as Record<string, string>;
            if (source.endsWith("/platform/messages")) {
              const body = z.object({ message: z.string().trim().min(1).max(20_000),
                idempotencyKey: z.string().trim().min(8).max(240), conversationId: z.string().uuid().optional(),
                createNew: z.literal(true).optional() }).strict().parse(request.body);
              // Keep every public message attached to a persisted chat/session.
              if (Boolean(body.conversationId) === Boolean(body.createNew)) throw Object.assign(new Error("Choose conversationId or createNew=true"), { statusCode: 400 });
              const context = installationApiAuthContext(request)!;
              if (body.conversationId) await requireConversation(context.organizationId, params.installationId!, body.conversationId);
              request.body = body;
            } else {
              request.body = z.object({}).strict().parse(request.body ?? {});
            }
          }],
      });
    }
  });

  async function requireConversation(organizationId: string, installationId: string, conversationId: string) {
    z.string().uuid().parse(conversationId);
    const conversation = await runWithRequiredDatabaseContext("hosted-api-conversation-check",
      { organizationId, actorId: "system:hosted-api-conversation-check" },
      () => dependencies.conversations.getConversation(organizationId, conversationId));
    if (!conversation || conversation.installation_id !== installationId) throw Object.assign(new Error("Conversation not found"), { statusCode: 404 });
  }
}
