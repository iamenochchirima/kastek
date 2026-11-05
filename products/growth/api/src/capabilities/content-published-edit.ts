import type { Pool } from "pg";
import { createHash } from "node:crypto";
import type { CoreConfig } from "../config.js";
import type { RequestContext } from "../identity/request-context.js";
import { transaction } from "../db.js";
import { ApiError } from "../error.js";
import { canonicalJson } from "@kasitek-labs/server-support/json";
import { getSocialPost, lockSocialPost, type PostMutationOptions } from "../services/social/posts.js";
import { lockReviewedSocialAccounts } from "../services/social/account-admission.js";
import { parseOptionalDatetime } from "../services/social/common.js";
import { authorizationRequirement } from "../integrations/connection-permissions.js";
import { resolveFacebookPostForUpdate, readFacebookPostMessage, updateFacebookPostMessage, facebookPublishedMutationTarget, type ProviderOptions } from "../services/social/provider-publishing.js";
import { CONTENT_POST_UPDATED_EVENT, enqueueDomainEvent } from "../services/public-webhooks.js";
import type { SocialPost } from "../services/social/types.js";

type EditIntent = {
  idempotencyKey: string; actorId: string; contentDigest: string; content: string;
  state: "executing" | "confirmed" | "uncertain" | "failed";
  externalPostId: string; channelConnectionId: string; expectedUpdatedAt: string;
  graphPostId?: string; confirmedAt?: string;
  removePhoto?: boolean;
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const conflict = (message: string) => new ApiError(409, "conflict", message);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const THREADS_PUBLISHED_EDIT_UNSUPPORTED = "The Threads API does not support editing published posts.";
export interface PublishedFacebookUpdate { content: string; expectedUpdatedAt: string; removePhoto?: boolean }
type PublishedEditOptions = PostMutationOptions & ProviderOptions & { reconcileOnly?: boolean };

/** Reconciliation can confirm an existing effect, but cannot issue an update. */
export function reconcilePublishedFacebookEdit(pool: Pool, config: CoreConfig, ctx: RequestContext, postId: string, input: PublishedFacebookUpdate, options: PublishedEditOptions = {}): Promise<SocialPost> {
  return updatePublishedFacebookPost(pool, config, ctx, postId, input, { ...options, reconcileOnly: true });
}

/** The receipt stays on the existing delivery job; publication evidence is immutable. */
export async function updatePublishedFacebookPost(
  pool: Pool, config: CoreConfig, ctx: RequestContext, postId: string,
  input: PublishedFacebookUpdate, options: PublishedEditOptions = {},
): Promise<SocialPost> {
  if (!ctx.idempotencyKey) throw new ApiError(400, "bad_request", "idempotency-key is required for published updates");
  if (typeof input.content !== "string" || !input.content.trim() || Array.from(input.content.trim()).length > 32768)
    throw new ApiError(400, "bad_request", "Facebook post text must contain 1 to 32768 characters");
  const content = input.content.trim();
  if (input.removePhoto !== undefined && typeof input.removePhoto !== "boolean")
    throw new ApiError(400, "bad_request", "removePhoto must be a boolean");
  const removePhoto = input.removePhoto === true;
  const expected = parseOptionalDatetime(input.expectedUpdatedAt);
  if (!expected) throw new ApiError(400, "bad_request", "The current post revision is required");
  const contentDigest = digest(content), actorId = ctx.principal.id;
  const plan = await transaction(pool, async tx => {
    await lockSocialPost(tx, ctx.organizationId, postId);
    const post = await getSocialPost(pool, ctx.organizationId, postId);
    if (!post) throw new ApiError(404, "not_found", "Post not found");
    if (post.channels.length === 1 && post.channels[0] === "THREADS")
      throw new ApiError(409, "platform_edit_unsupported", THREADS_PUBLISHED_EDIT_UNSUPPORTED);
    if (post.status !== "PUBLISHED" || post.channels.length !== 1 || post.channels[0] !== "FACEBOOK" || post.publishJobs.length !== 1)
      throw conflict("Only published Facebook-only posts can be updated");
    const job = post.publishJobs[0]!;
    if (job.platform !== "FACEBOOK" || job.status !== "PUBLISHED" || !job.external_post_id || !job.channel_connection_id)
      throw conflict("A confirmed Facebook publication is required");
    const metadata = object(job.metadata), deletion = object(metadata._kasitek_delete_intent);
    if (["executing", "uncertain", "confirmed"].includes(String(deletion.state)))
      throw conflict("This post is being deleted or its deletion requires reconciliation");
    const prior = object(metadata._kasitek_edit_intent) as Partial<EditIntent>;
    const same = prior.idempotencyKey === ctx.idempotencyKey;
    if (same && (prior.actorId !== actorId || prior.contentDigest !== contentDigest || prior.expectedUpdatedAt !== input.expectedUpdatedAt || Boolean(prior.removePhoto) !== removePhoto))
      throw conflict("This update identity was already used for another request");
    if (!same && ["executing", "uncertain"].includes(String(prior.state)))
      throw conflict("A previous update requires reconciliation before another edit");
    if (same && prior.state === "confirmed") return { post, replay: true as const };
    if (removePhoto && (post.media.length !== 1 || post.media[0]!.kind !== "IMAGE"))
      throw conflict("Photo removal requires a published Facebook post with one image");
    if (options.reconcileOnly && (!same || !["executing", "uncertain"].includes(String(prior.state))))
      throw conflict("There is no unconfirmed Facebook update to reconcile");
    await lockSocialPost(tx, ctx.organizationId, postId, { ...options, expectedPostRevision: options.expectedPostRevision ?? input.expectedUpdatedAt });
    // Apply both revision fences if a reviewed operation supplies its own snapshot revision.
    await lockSocialPost(tx, ctx.organizationId, postId, { expectedPostRevision: input.expectedUpdatedAt });
    await lockReviewedSocialAccounts(tx, ctx.organizationId, options.expectedAccounts);
    const account = (await tx.query<{ id: string; externalAccountId: string; accessToken: string; metadata: Record<string, unknown> | null }>(
      `SELECT id,"externalAccountId","accessToken",metadata FROM "SocialChannelConnection" WHERE id=$1 AND "orgId"=$2 AND platform='FACEBOOK' AND status='CONNECTED' FOR SHARE`,
      [job.channel_connection_id, ctx.organizationId],
    )).rows[0];
    if (!account?.accessToken || !account.externalAccountId) throw new ApiError(403, "forbidden", "Reconnect the Facebook Page before updating");
    if (authorizationRequirement("FACEBOOK", account.metadata, "SOCIAL_PUBLISH"))
      throw new ApiError(403, "forbidden", "Grant Facebook publishing access before updating");
    const intent: EditIntent = same ? prior as EditIntent : {
      idempotencyKey: ctx.idempotencyKey!, actorId, contentDigest, content, state: "executing",
      externalPostId: job.external_post_id, channelConnectionId: account.id, expectedUpdatedAt: input.expectedUpdatedAt,
      removePhoto,
    };
    if (same && (intent.externalPostId !== job.external_post_id || intent.channelConnectionId !== account.id))
      throw conflict("The published destination changed");
    const reconcileOnly = same && ["executing", "uncertain"].includes(intent.state);
    if (!reconcileOnly) intent.state = "executing";
    await tx.query(`UPDATE "SocialPublishJob" SET metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),'{_kasitek_edit_intent}',$2::jsonb,true),"updatedAt"=NOW() WHERE id=$1`, [job.id, canonicalJson(intent)]);
    return { post, job, account, intent, replay: false as const, reconcileOnly };
  });
  if (plan.replay) return plan.post;
  const { job, account, intent } = plan;
  let effectStarted = false;
  try {
    if (!intent.graphPostId) {
      const target = facebookPublishedMutationTarget(job.external_post_id!, job.metadata);
      intent.graphPostId = await resolveFacebookPostForUpdate(config, account.accessToken, account.externalAccountId, target, target === job.external_post_id && plan.post.media.length > 0, options);
      if (intent.graphPostId.includes("_") && !intent.graphPostId.startsWith(`${account.externalAccountId}_`))
        throw new ApiError(403, "forbidden", "Facebook post does not belong to the connected Page");
      await pool.query(`UPDATE "SocialPublishJob" SET metadata=jsonb_set(metadata,'{_kasitek_edit_intent}',$2::jsonb,true) WHERE id=$1`, [job.id, canonicalJson(intent)]);
    }
    if (plan.reconcileOnly) {
      if (await readFacebookPostMessage(config, account.accessToken, intent.graphPostId, options, removePhoto) !== content)
        throw new ApiError(409, "published_update_unconfirmed", "The previous Facebook update is not confirmed. Reconcile it before another edit");
    } else {
      effectStarted = true;
      await updateFacebookPostMessage(config, account.accessToken, intent.graphPostId, content, options, removePhoto);
    }
  } catch (error) {
    const uncertain = plan.reconcileOnly || effectStarted && (!(error instanceof ApiError) || error.status >= 500);
    intent.state = uncertain ? "uncertain" : "failed";
    await pool.query(`UPDATE "SocialPublishJob" SET metadata=jsonb_set(metadata,'{_kasitek_edit_intent}',$2::jsonb,true),"updatedAt"=NOW() WHERE id=$1`, [job.id, canonicalJson(intent)]);
    if (uncertain) throw new ApiError(409, "published_update_unconfirmed", "Facebook update confirmation is unavailable. Check the Facebook post before another edit");
    throw error;
  }
  try { await transaction(pool, async tx => {
    await lockSocialPost(tx, ctx.organizationId, postId, { expectedPostRevision: input.expectedUpdatedAt,expectedPostAgentRevision:options.expectedPostAgentRevision });
    intent.state = "confirmed"; intent.confirmedAt = new Date().toISOString();
    await tx.query(`UPDATE "SocialPublishJob" SET metadata=jsonb_set(metadata,'{_kasitek_edit_intent}',$2::jsonb,true),"updatedAt"=NOW() WHERE id=$1`, [job.id, canonicalJson(intent)]);
    if (removePhoto) {
      await tx.query('DELETE FROM "SocialPostVariantMedia" WHERE "variantId" IN (SELECT id FROM "SocialPostVariant" WHERE "postId"=$1 AND platform=\'FACEBOOK\')', [postId]);
      await tx.query('DELETE FROM "SocialPostMedia" WHERE "postId"=$1', [postId]);
      await tx.query(`UPDATE "SocialPublishJob" SET metadata=jsonb_set(metadata,'{_kasitek_facebook_story}',$2::jsonb,true) WHERE id=$1`, [job.id, canonicalJson({ id: intent.graphPostId, originalExternalPostId: job.external_post_id, photoDetached: true })]);
    }
    await tx.query('UPDATE "SocialPostVariant" SET content=$2,"updatedAt"=NOW() WHERE "postId"=$1 AND platform=\'FACEBOOK\'', [postId, content]);
    await tx.query('UPDATE "SocialPost" SET content=$2,"updatedAt"=NOW() WHERE id=$1 AND "orgId"=$3', [postId, content, ctx.organizationId]);
  }); } catch {
    throw new ApiError(409, "published_update_unconfirmed", "Facebook update confirmation is unavailable. Check the Facebook post before another edit");
  }
  const post = await getSocialPost(pool, ctx.organizationId, postId);
  if (!post) throw new ApiError(404, "not_found", "Post not found");
  try { await enqueueDomainEvent(pool, ctx.organizationId, CONTENT_POST_UPDATED_EVENT, { postId, status: post.status, title: post.title, updatedAt: post.updated_at }); }
  catch { console.warn(JSON.stringify({ event: "queue.item.failed", operation: "content.updated.enqueue", correlation_id: ctx.correlationId })); }
  return post;
}
