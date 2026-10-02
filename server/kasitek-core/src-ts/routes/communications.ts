import type { FastifyInstance, FastifyRequest } from "fastify";
import formbody from "@fastify/formbody";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { extractUser, resolveActiveOrgId } from "../identity/session.js";
import { canonicalJsonBody } from "../identity/json-body.js";
import { AgentPlatformClient } from "../services/agent-platform/client.js";
import * as calls from "../services/communications/calls.js";
export async function registerCommunicationsRoutes(
  app: FastifyInstance,
  core: CoreContext,
) {
  const org = async (request: FastifyRequest) => {
    const user = await extractUser(request, core);
    return { user, org: await resolveActiveOrgId(request, core, user.id) };
  };
  app.get("/api/calls", async (request) => ({
    calls: await calls.listCalls(core.pool, (await org(request)).org),
  }));
  app.get<{ Querystring: { days?: string } }>(
    "/api/calls/summary",
    async (request) => {
      const value = request.query.days;
      if (value !== undefined && typeof value !== "string")
        throw new ApiError(400, "bad_request", "Invalid request");
      let days = 7n;
      if (value !== undefined && /^[+-]?\d+$/.test(value)) {
        const parsed = BigInt(value);
        if (parsed >= -9223372036854775808n && parsed <= 9223372036854775807n)
          days = parsed;
      }
      return calls.callSummary(core.pool, (await org(request)).org, days);
    },
  );
  app.get("/api/calls/providers", async (request) => {
    await extractUser(request, core);
    return calls.providerStatus(core.config);
  });
  app.post("/api/calls/twilio/browser-token", async (request) => {
    const context = await org(request);
    return calls.createTwilioBrowserToken(
      core.config,
      context.org,
      context.user.id,
    );
  });
  app.post<{
    Body: { phoneNumber?: string | null; displayName?: string | null };
  }>(
    "/api/calls/providers/twilio/connections",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            phoneNumber: { type: ["string", "null"] },
            displayName: { type: ["string", "null"] },
          },
        },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await calls.createTwilioConnection(
            core.pool,
            (await org(request)).org,
            request.body,
          ),
        ),
  );
  await app.register(async (scope) => {
    // BTreeMap form decoding keeps the last repeated value. The global parser
    // returns arrays for repeated keys, so callbacks need their own parser.
    if (scope.hasContentTypeParser("application/x-www-form-urlencoded"))
      scope.removeContentTypeParser("application/x-www-form-urlencoded");
    await scope.register(formbody, {
      bodyLimit: 16 * 1024,
      parser: (str) => Object.fromEntries(new URLSearchParams(str)),
    });
    for (const action of ["voice", "status", "browser"] as const) {
      const path = `/api/webhooks/twilio/${action}`;
      scope.post<{ Body: Record<string, string> }>(
        path,
        async (request, reply) => {
          if (
            !request.headers["content-type"]
              ?.toLowerCase()
              .startsWith("application/x-www-form-urlencoded")
          )
            throw new ApiError(
              415,
              "unsupported_media_type",
              "Content type error",
            );
          const signature = request.headers["x-twilio-signature"];
          calls.verifyTwilioWebhook(
            core.config,
            path,
            request.body,
            typeof signature === "string" ? signature : undefined,
          );
          if (action === "browser")
            return reply
              .type("text/xml; charset=utf-8")
              .send(
                await calls.recordTwilioBrowserCall(
                  core.pool,
                  core.config,
                  request.body,
                ),
              );
          await calls.recordTwilioWebhook(core.pool, request.body);
          return action === "status"
            ? reply.code(204).send()
            : reply
                .type("text/xml; charset=utf-8")
                .send(calls.inboundTwiml(core.config));
        },
      );
    }
  });
  app.post<{ Params: { connectionId: string }; Body: unknown }>(
    "/api/webhooks/telegram/:connectionId",
    async (request) => {
      if (
        !/^application\/(?:json|[^;]+\+json)(?:;|$)/i.test(
          request.headers["content-type"] ?? "",
        )
      )
        throw new ApiError(400, "bad_request", "Content type error");
      const secret = request.headers["x-telegram-bot-api-secret-token"];
      await new AgentPlatformClient(core.config).forwardTelegramWebhook(
        request.params.connectionId.trim(),
        typeof secret === "string" ? secret : null,
        canonicalJsonBody(request),
      );
      return { ok: true };
    },
  );
}
