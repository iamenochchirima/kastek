import type { Pool } from "pg";
import type { CoreConfig } from "../config.js";
import type { RequestContext } from "../identity/request-context.js";
import type {
  SocialPost,
  SocialPostUpsertRequest,
} from "../services/social/types.js";
import type { PublishExecutionResult } from "../services/social/publishing.js";
import * as insights from "../services/social/insights.js";
import * as posts from "../services/social/posts.js";
import { lockSocialPost, type PostMutationOptions } from "../services/social/posts.js";
import {
  claimPublishJob,
  executeSocialPublishJob,
  deleteSocialPostFromPlatform,
  type SocialExecutionOptions,
  type SocialDeletionAdmission,
} from "../services/social/publishing.js";
import { transaction } from "../db.js";
import { canonicalJson } from "@kasitek-labs/server-support/json";
import { ApiError } from "../error.js";
import { parseOptionalDatetime } from "../services/social/common.js";
import { SQL } from "./content-adapter-sql.js";
import { lockReviewedSocialAccounts, stampSocialPublicationAccounts } from "../services/social/account-admission.js";
import { delegatedSocialAuthority } from "../operations/delegation.js";
export const SUPPORTED_PLATFORMS = [
  "FACEBOOK",
  "INSTAGRAM",
  "THREADS",
  "TIKTOK",
  "BLUESKY",
  "LINKEDIN",
  "X",
] as const;
export interface ContentExecutionPorts {
  executeSocialPublishJob(
    pool: Pool,
    id: string,
  ): Promise<PublishExecutionResult>;
  deleteSocialPostFromPlatform(
    pool: Pool,
    config: CoreConfig,
    orgId: string,
    postId: string,
    platform: string,
    admission?: SocialDeletionAdmission,
  ): Promise<unknown>;
}
/** Bind execution to the actual publishing service and the current Core configuration. */
export function liveContentExecutionPorts(
  config: CoreConfig,
  options: SocialExecutionOptions = {},
): ContentExecutionPorts {
  return {
    executeSocialPublishJob: (pool, id) =>
      executeSocialPublishJob(pool, id, { ...options, config }),
    deleteSocialPostFromPlatform: (pool, coreConfig, orgId, postId, platform, admission) =>
      deleteSocialPostFromPlatform(pool, coreConfig, orgId, postId, platform, {
        ...options,
        config: coreConfig,
        deleteAdmission: admission,
      }),
  };
}
const bad = (message: string) => new ApiError(400, "bad_request", message),
  conflict = (message: string) => new ApiError(409, "conflict", message);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const requiredKey = (ctx: RequestContext, purpose: string): string => {
  if (ctx.idempotencyKey === null)
    throw bad(`idempotency-key is required for ${purpose}`);
  return ctx.idempotencyKey;
};
const platform = (value: string): string => {
  const normalized = value.trim().replace(/[a-z]/g, (c) => c.toUpperCase());
  if (
    !SUPPORTED_PLATFORMS.includes(
      normalized as (typeof SUPPORTED_PLATFORMS)[number],
    )
  )
    throw bad(`Publishing is not available for ${normalized}`);
  return normalized;
};
export function splitAgentChannelTarget(
  value: string,
): [string, string | null] {
  const normalized = value.trim().replace(/[a-z]/g, (c) => c.toUpperCase());
  if (
    SUPPORTED_PLATFORMS.includes(
      normalized as (typeof SUPPORTED_PLATFORMS)[number],
    )
  )
    return [normalized, null];
  for (const candidate of SUPPORTED_PLATFORMS) {
    if (normalized.startsWith(candidate)) {
      const tail = value.trim().slice(candidate.length);
      if (/^[\s:-]/.test(tail)) {
        const selector = tail
          .replace(/^[\s:-]+|[\s:-]+$/g, "")
          .replace(/^\(|\)$/g, "")
          .trim();
        return [candidate, selector || null];
      }
    }
  }
  return [normalized, null];
}
export function prepareAgentChannels(
  request: SocialPostUpsertRequest,
): string[] | null {
  if (request.channels == null) return null;
  const channels = request.channels.map(
    (value) => splitAgentChannelTarget(value)[0],
  );
  if (
    channels.some((value) =>
      SUPPORTED_PLATFORMS.includes(
        value as (typeof SUPPORTED_PLATFORMS)[number],
      ),
    )
  )
    return channels;
  return Object.keys(request.channelSelections ?? {})
    .map((value) => value.trim().replace(/[a-z]/g, (c) => c.toUpperCase()))
    .filter((value) =>
      SUPPORTED_PLATFORMS.includes(
        value as (typeof SUPPORTED_PLATFORMS)[number],
      ),
    );
}
export async function prepareAgentContentRequest(
  pool: Pool,
  orgId: string,
  request: SocialPostUpsertRequest,
): Promise<SocialPostUpsertRequest> {
  const prepared = {
    ...request,
    channels: prepareAgentChannels(request),
    variants:
      request.variants?.map((v) => ({
        ...v,
        platform: v.platform.trim().replace(/[a-z]/g, (c) => c.toUpperCase()),
      })) ?? request.variants,
  };
  const selections: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.channelSelections ?? {})) {
    if (key.trim() && value.trim())
      selections[key.trim().replace(/[a-z]/g, (c) => c.toUpperCase())] =
        value.trim();
  }
  for (const raw of request.channels ?? []) {
    const [key, selector] = splitAgentChannelTarget(raw);
    if (selector && selections[key] === undefined) selections[key] = selector;
  }
  for (const key of prepared.channels ?? []) {
    if (
      !SUPPORTED_PLATFORMS.includes(key as (typeof SUPPORTED_PLATFORMS)[number])
    )
      continue;
    const selector = selections[key];
    const selected = selector
      ? (
          await pool.query<{
            id: string;
          }>(SQL.connected_channel_by_selector[0], [orgId, key, selector])
        ).rows[0]?.id
      : undefined;
    delete selections[key];
    const id =
      selected ??
      (
        await pool.query<{
          id: string;
        }>(SQL.newest_connected_channel[0], [orgId, key])
      ).rows[0]?.id;
    if (id) selections[key] = id;
  }
  const fallback =
    prepared.channels?.map((key) => selections[key]).find(Boolean) ??
    Object.values(selections)[0] ??
    null;
  const hint = request.primaryChannelId?.trim();
  prepared.primaryChannelId = hint
    ? ((
        await pool.query<{
          id: string;
        }>(SQL.connected_channel_by_id[0], [hint, orgId])
      ).rows[0]?.id ?? fallback)
    : fallback;
  prepared.channelSelections = Object.keys(selections).length
    ? selections
    : null;
  return prepared;
}
export const listPosts = (pool: Pool, ctx: RequestContext) =>
  posts.listSocialPosts(pool, ctx.organizationId);
