import type { Pool, PoolClient } from "pg";
import type { GrowthAgentActor, GrowthAgentFeatureId, GrowthAgentContext, GrowthAgentContextEvidence } from "@kasitek-labs/contracts";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { requireCapability } from "../services/billing.js";
import { getSocialPost } from "../services/social/posts.js";
import { getCampaignSummary } from "../services/whatsapp/campaigns.js";
import { reportForOrganization } from "../services/analytics-reporting.js";
import { SerdeFloat } from "@kasitek-labs/server-support/json";
import { growthAgentDigest, growthAgentIdentityIssuer } from "./security.js";
import { growthAgentProductGuide } from "./product-guide.js";
export interface GrowthAgentScope { tenantId: string; actor: GrowthAgentActor }
export async function authorizeGrowthAgentScope(core: CoreContext, scope: GrowthAgentScope, featureId?: GrowthAgentFeatureId,
  db: Pool | PoolClient = core.pool, lock = false): Promise<{ businessName: string }> {
  if (scope.actor.issuer !== growthAgentIdentityIssuer(core.config)) throw new ApiError(403, "agent_actor_denied", "Agent identity is unavailable");
  const row = (await db.query(`SELECT o.name FROM "OrganizationMember" m JOIN "Organization" o ON o.id=m."orgId"
    JOIN "User" u ON u.id=m."userId" WHERE m."orgId"=$1 AND m."userId"=$2 AND u."emailVerified" IS NOT NULL${lock ? " FOR SHARE OF m,o,u" : ""}`,
  [scope.tenantId, scope.actor.subject])).rows[0];
  if (!row) throw new ApiError(403, "agent_scope_denied", "Business access is unavailable");
  await requireCapability(core.pool, scope.tenantId, "feature.agents.manage");
  if (featureId === "content") await requireCapability(core.pool, scope.tenantId, "feature.content.manage");
  if (featureId === "campaigns") await requireCapability(core.pool, scope.tenantId, "feature.campaigns.manage");
  return { businessName: row.name };
}
function wire(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof SerdeFloat) return value.value;
  if (Array.isArray(value)) return value.map(wire);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wire(item)]));
  return value;
}
export async function readGrowthAgentContext(core: CoreContext, scope: GrowthAgentScope, context: GrowthAgentContext): Promise<GrowthAgentContextEvidence> {
  await authorizeGrowthAgentScope(core, scope);
  let data: unknown, title: string, route: string;
  if (context.kind === "workspace") {
    if (context.resourceId && context.resourceId !== scope.tenantId) throw new ApiError(403, "agent_context_denied", "Business context is unavailable");
    const row = (await core.pool.query(`SELECT o.id,o.name,o."reportingTimezone",o."updatedAt",p.website,p.industry,p."primaryGoal",p."primaryGoals"
      FROM "Organization" o LEFT JOIN "OrganizationOnboardingProfile" p ON p."orgId"=o.id WHERE o.id=$1`, [scope.tenantId])).rows[0];
    if (!row) throw new ApiError(404, "agent_context_missing", "Business context is unavailable");
    data = { ...row, productGuide: await growthAgentProductGuide(core, scope) }; title = row.name; route = "/workspace/settings";
  } else if (context.kind === "content_post") {
    await requireCapability(core.pool, scope.tenantId, "feature.content.manage");
    const post = await getSocialPost(core.pool, scope.tenantId, context.resourceId!);
    if (!post) throw new ApiError(404, "agent_context_missing", "Content is unavailable");
    data = { id: post.id, title: post.title, content: post.content, channels: post.channels, status: post.status,
      updatedAt: post.updated_at, variants: post.variants.map(v => ({ platform: v.platform, content: v.content, status: v.status })),
      selectedAccounts: post.publishJobs.map(job => ({ platform: job.platform, accountId: job.channel_connection_id, status: job.status })) };
    title = post.title ?? "Content draft"; route = `/content/posts/${encodeURIComponent(post.id)}`;
  } else if (context.kind === "whatsapp_campaign") {
    await requireCapability(core.pool, scope.tenantId, "feature.campaigns.manage");
    const summary = await getCampaignSummary(core.pool, scope.tenantId, context.resourceId!);
    const campaign = summary.campaign as Record<string, unknown>;
    const allowed = ["id", "name", "description", "status", "templateName", "templateLanguage", "totalRecipients", "sentCount", "deliveredCount", "readCount", "failedCount", "blockedCount", "unsubscribedCount", "scheduledAt", "updatedAt"];
    data = Object.fromEntries(allowed.filter(key => campaign[key] !== undefined).map(key => [key, campaign[key]]));
    title = String(campaign.name ?? "WhatsApp campaign"); route = `/campaigns/${encodeURIComponent(context.resourceId!)}`;
  } else {
    await requireCapability(core.pool, scope.tenantId, "feature.analytics.view");
    if (context.resourceId && context.resourceId !== scope.tenantId) throw new ApiError(403, "agent_context_denied", "Report context is unavailable");
    const range = context.range;
    if (!range) throw new ApiError(400, "agent_report_range_required", "Choose a report date range");
    data = await reportForOrganization(core, scope.actor.subject, scope.tenantId, { range_start: range.from, range_end: range.to,
      timezone: range.timezone, metrics: context.report?.metrics??[], breakdowns: context.report?.breakdowns??[], filters: context.report?.filters??{}, include_descendants: false });
    title = "Business analytics"; route = "/analytics";
  }
  const safe = wire(data), revision = growthAgentDigest(safe);
  return { context, revision, data: safe, sources: [{ id: `${context.kind}:${context.resourceId ?? scope.tenantId}`, title, route, revision }] };
}
export async function assertGrowthAgentContext(core: CoreContext, scope: GrowthAgentScope, context: GrowthAgentContext | null, revision?: string | null): Promise<void> {
  if (!context) return;
  if (context.kind === "analytics_report") {
    await requireCapability(core.pool, scope.tenantId, "feature.analytics.view");
    if (context.resourceId && context.resourceId !== scope.tenantId) throw new ApiError(403, "agent_context_denied", "Report context is unavailable");
    // Analytics runs behind its own current scope grant; no external query is needed just to authorize a model call.
    if (!context.range) throw new ApiError(400, "agent_report_range_required", "Choose a report date range");
    return;
  }
  const evidence = await readGrowthAgentContext(core, scope, context);
  if (revision && evidence.revision !== revision) throw new ApiError(409, "agent_context_changed", "The attached record changed. Start a new conversation with the current record");
}
