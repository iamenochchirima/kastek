import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import { extractUser, resolveActiveOrgId } from "../identity/session.js";
import { requireAdmin } from "../services/orgs.js";
import {
  listApiKeys,
  createApiKey,
  revokeApiKey,
  rotateApiKey,
} from "../services/public-api.js";
import { ApiError } from "../error.js";
import { growthAgentAccessEnabled } from "../operations/transport.js";
export function registerDeveloperRoutes(
  app: FastifyInstance,
  context: CoreContext,
): void {
  async function admin(request: FastifyRequest) {
    const user = await extractUser(request, context),
      org = await resolveActiveOrgId(request, context, user.id);
    await requireAdmin(context.pool, org, user.id);
    return { org, user };
  }
  app.get("/api/developers", async (request) => {
    const { org } = await admin(request);
    return {
      apiKeys: await listApiKeys(context.pool, org),
      config: {
        restBaseUrl: `${context.config.publicApiUrl.replace(/\/+$/, "")}/v1`,
        mcpAvailable: growthAgentAccessEnabled(context),
        mcpEndpoint: growthAgentAccessEnabled(context) ? `${context.config.publicApiUrl}/mcp` : null,
        mcpOAuth: true,
        mcpPackage: null,
        clients: [],
      },
    };
  });
  app.post("/api/developers/api-keys", async (request, reply) => {
    const { org, user } = await admin(request),
      input = request.body as { name?: unknown; expiresAt?: unknown; scopes?: unknown } | null;
    if (typeof input?.name !== "string")
      throw new ApiError(400, "bad_request", "API key name is required");
    let expiry: Date | null = null;
    if (input.expiresAt != null) {
      if (
        typeof input.expiresAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.expiresAt) ||
        !Number.isFinite(Date.parse(input.expiresAt))
      )
        throw new ApiError(400, "bad_request", "Invalid API key expiry");
      expiry = new Date(input.expiresAt);
    }
    return reply
      .code(201)
      .send(await createApiKey(context.pool, org, user.id, input.name, expiry, input.scopes as string[] | undefined));
  });
  app.delete("/api/developers/api-keys/:id", async (request, reply) => {
    const { org } = await admin(request);
    await revokeApiKey(
      context.pool,
      org,
      (request.params as { id: string }).id,
    );
    return reply.code(204).send();
  });
  app.post("/api/developers/api-keys/:id/rotate", async (request, reply) => {
    const { org, user } = await admin(request);
    return reply
      .code(201)
      .send(
        await rotateApiKey(
          context.pool,
          org,
          user.id,
          (request.params as { id: string }).id,
        ),
      );
  });
}
