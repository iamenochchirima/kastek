import type { Pool, PoolClient } from "pg";
import { createId } from "@paralleldrive/cuid2";
import {
  canonicalJson,
  wireInteger,
  SerdeFloat,
} from "@kasitek/server-support/json";
import { transaction } from "../../db.js";
import { epochMicros } from "../../analytics/facts.js";
import { SQL } from "./posts-sql.js";
import { getSocialChannel } from "./channels.js";
import {
  bad,
  missing,
  internal,
  trimmed,
  isValidPlatform,
  POST_STATUSES,
  VARIANT_STATUSES,
  parseOptionalDatetime,
} from "./common.js";
import type {
  SocialChannel,
  SocialPost,
  SocialPostRow,
  SocialPostVariant,
  SocialPostMedia,
  SocialPublishJob,
  SocialPostUpsertRequest,
  SocialVariantInput,
  SocialMediaInput,
} from "./types.js";
const json = (value: unknown) => (value == null ? null : canonicalJson(value));
export function generatedSocialPostTitle(content: string): string {
  const first =
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const normalized = first.split(/\s+/u).filter(Boolean).join(" ");
  if (!normalized) return "Untitled social post";
  const chars = Array.from(normalized);
  return chars.length > 80 ? chars.slice(0, 77).join("") + "..." : normalized;
}
export function normalizeVariants(
  variants: SocialVariantInput[] | null | undefined,
  channels: string[],
  content: string,
): SocialVariantInput[] {
  return channels.map((platform) => {
    const existing = variants?.find((variant) => variant.platform === platform);
    return {
      platform,
      content: trimmed(existing?.content) ?? content,
      status:
        existing?.status && VARIANT_STATUSES.includes(existing.status)
          ? existing.status
          : "DRAFT",
      aiGenerated: existing?.aiGenerated,
      metadata: existing?.metadata,
    };
  });
}
async function loadPosts(
  pool: Pool,
  orgId: string,
  postId?: string,
): Promise<SocialPost[]> {
  const posts = (
    await pool.query<SocialPostRow>(
      postId === undefined ? SQL[1] : SQL[0],
      postId === undefined ? [orgId] : [orgId, postId],
    )
  ).rows;
  if (!posts.length) return [];
  const ids = posts.map((post) => post.id);
  const primaryIds = posts.flatMap((post) =>
    post.primary_channel_id ? [post.primary_channel_id] : [],
  );
  const variants = (await pool.query<SocialPostVariant>(SQL[2], [ids])).rows;
  const jobs = (
    await pool.query<SocialPublishJob & { delivery_snapshot: unknown }>(
      SQL[3],
      [ids],
    )
  ).rows.map(({ delivery_snapshot, ...job }) => ({
    ...job,
    deliverySnapshot: delivery_snapshot,
  }));
  const media = (await pool.query<SocialPostMedia>(SQL[4], [ids])).rows.map(
    (row) => ({ ...row, byte_size: wireInteger(row.byte_size) }),
  );
  const channels = primaryIds.length
    ? (await pool.query<SocialChannel>(SQL[5], [primaryIds])).rows
    : [];
  return posts.map((post) => ({
    ...post,
    primaryChannel:
      channels.find((channel) => channel.id === post.primary_channel_id) ??
      null,
    variants: variants.filter((variant) => variant.post_id === post.id),
    media: media.filter((item) => item.post_id === post.id),
    publishJobs: jobs.filter((job) => job.post_id === post.id),
  }));
}
export function listSocialPosts(pool: Pool, orgId: string) {
  return loadPosts(pool, orgId);
}
export async function getSocialPost(
  pool: Pool,
  orgId: string,
  postId: string,
): Promise<SocialPost | undefined> {
  return (await loadPosts(pool, orgId, postId))[0];
}
async function validatePrimaryChannel(
  pool: Pool,
  orgId: string,
  value: string | null | undefined,
): Promise<string | null> {
  const id = trimmed(value);
  if (!id) return null;
  if (!(await getSocialChannel(pool, orgId, id)))
    throw missing("Primary channel was not found");
  return id;
}
async function validateChannelSelections(
  pool: Pool,
  orgId: string,
  channels: string[],
  selections: Record<string, string> | null | undefined,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const platform of channels) {
    const id = trimmed(selections?.[platform]);
    if (!id)
      throw bad(
        `Choose a connected ${platform.toLowerCase()} account before saving`,
      );
    const channel = await getSocialChannel(pool, orgId, id);
    if (!channel) throw missing("Selected channel was not found");
    if (channel.status !== "CONNECTED" || channel.platform !== platform)
      throw bad(
        `Choose a connected ${platform.toLowerCase()} account before saving`,
      );
    result[platform] = channel.id;
  }
  return result;
}
async function validateMedia(
  pool: Pool,
  orgId: string,
  requested: SocialMediaInput[] | null | undefined,
): Promise<SocialMediaInput[]> {
  let media = (requested ?? [])
    .filter((item) => item.assetId.trim() !== "")
    .map((item) => ({ ...item }));
  if (!media.length) return [];
  if (media.length > 10)
    throw bad("A post can include at most 10 media assets");
  const ids = media.map((item) => item.assetId.trim());
  const available = (
    await pool.query<{ id: string }>(SQL[8], [orgId, ids])
  ).rows.map((row) => row.id);
  if (ids.some((id) => !available.includes(id)))
    throw bad(
      "Every attached media asset must belong to this workspace and be ready",
    );
  // Rust Vec::dedup_by removes adjacent raw identities before trimming and sorting.
  media = media.filter(
    (item, index) => index === 0 || item.assetId !== media[index - 1]!.assetId,
  );
  media = media.map((item, index) => ({
    ...item,
    assetId: item.assetId.trim(),
    sortOrder: Math.max(0, item.sortOrder ?? index),
    altText: trimmed(item.altText),
  }));
  media.sort((a, b) => a.sortOrder! - b.sortOrder!);
  return media.map((item, index) => ({ ...item, sortOrder: index }));
}
async function persistMedia(
  tx: PoolClient,
  postId: string,
  media: SocialMediaInput[],
) {
  for (const item of media)
    await tx.query(SQL[9], [
      createId(),
      postId,
      item.assetId,
      item.sortOrder ?? 0,
      item.altText ?? null,
      json(item.metadata),
    ]);
}
async function createVariantsAndJobs(
  tx: PoolClient,
  userId: string,
  orgId: string,
  postId: string,
  variants: SocialVariantInput[],
  selections: Record<string, string>,
  media: SocialMediaInput[],
  status: string,
  scheduled: Date | null,
) {
  for (const variant of variants) {
    const id = createId();
    await tx.query(SQL[6], [
      id,
      postId,
      variant.platform,
      variant.content,
      variant.status ?? "DRAFT",
      variant.aiGenerated ?? false,
      json(variant.metadata),
    ]);
    await tx.query(SQL[7], [
      createId(),
      userId,
      orgId,
      postId,
      id,
      selections[variant.platform] ?? null,
      variant.platform,
      status === "SCHEDULED" ? "QUEUED" : "PENDING",
      scheduled?.toISOString() ?? null,
      json({
        schema: "kasitek-content-delivery-v1",
        platform: variant.platform,
        media: media.map((item) => ({
          assetId: item.assetId,
          sortOrder: item.sortOrder ?? null,
          altText: item.altText ?? null,
        })),
      }),
    ]);
  }
}
export function createSocialPost(
  pool: Pool,
  userId: string,
  orgId: string,
  request: SocialPostUpsertRequest,
): Promise<SocialPost> {
  return createSocialPostIdempotent(pool, userId, orgId, request);
}
export async function createSocialPostIdempotent(
  pool: Pool,
  userId: string,
  orgId: string,
  request: SocialPostUpsertRequest,
  idempotencyKey?: string | null,
): Promise<SocialPost> {
  const content = request.content?.trim() ?? "";
  const channels = (request.channels ?? []).filter(isValidPlatform);
  if (!channels.length)
    throw bad("At least one publishing channel is required");
  const status = request.status ?? "DRAFT";
  if (!POST_STATUSES.includes(status)) throw bad("Invalid post status");
  const scheduled = parseOptionalDatetime(request.scheduledFor);
  const primary = await validatePrimaryChannel(
    pool,
    orgId,
    request.primaryChannelId,
  );
  const selections = await validateChannelSelections(
    pool,
    orgId,
    channels,
    request.channelSelections,
  );
  const media = await validateMedia(pool, orgId, request.media);
  if (!content && !media.length)
    throw bad("Add post text or attach at least one image or video");
  const variants = normalizeVariants(request.variants, channels, content);
  const key = trimmed(idempotencyKey);
  if (key && Buffer.byteLength(key) > 240)
    throw bad("Content draft idempotency key is too long");
  if (key) {
    const existing = (await pool.query<{ id: string }>(SQL[10], [orgId, key]))
      .rows[0];
    if (existing) {
      const post = await getSocialPost(pool, orgId, existing.id);
      if (!post) throw internal("Idempotent content draft disappeared");
      return post;
    }
  }
  let metadata = request.metadata ?? null;
  if (key) {
    metadata = metadata ?? {};
    if (
      typeof metadata !== "object" ||
      metadata instanceof SerdeFloat ||
      Array.isArray(metadata)
    )
      throw bad("Content metadata must be a JSON object");
    metadata = { ...(metadata as object), _kasitek_agent_idempotency_key: key };
  }
  const title = trimmed(request.title) ?? generatedSocialPostTitle(content);
  const id = createId();
  const createdId = await transaction(pool, async (tx) => {
    if (key) {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `kasitek.content.draft:${orgId}:${key}`,
      ]);
      const existing = (await tx.query<{ id: string }>(SQL[11], [orgId, key]))
        .rows[0];
      if (existing) return existing.id;
    }
    await tx.query(SQL[12], [
      id,
      userId,
      orgId,
      primary,
      title,
      trimmed(request.prompt),
      content,
      channels,
      status,
      scheduled?.toISOString() ?? null,
      json(metadata),
    ]);
    await persistMedia(tx, id, media);
    await createVariantsAndJobs(
      tx,
      userId,
      orgId,
      id,
      variants,
      selections,
      media,
      status,
      scheduled,
    );
    return id;
  });
  const post = await getSocialPost(pool, orgId, createdId);
  if (!post)
    throw internal(
      createdId === id
        ? "Failed to load created social post"
        : "Idempotent content draft disappeared",
    );
  return post;
}
export async function updateSocialPost(
  pool: Pool,
  userId: string,
  orgId: string,
  postId: string,
  request: SocialPostUpsertRequest,
): Promise<SocialPost> {
  const existing = await getSocialPost(pool, orgId, postId);
  if (!existing) throw missing("Post not found");
  const content = request.content?.trim() ?? existing.content;
  const channels = (request.channels ?? existing.channels).filter(
    isValidPlatform,
  );
  if (!channels.length)
    throw bad("At least one publishing channel is required");
  const status = request.status ?? existing.status;
  if (!POST_STATUSES.includes(status)) throw bad("Invalid post status");
  const scheduled =
    request.scheduledFor != null
      ? parseOptionalDatetime(request.scheduledFor)
      : existing.scheduled_for;
  const primary = await validatePrimaryChannel(
    pool,
    orgId,
    request.primaryChannelId ?? existing.primary_channel_id,
  );
  const selections = await validateChannelSelections(
    pool,
    orgId,
    channels,
    request.channelSelections,
  );
  const media =
    request.media != null
      ? await validateMedia(pool, orgId, request.media)
      : existing.media.map((item) => ({
          assetId: item.asset_id,
          sortOrder: item.sort_order,
          altText: item.alt_text,
          metadata: item.metadata,
        }));
  if (!content && !media.length)
    throw bad("Add post text or attach at least one image or video");
  const title = trimmed(request.title) ?? generatedSocialPostTitle(content);
  const variants = normalizeVariants(request.variants, channels, content);
  await transaction(pool, async (tx) => {
    await tx.query(SQL[13], [
      primary,
      title,
      trimmed(request.prompt) ?? existing.prompt,
      content,
      channels,
      status,
      scheduled?.toISOString() ?? null,
      json(request.metadata ?? existing.metadata),
      postId,
      orgId,
    ]);
    await tx.query(SQL[14], [postId]);
    await tx.query(SQL[15], [postId]);
    await tx.query(SQL[16], [postId]);
    await persistMedia(tx, postId, media);
    await createVariantsAndJobs(
      tx,
      userId,
      orgId,
      postId,
      variants,
      selections,
      media,
      status,
      scheduled,
    );
  });
  const post = await getSocialPost(pool, orgId, postId);
  if (!post) throw internal("Failed to load updated social post");
  return post;
}
export async function deleteSocialPost(
  pool: Pool,
  orgId: string,
  postId: string,
): Promise<boolean> {
  return (await pool.query(SQL[17], [postId, orgId])).rowCount === 1;
}
function rfc3339(value: Date) {
  return value.toISOString().replace(/Z$/, "+00:00");
}
export async function getSocialPostActivity(
  pool: Pool,
  orgId: string,
  postId: string,
): Promise<unknown | undefined> {
  const post = await getSocialPost(pool, orgId, postId);
  if (!post) return undefined;
  const events: Record<string, unknown>[] = [];
  const event = (
    id: string,
    type: string,
    status: string,
    time: Date,
    source: string,
    extra: Record<string, unknown> = {},
  ) =>
    events.push({
      id,
      type,
      status,
      occurredAt: rfc3339(time),
      source,
      ...extra,
    });
  event(
    `post:${post.id}:created`,
    "post.created",
    "DRAFT",
    post.created_at,
    "content",
  );
  if (epochMicros(post.updated_at) > epochMicros(post.created_at))
    event(
      `post:${post.id}:updated`,
      "post.updated",
      post.status,
      post.updated_at,
      "content",
    );
  if (post.scheduled_for)
    event(
      `post:${post.id}:scheduled`,
      "post.scheduled",
      "SCHEDULED",
      post.scheduled_for,
      "content",
    );
  if (post.published_at)
    event(
      `post:${post.id}:published`,
      "post.published",
      "PUBLISHED",
      post.published_at,
      "content",
    );
  for (const job of post.publishJobs) {
    const extra = { platform: job.platform };
    event(
      `job:${job.id}:created`,
      "provider.job.created",
      job.status,
      job.created_at,
      "provider",
      extra,
    );
    if (job.scheduled_for)
      event(
        `job:${job.id}:scheduled`,
        "provider.job.scheduled",
        "QUEUED",
        job.scheduled_for,
        "provider",
        extra,
      );
    if (job.published_at)
      event(
        `job:${job.id}:published`,
        "provider.job.published",
        "PUBLISHED",
        job.published_at,
        "provider",
        extra,
      );
    if (job.error_message != null)
      event(
        `job:${job.id}:failure`,
        "provider.job.failed",
        "FAILED",
        job.updated_at,
        "provider",
        { ...extra, message: job.error_message },
      );
  }
  events.sort((a, b) =>
    String(a.occurredAt) < String(b.occurredAt)
      ? 1
      : String(a.occurredAt) > String(b.occurredAt)
        ? -1
        : 0,
  );
  return { postId: post.id, events };
}
