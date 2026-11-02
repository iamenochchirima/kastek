import type { FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import type { RequestContext } from "../identity/request-context.js";
import { bearerToken, optionalHeader, resolvePublicCredentialContext } from "../identity/request-context.js";
import { resolveGrowthOAuthContext } from "../oauth/index.js";
import { ApiError } from "../error.js";
import type { GrowthOperationDefinition } from "./types.js";

export function growthAgentAccessEnabled(core: CoreContext): boolean {
  return core.config.env.GROWTH_AGENT_ACCESS_ENABLED === "true" ||
    (core.config.environment !== "production" && core.config.env.GROWTH_AGENT_ACCESS_ENABLED !== "false");
}
export function requireGrowthAgentAccess(core: CoreContext) {
  if (!growthAgentAccessEnabled(core)) throw new ApiError(503, "agent_access_disabled", "Agent access is unavailable");
}
export async function resolveGrowthOperationContext(core: CoreContext, request: FastifyRequest, oauthOnly = false): Promise<RequestContext> {
  requireGrowthAgentAccess(core);
  const token = bearerToken(request);
  const oauth = token ? await resolveGrowthOAuthContext(core, token) : null;
  if (oauthOnly && !oauth) throw new ApiError(401, "oauth_required", "Connect to Growth with OAuth");
  const context = oauth ?? await resolvePublicCredentialContext(request, core);
  return { ...context, correlationId: optionalHeader(request, "x-correlation-id"), idempotencyKey: optionalHeader(request, "idempotency-key") };
}
/** Transport metadata is identical for MCP and embedded tools; domain schemas have one source. */
export function growthToolInputSchema(operation: GrowthOperationDefinition): Record<string, unknown> {
  const controls = {
    _continuation: { type: "string", minLength: 1, maxLength: 512, description: "Continuation returned by this same operation. Repeat unchanged business arguments to retrieve the next bounded result chunk." },
    ...(operation.effect === "read" ? {} : {
      _requestId: { type: "string", minLength: 8, maxLength: 240, description: "Stable request identity. Reuse it when resuming this exact action; never change it to retry an uncertain result." },
      _reviewId: { type: "string", minLength: 1, maxLength: 256, description: "Review ID returned by this action. Supply it with the same request identity and unchanged input after approval." },
    }),
  };
  const withControls = (schema: Record<string, unknown>): Record<string, unknown> => ({ ...schema,
    properties: { ...(schema.properties as Record<string, unknown> ?? {}), ...controls },
    ...(Array.isArray(schema.oneOf) ? { oneOf: schema.oneOf.map(branch => withControls(branch as Record<string, unknown>)) } : {}),
  });
  return withControls(operation.inputSchema);
}
export function growthToolArguments(input: Record<string, unknown>) {
  const { _requestId, _reviewId, _continuation, ...business } = input;
  if ((_requestId !== undefined && (typeof _requestId !== "string" || _requestId.length < 8 || _requestId.length > 240)) ||
      (_reviewId !== undefined && (typeof _reviewId !== "string" || !_reviewId || _reviewId.length > 256))) throw new ApiError(422, "operation_arguments_invalid", "Check the request or review identity");
  if (_continuation !== undefined && (typeof _continuation !== "string" || !_continuation || _continuation.length > 512)) throw new ApiError(422, "operation_arguments_invalid", "Check the continuation");
  return { input: business, requestId: _requestId as string | undefined, reviewId: _reviewId as string | undefined, continuation: _continuation as string | undefined };
}
