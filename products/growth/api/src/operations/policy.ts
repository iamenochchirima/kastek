import type { CoreContext } from "../context.js";
import type { RequestContext } from "../identity/request-context.js";
import { ApiError } from "../error.js";
import { requireCapability } from "../services/billing.js";
import { requireMember, requireAdmin } from "../services/orgs.js";
import { getGrowthOperation, growthOperations } from "./catalog.js";
import type { GrowthOperationDefinition } from "./types.js";

export function growthOperationHasScope(context: RequestContext, operation: GrowthOperationDefinition): boolean {
  if (context.apiScopes === null) return context.principal.kind === "direct_user" || context.principal.kind === "trusted_internal_service";
  return context.apiScopes.has(operation.scope)
    || (operation.effect === "read" && context.apiScopes.has("api:read"))
    || (operation.effect === "draft" && context.apiScopes.has("api:write"));
}
/** A grant resolved earlier in the request may have been narrowed or revoked before admission. */
async function currentCredentialContext(core: CoreContext, context: RequestContext): Promise<RequestContext> {
  if (!["direct_user", "trusted_internal_service", "workspace_api_key", "oauth_user"].includes(context.principal.kind))
    throw new ApiError(403, "operation_actor_denied", "This principal cannot invoke Growth operations");
  let scopes: string[] | undefined;
  if (context.principal.kind === "oauth_user") {
    const row = (await core.pool.query<{ scopes: string[] }>(`SELECT scopes FROM "GrowthOAuthConnection" WHERE id=$1 AND "orgId"=$2 AND "userId"=$3
      AND "clientId"=$4 AND resource=$5 AND "revokedAt" IS NULL AND "accessExpiresAt">now()`,
    [context.principal.id, context.organizationId, context.userId, context.principal.clientId, `${core.config.publicApiUrl}/mcp`])).rows[0];
    if (!row) throw new ApiError(401, "operation_credential_revoked", "The agent connection expired or was revoked");
    scopes = row.scopes;
  } else if (context.principal.kind === "workspace_api_key") {
    const row = (await core.pool.query<{ scopes: string[] }>(`SELECT scopes FROM "DeveloperApiKey" WHERE id=$1 AND "orgId"=$2 AND "createdById"=$3
      AND status='ACTIVE' AND ("expiresAt" IS NULL OR "expiresAt">now())`,
    [context.principal.id, context.organizationId, context.userId ?? context.principal.subjectUserId])).rows[0];
    if (!row) throw new ApiError(401, "operation_credential_revoked", "The Developer API key expired or was revoked");
    scopes = row.scopes;
  }
  if (!scopes) return context;
  return { ...context, apiScopes: new Set(scopes.filter(scope => context.apiScopes?.has(scope))) };
}
export async function authorizeGrowthOperation(core: CoreContext, context: RequestContext, operation: GrowthOperationDefinition | string, options: { discovery?: boolean } = {}): Promise<GrowthOperationDefinition> {
  const definition = typeof operation === "string" ? getGrowthOperation(operation) : getGrowthOperation(operation.name);
  context = await currentCredentialContext(core, context);
  if (!growthOperationHasScope(context, definition)) throw new ApiError(403, "operation_scope_denied", "The connection does not permit this operation");
  const userId = context.userId ?? context.principal.subjectUserId;
  if (!userId) throw new ApiError(403, "operation_actor_denied", "A delegated workspace user is required");
  await requireMember(core.pool, context.organizationId, userId);
  if (definition.effect === "destructive") await requireAdmin(core.pool, context.organizationId, userId);
  for (const entitlement of definition.requiredEntitlements) await requireCapability(core.pool, context.organizationId, entitlement);
  if (!options.discovery && definition.idempotency === "required" && (!context.idempotencyKey || Buffer.byteLength(context.idempotencyKey) < 8 || Buffer.byteLength(context.idempotencyKey) > 240))
    throw new ApiError(400, "operation_identity_required", "A stable idempotency key between 8 and 240 bytes is required");
  return definition;
}
export async function listGrowthOperations(core: CoreContext, context: RequestContext): Promise<GrowthOperationDefinition[]> {
  const result: GrowthOperationDefinition[] = [];
  for (const operation of growthOperations) {
    try { await authorizeGrowthOperation(core, context, operation, { discovery: true }); result.push(operation); }
    catch (error) { if (!(error instanceof ApiError) || error.status !== 403) throw error; }
  }
  return result;
}
