import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import { ApiError } from "../../error.js";
import { createId } from "@paralleldrive/cuid2";
import {
  canonicalJson,
  wireInteger,
  SerdeFloat,
} from "@kasitek-labs/server-support/json";
import { transaction } from "../../db.js";
import { epochMicros } from "../../analytics/facts.js";
import { SQL } from "./posts-sql.js";
import { lockReviewedSocialAccounts } from "./account-admission.js";
import { getSocialChannel } from "./channels.js";
import {
  bad,
  missing,
  internal,
  trimmed,
  isValidPlatform,
  VARIANT_STATUSES,
  parseOptionalDatetime,
  validatePostSchedule,
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
function postMetadata(requested: unknown, existing: unknown = null): unknown {
  if (requested == null) return existing;
  if (typeof requested !== "object" || Array.isArray(requested) || requested instanceof SerdeFloat)
    throw bad("Content metadata must be a JSON object");
  const publicFields = Object.fromEntries(Object.entries(requested).filter(([key]) => !key.startsWith("_kasitek_")));
  const privateFields = existing && typeof existing === "object" && !Array.isArray(existing)
    ? Object.fromEntries(Object.entries(existing).filter(([key]) => key.startsWith("_kasitek_"))) : {};
  return { ...publicFields, ...privateFields };
}
export interface PostMutationOptions { expectedPostRevision?: string; expectedAccounts?: Record<string, string>; /** Trusted source for atomic reuse of legacy platform media associations. */ duplicateSourceId?: string; reusableVariantMedia?: {platform: string; media: {assetId: string; sortOrder?: number; altText?: string | null; crop?: unknown}[]}[] }
export async function lockSocialPost(tx: PoolClient, orgId: string, postId: string, options: PostMutationOptions = {}) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`growth.content.post:${orgId}:${postId}`]);
  const post = (await tx.query<{ id: string; updated_at: Date; status: string }>(
    'SELECT id,"updatedAt" AS updated_at,status::text FROM "SocialPost" WHERE id=$1 AND "orgId"=$2 FOR UPDATE', [postId, orgId],
  )).rows[0];
  if (!post) throw missing("Post not found");
  if (options.expectedPostRevision && epochMicros(post.updated_at) !== epochMicros(parseOptionalDatetime(options.expectedPostRevision)!))
    throw new ApiError(409, "conflict", "The reviewed content changed. Review it again before continuing");
  return post;
}
export async function refreshSocialPostPublishState(query: Pick<Pool, "query">, postId: string): Promise<void> {
  await query.query(`WITH state AS (
    SELECT COUNT(*) AS total,
      COUNT(*) FILTER(WHERE j.status='PUBLISHED' AND j."externalPostId" IS NOT NULL) AS published,
      COUNT(*) FILTER(WHERE j.status='PROCESSING' OR (j.status='PUBLISHED' AND j."externalPostId" IS NULL) OR (j.metadata->>'_kasitek_outcome'='UNKNOWN' AND NOT(j.status='PUBLISHED' AND j."externalPostId" IS NOT NULL))) AS processing,
      COUNT(*) FILTER(WHERE j.status='QUEUED') AS queued,
      COUNT(*) FILTER(WHERE j.status='FAILED') AS failed
    FROM "SocialPublishJob" j JOIN "SocialPost" p ON p.id=j."postId"
    WHERE p.id=$1 AND j.platform=ANY(p.channels)
  ), next AS (SELECT (CASE
    WHEN state.total>0 AND state.total=state.published THEN 'PUBLISHED'
    WHEN state.processing>0 THEN 'PROCESSING'
    WHEN state.queued>0 THEN CASE WHEN p."scheduledFor">NOW() AND state.published=0 AND state.failed=0 THEN 'SCHEDULED' ELSE 'PROCESSING' END
    WHEN state.failed>0 OR state.published>0 THEN 'FAILED'
    ELSE 'DRAFT' END)::"SocialPostStatus" AS status FROM state JOIN "SocialPost" p ON p.id=$1)
  UPDATE "SocialPost" p SET status=next.status,
    "publishedAt"=CASE WHEN next.status='PUBLISHED' THEN COALESCE(p."publishedAt",NOW()) ELSE p."publishedAt" END,
    "updatedAt"=NOW() FROM next WHERE p.id=$1
    AND (p.status IS DISTINCT FROM next.status OR (next.status='PUBLISHED' AND p."publishedAt" IS NULL))`, [postId]);
}
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
  page?: { limit: number; afterId?: string; search?: string; status?: string },
): Promise<SocialPost[]> {
  const posts = (
    await pool.query<SocialPostRow>(
      page ? SQL[0].replace('AND id = $2', 'AND ($2::text IS NULL OR id > $2) AND ($3::text IS NULL OR strpos(lower(coalesce(title, \'\') || \' \' || content), lower($3)) > 0) AND ($4::text IS NULL OR status::text = $4) ORDER BY id LIMIT $5') : postId === undefined ? SQL[1] : SQL[0],
      page ? [orgId, page.afterId ?? null, page.search ?? null, page.status ?? null, page.limit] : postId === undefined ? [orgId] : [orgId, postId],
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
export function listSocialPosts(pool: Pool, orgId: string, page?: { limit: number; afterId?: string; search?: string; status?: string }) {
  return loadPosts(pool, orgId, undefined, page);
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
  requireSelection: boolean,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const platform of channels) {
    const id = trimmed(selections?.[platform]);
    if (!id) {
      if (!requireSelection) continue;
      throw bad(`Choose a connected ${platform.toLowerCase()} account before scheduling`);
    }
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
    await pool.query<{ id: string; defaultAltText: string | null }>(SQL[8].replace("SELECT id", 'SELECT id,"defaultAltText"'), [orgId, ids])
  ).rows;
  if (ids.some((id) => !available.some(asset => asset.id === id)))
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
    altText: trimmed(item.altText === undefined ? available.find(asset => asset.id === item.assetId.trim())?.defaultAltText : item.altText),
  }));
  media.sort((a, b) => a.sortOrder! - b.sortOrder!);
  return media.map((item, index) => ({ ...item, sortOrder: index }));
}
/** New attachments require active assets; archived assets already attached to this post remain usable. */
async function lockMediaAdmission(tx: PoolClient, orgId: string, media: SocialMediaInput[], retainedIds: string[] = []) {
  if (!media.length) return;
  const assets = (await tx.query<{id: string; archivedAt: Date | null; defaultAltText: string | null}>(
    `SELECT id,"archivedAt","defaultAltText" FROM "ContentMediaAsset" WHERE "orgId"=$1 AND id=ANY($2::text[]) AND kind::text IN('IMAGE','VIDEO') AND "processingStatus"::text='READY' AND "scanStatus"::text='CLEAN' ORDER BY id FOR SHARE`,
    [orgId, media.map(item => item.assetId)],
  )).rows;
  for (const item of media) {
    const asset = assets.find(row => row.id === item.assetId);
    if (!asset || asset.archivedAt && !retainedIds.includes(item.assetId)) throw new ApiError(409, "media_unavailable", "Restore or replace archived media before attaching it to a new post");
  }
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
  options: PostMutationOptions = {},
): Promise<SocialPost> {
  const content = request.content?.trim() ?? "";
  const channels = (request.channels ?? []).filter(isValidPlatform);
  if (!channels.length)
    throw bad("At least one publishing channel is required");
  const status = request.status ?? "DRAFT";
  if (!["DRAFT", "SCHEDULED"].includes(status)) throw bad("New posts must be drafts or scheduled");
  const scheduled = status === "SCHEDULED" ? parseOptionalDatetime(request.scheduledFor) : null;
  validatePostSchedule(status, scheduled);
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
    status === "SCHEDULED",
  );
  const media = await validateMedia(pool, orgId, request.media);
  if (!content && !media.length)
    throw bad("Add post text or attach at least one image or video");
  const variants = normalizeVariants(request.variants, channels, content);
  const key = trimmed(idempotencyKey);
  const requestDigest = createHash("sha256").update(canonicalJson({ userId, orgId, content, channels,
    status, scheduledFor: scheduled?.toISOString() ?? null, primary, selections,
    media: media.map(item => ({ ...item, metadata: item.metadata ?? null })),
    variants: variants.map(item => ({ ...item, aiGenerated: item.aiGenerated ?? null, metadata: item.metadata ?? null })),
    title: trimmed(request.title) ?? generatedSocialPostTitle(content), prompt: trimmed(request.prompt), metadata: postMetadata(request.metadata),
  })).digest("hex");
  const assertReplay = (post: SocialPost) => {
    if (!post.metadata || typeof post.metadata !== "object" || Array.isArray(post.metadata) ||
      (post.metadata as Record<string, unknown>)._kasitek_agent_request_digest !== requestDigest) {
      throw new ApiError(409, "conflict", "Content draft idempotency key was reused for a different request");
    }
  };
  if (key && Buffer.byteLength(key) > 240)
    throw bad("Content draft idempotency key is too long");
  if (key) {
    const existing = (await pool.query<{ id: string }>(SQL[10], [orgId, key]))
      .rows[0];
    if (existing) {
      const post = await getSocialPost(pool, orgId, existing.id);
      if (!post) throw internal("Idempotent content draft disappeared");
      assertReplay(post);
      return post;
    }
  }
  let metadata = postMetadata(request.metadata);
  if (key) {
    metadata = metadata ?? {};
    if (
      typeof metadata !== "object" ||
      metadata instanceof SerdeFloat ||
      Array.isArray(metadata)
    )
      throw bad("Content metadata must be a JSON object");
    metadata = { ...(metadata as object), _kasitek_agent_idempotency_key: key, _kasitek_agent_request_digest: requestDigest };
  }
  const title = trimmed(request.title) ?? generatedSocialPostTitle(content);
  const id = createId();
  const createdId = await transaction(pool, async (tx) => {
    await lockReviewedSocialAccounts(tx, orgId, options.expectedAccounts);
    if (key) {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `kasitek.content.draft:${orgId}:${key}`,
      ]);
      const existing = (await tx.query<{ id: string }>(SQL[11], [orgId, key]))
        .rows[0];
      if (existing) return existing.id;
    }
    if (options.duplicateSourceId) await lockSocialPost(tx, orgId, options.duplicateSourceId, options);
    await lockMediaAdmission(tx, orgId, media);
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
    if (options.reusableVariantMedia?.length) {
      for (const override of options.reusableVariantMedia) {
        const variant = (await tx.query<{id: string}>('SELECT id FROM "SocialPostVariant" WHERE "postId"=$1 AND platform::text=$2', [id,override.platform])).rows[0];
        if (!variant) throw bad("Template media version must belong to the new draft");
        const rows = [];
        for (const [order,item] of override.media.entries()) {
          const attachment = (await tx.query<{id: string}>('SELECT id FROM "SocialPostMedia" WHERE "postId"=$1 AND "assetId"=$2',[id,item.assetId])).rows[0];
          if (!attachment) throw bad("Template version media must belong to its draft");
          await tx.query(`INSERT INTO "SocialPostVariantMedia"(id,"variantId","postMediaId","sortOrder","altText",crop,"createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6::jsonb,now(),now())`, [createId(),variant.id,attachment.id,order,item.altText ?? null,json(item.crop)]);
          rows.push({assetId:item.assetId,sortOrder:order,altText:item.altText ?? null});
        }
        await tx.query(`UPDATE "SocialPublishJob" SET "deliverySnapshot"=jsonb_build_object('schema','kasitek-content-delivery-v1','platform',platform::text,'media',$3::jsonb) WHERE "postId"=$1 AND "variantId"=$2`, [id,variant.id,json(rows)]);
      }
    }
    if (options.duplicateSourceId && media.length) {
      const overrides = (await tx.query<{variantId: string; postMediaId: string; sortOrder: number; altText: string | null; crop: unknown}>(`
        SELECT target.id AS "variantId",new_media.id AS "postMediaId",overrides."sortOrder",overrides."altText",overrides.crop
        FROM "SocialPostVariantMedia" overrides
        JOIN "SocialPostVariant" source ON source.id=overrides."variantId" AND source."postId"=$1
        JOIN "SocialPostMedia" old_media ON old_media.id=overrides."postMediaId" AND old_media."postId"=$1
        JOIN "SocialPostVariant" target ON target."postId"=$2 AND target.platform=source.platform
        JOIN "SocialPostMedia" new_media ON new_media."postId"=$2 AND new_media."assetId"=old_media."assetId"
        ORDER BY source.platform,overrides."sortOrder"`, [options.duplicateSourceId,id])).rows;
      for (const item of overrides) await tx.query(`INSERT INTO "SocialPostVariantMedia"(id,"variantId","postMediaId","sortOrder","altText",crop,"createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6::jsonb,now(),now())`, [createId(),item.variantId,item.postMediaId,item.sortOrder,item.altText,json(item.crop)]);
      for (const variantId of new Set(overrides.map(item => item.variantId))) {
        // Rebuild delivery media from new owned associations, retaining no provider delivery state.
        await tx.query(`UPDATE "SocialPublishJob" job SET "deliverySnapshot"=jsonb_build_object('schema','kasitek-content-delivery-v1','platform',job.platform::text,'media',(
          SELECT jsonb_agg(jsonb_build_object('assetId',m."assetId",'sortOrder',vm."sortOrder",'altText',vm."altText") ORDER BY vm."sortOrder")
          FROM "SocialPostVariantMedia" vm JOIN "SocialPostMedia" m ON m.id=vm."postMediaId" WHERE vm."variantId"=$1)) WHERE job."postId"=$2 AND job."variantId"=$1`,[variantId,id]);
      }
    }
    if (options.duplicateSourceId && media.length) {
      await tx.query(`UPDATE "SocialPublishJob" target SET "deliverySnapshot"=jsonb_set(target."deliverySnapshot",'{media}','[]'::jsonb)
        WHERE target."postId"=$2 AND EXISTS (SELECT 1 FROM "SocialPublishJob" source WHERE source."postId"=$1 AND source.platform=target.platform
          AND jsonb_typeof(source."deliverySnapshot"->'media')='array' AND source."deliverySnapshot"->'media'='[]'::jsonb)`, [options.duplicateSourceId,id]);
    }
    return id;
  });
  const post = await getSocialPost(pool, orgId, createdId);
  if (!post)
    throw internal(
      createdId === id
        ? "Failed to load created social post"
        : "Idempotent content draft disappeared",
    );
  if (key && createdId !== id) assertReplay(post);
  return post;
}
export async function updateSocialPost(
  pool: Pool,
  userId: string,
  orgId: string,
  postId: string,
  request: SocialPostUpsertRequest,
  options: PostMutationOptions = {},
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
  if (!["DRAFT", "SCHEDULED"].includes(status))
    throw new ApiError(409, "conflict", "Published or processing content cannot be edited. Create a new draft instead");
  const scheduled = status === "DRAFT" ? null :
    request.scheduledFor != null
      ? parseOptionalDatetime(request.scheduledFor)
      : existing.scheduled_for;
  validatePostSchedule(status, scheduled);
  const primary = await validatePrimaryChannel(
    pool,
    orgId,
    request.primaryChannelId ?? existing.primary_channel_id,
  );
  const requestedSelections = request.channelSelections === undefined
    ? Object.fromEntries(existing.publishJobs.filter(job => job.channel_connection_id).map(job => [job.platform, job.channel_connection_id!]))
    : request.channelSelections;
  const selections = await validateChannelSelections(
    pool,
    orgId,
    channels,
    requestedSelections,
    status === "SCHEDULED",
  );
  const media =
    request.media != null
      ? await validateMedia(pool, orgId, request.media.map(item => {
          const retained = existing.media.find(saved => saved.asset_id === item.assetId.trim());
          return item.altText === undefined && retained ? {...item, altText: retained.alt_text} : item;
        }))
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
    const locked = await lockSocialPost(tx, orgId, postId, options);
    await lockReviewedSocialAccounts(tx, orgId, options.expectedAccounts);
    if (epochMicros(locked.updated_at) !== epochMicros(existing.updated_at))
      throw new ApiError(409, "conflict", "This post changed. Reload it before saving");
    const jobs = (await tx.query<{ id: string; variant_id: string | null; platform: string; status: string; external_post_id: string | null; metadata: Record<string, unknown> | null }>(
      'SELECT id,"variantId" AS variant_id,platform::text,status::text,"externalPostId" AS external_post_id,metadata FROM "SocialPublishJob" WHERE "postId"=$1 FOR UPDATE', [postId],
    )).rows;
    if (jobs.some(job => job.metadata?._kasitek_delegation != null && job.status !== "CANCELED"))
      throw new ApiError(409, "conflict", "Unschedule this post before editing");
    if (jobs.some(job => !["PENDING", "QUEUED", "CANCELED"].includes(job.status) || job.external_post_id || job.metadata?._kasitek_outcome === "UNKNOWN"))
      throw new ApiError(409, "conflict", "Content with a publishing attempt cannot be edited. Create a new draft instead");
    await lockMediaAdmission(tx, orgId, media, existing.media.map(item => item.asset_id));
    await tx.query(SQL[13], [
      primary,
      title,
      trimmed(request.prompt) ?? existing.prompt,
      content,
      channels,
      status,
      scheduled?.toISOString() ?? null,
      json(postMetadata(request.metadata, existing.metadata)),
      postId,
      orgId,
    ]);
    await tx.query(SQL[16], [postId]);
    await persistMedia(tx, postId, media);
    for (const variant of variants) {
      const job = jobs.find(candidate => candidate.platform === variant.platform);
      if (!job) {
        await createVariantsAndJobs(tx, userId, orgId, postId, [variant], selections, media, status, scheduled);
        continue;
      }
      const variantId = job.variant_id ?? createId();
      if (job.variant_id) {
        await tx.query('UPDATE "SocialPostVariant" SET content=$2,status=$3::"SocialVariantStatus","aiGenerated"=$4,metadata=$5,"updatedAt"=NOW() WHERE id=$1 AND "postId"=$6',
          [variantId, variant.content, variant.status ?? "DRAFT", variant.aiGenerated ?? false, json(variant.metadata), postId]);
      } else {
        await tx.query(SQL[6], [variantId, postId, variant.platform, variant.content, variant.status ?? "DRAFT", variant.aiGenerated ?? false, json(variant.metadata)]);
      }
      await tx.query('UPDATE "SocialPublishJob" SET "variantId"=$2,"channelConnectionId"=$3,status=$4::"SocialPublishJobStatus","scheduledFor"=$5,"deliverySnapshot"=$6,"errorMessage"=NULL,"updatedAt"=NOW() WHERE id=$1',
        [job.id, variantId, selections[variant.platform], status === "SCHEDULED" ? "QUEUED" : "PENDING", status === "SCHEDULED" ? scheduled?.toISOString() : null,
          json({ schema: "kasitek-content-delivery-v1", platform: variant.platform, media: media.map(item => ({ assetId: item.assetId, sortOrder: item.sortOrder ?? null, altText: item.altText ?? null })) })]);
    }
    await tx.query('UPDATE "SocialPublishJob" SET status=\'CANCELED\'::"SocialPublishJobStatus","updatedAt"=NOW() WHERE "postId"=$1 AND NOT(platform::text=ANY($2::text[])) AND status IN(\'PENDING\',\'QUEUED\')', [postId, channels]);
  });
  const post = await getSocialPost(pool, orgId, postId);
  if (!post) throw internal("Failed to load updated social post");
  return post;
}
export async function deleteSocialPost(
  pool: Pool,
  orgId: string,
  postId: string,
  options: PostMutationOptions = {},
): Promise<boolean> {
  return transaction(pool, async tx => {
    const found = (await tx.query('SELECT id FROM "SocialPost" WHERE id=$1 AND "orgId"=$2', [postId, orgId])).rows[0];
    if (!found) return false;
    await lockSocialPost(tx, orgId, postId, options);
    if ((await tx.query(`SELECT id FROM "SocialPublishJob" WHERE "postId"=$1 AND (status='PROCESSING' OR COALESCE(metadata->>'_kasitek_outcome','')='UNKNOWN' OR metadata->'_kasitek_delete_intent'->>'state' IN('executing','uncertain') OR metadata->'_kasitek_edit_intent'->>'state' IN('executing','uncertain')) LIMIT 1`, [postId])).rows.length)
      throw new ApiError(409, "conflict", "Publishing is in progress or its outcome requires reconciliation");
    return (await tx.query(SQL[17], [postId, orgId])).rowCount === 1;
  });
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