export const getPost = (pool: Pool, ctx: RequestContext, id: string) =>
  posts.getSocialPost(pool, ctx.organizationId, id);
export const getInsights = (
  pool: Pool,
  ctx: RequestContext,
  id: string,
  filters: insights.SocialPostInsightsFilters,
) => insights.getSocialPostInsights(pool, ctx.organizationId, id, filters);
export const listInsights = (
  pool: Pool,
  ctx: RequestContext,
  filters: insights.SocialPostInsightsFilters,
  limit: number,
) => insights.listSocialPostInsights(pool, ctx.organizationId, filters, limit);
export const getPostActivity = (pool: Pool, ctx: RequestContext, id: string) =>
  posts.getSocialPostActivity(pool, ctx.organizationId, id);
async function actorUserId(pool: Pool, ctx: RequestContext): Promise<string> {
  const id =
    ctx.userId ??
    ctx.principal.subjectUserId ??
    (
      await pool.query<{
        ownerId: string;
      }>(SQL.create_draft[0], [ctx.organizationId])
    ).rows[0]?.ownerId;
  if (!id) throw new ApiError(404, "not_found", "Organization owner not found");
  return id;
}
export async function createDraft(
  pool: Pool,
  ctx: RequestContext,
  request: SocialPostUpsertRequest,
  options: PostMutationOptions = {},
): Promise<SocialPost> {
  const prepared = await prepareAgentContentRequest(
    pool,
    ctx.organizationId,
    request,
  );
  return posts.createSocialPostIdempotent(
    pool,
    await actorUserId(pool, ctx),
    ctx.organizationId,
    prepared,
    ctx.idempotencyKey,
    options,
  );
}
export async function updateDraft(
  pool: Pool,
  ctx: RequestContext,
  id: string,
  request: SocialPostUpsertRequest,
  options: PostMutationOptions = {},
): Promise<SocialPost> {
  if (request.status != null && request.status !== "DRAFT")
    throw bad("Agent content updates must keep DRAFT status");
  const prepared = await prepareAgentContentRequest(
    pool,
    ctx.organizationId,
    request,
  );
  return posts.updateSocialPost(
    pool,
    await actorUserId(pool, ctx),
    ctx.organizationId,
    id,
    prepared,
    options,
  );
}
async function requirePost(
  pool: Pool,
  ctx: RequestContext,
  id: string,
): Promise<SocialPost> {
  const post = await getPost(pool, ctx, id);
  if (!post) throw new ApiError(404, "not_found", "Content post not found");
  return post;
}
export async function publish(
  pool: Pool,
  ctx: RequestContext,
  id: string,
  value: string,
  ports: ContentExecutionPorts,
): Promise<unknown> {
  const target = platform(value),
    post = await requirePost(pool, ctx, id);
  if (!post.channels.includes(target))
    throw bad(`This post is not configured for ${target}`);
  const job = post.publishJobs.find((job) => job.platform === target);
  if (!job) throw new ApiError(404, "not_found", "Publish job not found");
  const key = requiredKey(ctx, "content publishing"),
    prior = object(job.metadata)._kasitek_agent_idempotency_key;
  if (prior === key) {
    if (job.status === "PUBLISHED" && job.external_post_id)
      return {
        post,
        result: {
          jobId: job.id,
          postId: id,
          platform: target,
          status: "PUBLISHED",
          externalPostId: job.external_post_id,
        },
        idempotentReplay: true,
      };
    if (job.status === "PROCESSING")
      throw conflict("This publish job is already being processed");
  } else {
    if (typeof prior === "string" && job.status !== "FAILED")
      throw conflict("This publish job already has an idempotent execution");
    if (job.status === "PUBLISHED" && job.external_post_id)
      throw conflict(`This post has already been published to ${target}`);
    if (
      (
        await pool.query(SQL.publish[0], [
          job.id,
          key,
          typeof prior === "string" ? prior : "",
        ])
      ).rowCount !== 1
    )
      throw conflict("This publish job was claimed by another execution");
  }
  if (!(await claimPublishJob(pool, job.id, ["PENDING", "FAILED", "QUEUED"])))
    throw conflict("This publish job is already being processed");
  const result = await ports.executeSocialPublishJob(pool, job.id);
  try {
    const latest = await getPost(pool, ctx, id);
    if (latest)
      return { post: latest, result, postReadbackStatus: "AVAILABLE" };
  } catch {
    /* External effect already completed; retain result. */
  }
  post.status = result.status;
  post.updated_at = new Date();
  if (result.status === "PUBLISHED") post.published_at = new Date();
  const changed = post.publishJobs.find((job) => job.id === result.jobId);
  if (changed) {
    changed.status = result.status;
    changed.external_post_id = result.externalPostId;
    changed.error_message = null;
    changed.updated_at = new Date();
    if (result.status === "PUBLISHED") changed.published_at = new Date();
  }
  return { post, result, postReadbackStatus: "UNAVAILABLE" };
}
export async function schedule(
  pool: Pool,
  ctx: RequestContext,
  id: string,
  scheduledFor: string,
  options: PostMutationOptions = {},
): Promise<unknown> {
  let when: Date;
  try {
    when = parseOptionalDatetime(scheduledFor)!;
    if (!when) throw new Error();
  } catch {
    throw bad("scheduledFor must be an RFC3339 timestamp");
  }
  if (!Number.isFinite(when.getTime()) || when <= new Date())
    throw bad("scheduledFor must be in the future");
  const key = requiredKey(ctx, "content scheduling");
  const existing = await transaction(pool, async (tx) => {
    await lockSocialPost(tx, ctx.organizationId, id, options);
    await lockReviewedSocialAccounts(tx, ctx.organizationId, options.expectedAccounts);
    await tx.query(SQL.schedule[0], [
      `kasitek.content.schedule:${ctx.organizationId}:${key}`,
    ]);
    const existing = (await tx.query<{ id: string; scheduled_for: Date | null }>(
      'SELECT id,"scheduledFor" AS scheduled_for FROM "SocialPost" WHERE "orgId"=$1 AND metadata->>\'_kasitek_agent_schedule_idempotency_key\'=$2 LIMIT 1', [ctx.organizationId, key],
    )).rows[0];
    if (existing) {
      if (existing.id !== id || existing.scheduled_for?.getTime() !== when.getTime())
        throw conflict("This idempotency key was already used for a different schedule");
      return existing.id;
    }
    const post = await requirePost(pool, ctx, id);
    if (!["DRAFT", "SCHEDULED"].includes(post.status))
      throw conflict("Only draft content can be scheduled");
    if (post.publishJobs.some(job => !["PENDING", "QUEUED", "CANCELED"].includes(job.status) || job.external_post_id || object(job.metadata)._kasitek_outcome === "UNKNOWN"))
      throw conflict("Content with a publishing attempt cannot be scheduled again");
    if (
      post.metadata !== null &&
      (typeof post.metadata !== "object" || Array.isArray(post.metadata))
    )
      throw bad("Content metadata must be a JSON object");
    const metadata = {
      ...object(post.metadata),
      _kasitek_agent_schedule_idempotency_key: key,
    };
    await tx.query(SQL.schedule[2], [
      id,
      when.toISOString(),
      canonicalJson(metadata),
      ctx.organizationId,
    ]);
    await tx.query(SQL.schedule[3], [id, when.toISOString()]);
    await tx.query('UPDATE "SocialPublishJob" SET "userId"=$2, metadata=COALESCE(metadata,\'{}\'::jsonb)||$3::jsonb WHERE "postId"=$1 AND status=\'QUEUED\'', [id, ctx.userId, canonicalJson({ _kasitek_delegation: delegatedSocialAuthority(ctx, "content.posts.schedule") })]);
    await stampSocialPublicationAccounts(tx, ctx.organizationId, id);
    return id;
  });
  return { post: await requirePost(pool, ctx, existing), status: "SCHEDULED" };
}
export async function unschedule(
  pool: Pool,
  ctx: RequestContext,
  id: string,
  options: PostMutationOptions = {},
): Promise<unknown> {
  const key = requiredKey(ctx, "content unscheduling");
  await transaction(pool, async (tx) => {
    await lockSocialPost(tx, ctx.organizationId, id, options);
    await lockReviewedSocialAccounts(tx, ctx.organizationId, options.expectedAccounts);
    await tx.query(SQL.unschedule[0], [
      `kasitek.content.unschedule:${ctx.organizationId}:${id}`,
    ]);
    const row = (
      await tx.query<{
        status: string;
        metadata: unknown;
      }>(SQL.unschedule[1], [id, ctx.organizationId])
    ).rows[0];
    if (!row) throw new ApiError(404, "not_found", "Content post not found");
    if (
      row.metadata !== null &&
      (typeof row.metadata !== "object" || Array.isArray(row.metadata))
    )
      throw bad("Content metadata must be a JSON object");
    const metadata = { ...object(row.metadata) };
    if (metadata._kasitek_agent_unschedule_idempotency_key === key) return;
    if (row.status !== "SCHEDULED")
      throw conflict("Only scheduled content can be unscheduled");
    if ((await tx.query(`SELECT id FROM "SocialPublishJob" WHERE "postId"=$1 AND (status IN('PROCESSING','PUBLISHED') OR COALESCE(metadata->>'_kasitek_outcome','')='UNKNOWN') LIMIT 1`, [id])).rows.length)
      throw conflict("Publishing has already started; the schedule cannot be canceled");
    delete metadata._kasitek_agent_schedule_idempotency_key;
    metadata._kasitek_agent_unschedule_idempotency_key = key;
    await tx.query(SQL.unschedule[2], [
      id,
      ctx.organizationId,
      canonicalJson(metadata),
    ]);
    await tx.query(SQL.unschedule[3], [id]);
    await tx.query('UPDATE "SocialPublishJob" SET metadata=metadata-\'_kasitek_delegation\' WHERE "postId"=$1 AND status=\'PENDING\'', [id]);
  });
  return { post: await requirePost(pool, ctx, id), status: "DRAFT" };
}
export async function deletePost(
  pool: Pool,
  ctx: RequestContext,
  id: string,
  options: PostMutationOptions = {},
): Promise<unknown> {
  requiredKey(ctx, "content deletion");
  const row = (
    await pool.query<{
      status: string;
    }>(SQL.delete_post[0], [id, ctx.organizationId])
  ).rows[0];
  if (!row) throw new ApiError(404, "not_found", "Content post not found");
  if (row.status === "PUBLISHED")
    throw conflict("Published content is immutable and cannot be deleted");
  return {
    postId: id,
    deleted: await posts.deleteSocialPost(pool, ctx.organizationId, id, options),
  };
}
export async function deletePublishedPost(
  pool: Pool,
  config: CoreConfig,
  ctx: RequestContext,
  id: string,
  target: string,
  ports: ContentExecutionPorts,
  options: PostMutationOptions = {},
): Promise<unknown> {
  const key = requiredKey(ctx, "published content deletion");
  return ports.deleteSocialPostFromPlatform(
    pool,
    config,
    ctx.organizationId,
    id,
    target,
    { ...options, idempotencyKey: key, actorId: ctx.principal.id },
  );
}
export const getActivity = getPostActivity;
