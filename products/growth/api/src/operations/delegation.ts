import type { CoreContext } from "../context.js";
import type { RequestContext } from "../identity/request-context.js";
import { ApiError } from "../error.js";
import { requireCapability } from "../services/billing.js";

export function delegatedSocialAuthority(context: RequestContext, operation: string): Record<string, unknown> | null {
  if (!context.operationReviewId) {
    if (context.principal.kind === "direct_user") return null;
    throw new ApiError(403, "operation_review_required", "A reviewed publication authority is required");
  }
  return { version: 1, orgId: context.organizationId, userId: context.userId,
    principalId: context.principal.id, principalKind: context.principal.kind,
    reviewId: context.operationReviewId, operation, scope: "growth:publish" };
}

/** Queue admission is not permanent authority. Recheck the original grant before provider I/O. */
export async function assertDelegatedSocialAuthority(core: CoreContext, orgId: string, userId: string, metadata: Record<string, unknown> | null) {
  const raw = metadata?._kasitek_delegation;
  if (raw === undefined || raw === null) return;
  const denied = () => new ApiError(403, "publication_authority_revoked", "Publication permission was revoked. Review and schedule this post again.");
  if (typeof raw !== "object" || Array.isArray(raw)) throw denied();
  const authority = raw as Record<string, unknown>;
  if (core.config.env.GROWTH_AGENT_ACCESS_ENABLED === "false" || core.config.env.GROWTH_AGENT_EFFECTS_ENABLED === "false" ||
      core.config.environment === "production" && (core.config.env.GROWTH_AGENT_ACCESS_ENABLED !== "true" || core.config.env.GROWTH_AGENT_EFFECTS_ENABLED !== "true")) throw denied();
  if (authority.version !== 1 || authority.orgId !== orgId || authority.userId !== userId || typeof authority.reviewId !== "string" || typeof authority.principalId !== "string") throw denied();
  const review = (await core.pool.query(`SELECT operation,state FROM "GrowthOperationReview" WHERE id=$1 AND "orgId"=$2 AND "userId"=$3 AND "principalId"=$4 AND "principalKind"=$5`,
    [authority.reviewId, orgId, userId, authority.principalId, authority.principalKind])).rows[0];
  if (!review || !["executing", "succeeded"].includes(review.state) || review.operation !== authority.operation) throw denied();
  const member = await core.pool.query(`SELECT 1 FROM "OrganizationMember" m JOIN "User" u ON u.id=m."userId" WHERE m."orgId"=$1 AND m."userId"=$2 AND u."emailVerified" IS NOT NULL`, [orgId, userId]);
  if (!member.rowCount) throw denied();
  if (authority.principalKind === "oauth_user") {
    const found = await core.pool.query(`SELECT 1 FROM "GrowthOAuthConnection" c WHERE c.id=$1 AND c."orgId"=$2 AND c."userId"=$3 AND c."revokedAt" IS NULL AND $4=ANY(c.scopes) AND EXISTS(SELECT 1 FROM "GrowthOAuthRefresh" r WHERE r."connectionId"=c.id AND r."expiresAt">now() AND r."usedAt" IS NULL)`, [authority.principalId, orgId, userId, "growth:publish"]);
    if (!found.rowCount) throw denied();
  } else if (authority.principalKind === "workspace_api_key") {
    const found = await core.pool.query(`SELECT 1 FROM "DeveloperApiKey" WHERE id=$1 AND "orgId"=$2 AND "createdById"=$3 AND status='ACTIVE' AND ("expiresAt" IS NULL OR "expiresAt">now()) AND $4=ANY(scopes)`, [authority.principalId, orgId, userId, "growth:publish"]);
    if (!found.rowCount) throw denied();
  } else if (!["direct_user", "trusted_internal_service"].includes(String(authority.principalKind))) throw denied();
  await requireCapability(core.pool, orgId, "feature.content.publish");
}
