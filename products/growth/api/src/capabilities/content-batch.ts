import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import { canonicalJson, wireInteger } from "@kasitek-labs/server-support/json";
import type { RequestContext } from "../identity/request-context.js";
import { resolveDeliveryMedia } from "../services/social/delivery-media.js";
import type { SocialPost } from "../services/social/types.js";
import { getSocialPost, lockSocialPost, refreshSocialPostPublishState } from "../services/social/posts.js";
import { syncOrgConnections } from "../services/connections.js";
import { syncPermissionInventory } from "../integrations/connection-permissions.js";
import { transaction } from "../db.js";
import { ApiError } from "../error.js";
import { SUPPORTED_PLATFORMS } from "./content-adapter.js";
import { SQL } from "./content-batch-sql.js";
import { lockReviewedSocialAccounts, lockSocialPublicationAccounts, stampSocialPublicationAccounts } from "../services/social/account-admission.js";
import { delegatedSocialAuthority } from "../operations/delegation.js";
type Row = Record<string, any>;
export interface PublishBatchTarget {
  platform: string;
  accountName: string;
  handle: string | null;
  state: string;
  status: string;
  requiredCapability: string;
  remediationMode: string;
  reasonCode?: string;
  message?: string;
}
export interface TargetPlan extends PublishBatchTarget {
  jobId: string;
  channelConnectionId: string | null;
  accountRevision?: string | null;
  externalAccountId?: string | null;
}
const bad = (message: string) => new ApiError(400, "bad_request", message),
  conflict = (message: string) => new ApiError(409, "conflict", message);
const metadata = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
export function remediationMode(
  state: string,
  reason?: string,
  retryable = false,
): string {
  return (
    (
      {
        MISSING_ACCESS: "GRANT_ACCESS",
        RECONNECT_REQUIRED: "RECONNECT",
        UNHEALTHY: "CHECK_CONNECTION",
        INVALID_MEDIA: "FIX_MEDIA",
        INVALID_CONTENT: "FIX_CONTENT",
        UNSUPPORTED: "REMOVE_TARGET",
        IN_PROGRESS: "WAIT",
        PROCESSING: "WAIT",
        QUEUED: "WAIT",
        UNKNOWN: "RECONCILE",
        CANCELED: "RECREATE_DRAFT",
      } as Row
    )[state] ??
    (state === "FAILED"
      ? retryable
        ? "RETRY"
        : "REVIEW"
      : state === "BLOCKED"
        ? reason === "publish_job_canceled"
          ? "RECREATE_DRAFT"
          : "REVIEW"
        : "NONE")
  );
}
export function safeErrorMessage(
  value: string | null | undefined,
): string | undefined {
  const message = value?.trim();
  if (!message) return undefined;
  if (
    [
      "access_token",
      "refresh_token",
      "bearer ",
      "client_secret",
      "private_key",
    ].some((key) => message.toLowerCase().includes(key))
  )
    return "The provider returned an error while publishing this target";
  return Array.from(message).slice(0, 240).join("");
}
export function platformMediaError(
  platform: string,
  kinds: string[],
  count: number,
): [string, string] | undefined {
  const imageOnly = [
    "FACEBOOK",
    "THREADS",
    "INSTAGRAM",
    "LINKEDIN",
    "BLUESKY",
    "X",
  ].includes(platform);
  const max = ["BLUESKY", "X"].includes(platform) ? 4 : 1;
  if (!imageOnly && platform !== "TIKTOK")
    return [
      "unsupported_platform",
      "This provider is not supported for batch publishing",
    ];
  if (count > max)
    return [
      "media_count_exceeded",
      `${platform} accepts at most ${max} media item${max === 1 ? "" : "s"}`,
    ];
  if (imageOnly && kinds.some((kind) => kind !== "IMAGE"))
    return [
      "media_type_unsupported",
      `${platform} accepts image attachments only`,
    ];
  if (
    platform === "TIKTOK" &&
    kinds.some((kind) => !["IMAGE", "VIDEO"].includes(kind))
  )
    return [
      "media_type_unsupported",
      `${platform} accepts image or video attachments only`,
    ];
  return undefined;
}
export function textLengthError(
  platform: string,
  text: string,
): [string, string] | undefined {
  const max = (
    { BLUESKY: 300, X: 280, LINKEDIN: 3000, THREADS: 500 } as Record<string, number>
  )[platform];
  return max !== undefined && Array.from(text).length > max
    ? ["text_length_exceeded", `${platform} accepts at most ${max} characters`]
    : undefined;
}
export function aggregateBatchStatus(
  ...raw: [
    number | bigint,
    number | bigint,
    number | bigint,
    number | bigint,
    number | bigint,
    number | bigint,
    number | bigint,
    number | bigint,
  ]
): string {
  const [
    total,
    published,
    processing,
    queued,
    unknown,
    failed,
    blocked,
    canceled,
  ] = raw.map(BigInt) as [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  if (total === 0n) return "FAILED";
  if (published === total) return "SUCCEEDED";
  if (blocked === total) return "BLOCKED";
  if (unknown > 0n) return "UNKNOWN";
  if (processing > 0n || queued > 0n) return "PROCESSING";
  if (published > 0n && failed + blocked + canceled > 0n) return "PARTIAL";
  if (failed + canceled === total) return "FAILED";
  if (blocked > 0n && failed === 0n && canceled === 0n) return "BLOCKED";
  return "PARTIAL";
}
export function postSnapshotHash(
  post: SocialPost,
  targets: (Pick<TargetPlan, "jobId" | "platform" | "channelConnectionId"> & Partial<Pick<TargetPlan, "accountRevision" | "externalAccountId">>)[],
): string {
  const snapshot = targets
    .map(({ jobId, platform, channelConnectionId, accountRevision, externalAccountId }) => ({
      jobId,
      platform,
      channelConnectionId,
      accountRevision: accountRevision ?? null,
      externalAccountId: externalAccountId ?? null,
    }))
    .sort((a, b) =>
      canonicalJson(a) < canonicalJson(b)
        ? -1
        : canonicalJson(a) > canonicalJson(b)
          ? 1
          : 0,
    );
  return createHash("sha256")
    .update(
      canonicalJson({
        postId: post.id,
        content: post.content,
        publishingOptions: Object.fromEntries(["instagramImageUrl", "tiktokMediaUrl", "tiktokMediaType", "tiktokPrivacyLevel", "tiktokConsent"].map(key => [key, metadata(post.metadata)[key] ?? null])),
        channels: post.channels,
        variants: post.variants.map((v) => ({
          id: v.id,
          platform: v.platform,
          content: v.content,
          status: v.status,
        })),
        media: post.media.map((m) => ({
          assetId: m.asset_id,
          kind: m.kind,
          sortOrder: m.sort_order,
          altText: m.alt_text,
          processingStatus: m.processing_status,
          scanStatus: m.scan_status,
        })),
        deliveryMedia: post.publishJobs.map(job => ({ id: job.id, deliverySnapshot: job.deliverySnapshot ?? null })),
        targets: snapshot,
      }),
    )
    .digest("hex");
}
function permissionFailure(
  channel: Row | undefined,
  cap: string,
): [string, string, string] | undefined {
  if (!channel)
    return [
      "RECONNECT_REQUIRED",
      "connection_not_found",
      "The configured account could not be found",
    ];
  if (channel.channel_status !== "CONNECTED")
    return [
      "RECONNECT_REQUIRED",
      "connection_not_connected",
      "This account needs to be reconnected before publishing",
    ];
  if (
    channel.external_status === "NEEDS_ATTENTION" ||
    channel.health_status === "NEEDS_ATTENTION"
  )
    return [
      "UNHEALTHY",
      "connection_needs_attention",
      "This account needs attention before publishing",
    ];
  switch (
    cap === "MEDIA_PUBLISH"
      ? channel.media_permission_state
      : channel.social_permission_state
  ) {
    case "GRANTED":
      return;
    case "UNSUPPORTED":
      return [
        "UNSUPPORTED",
        "provider_capability_unsupported",
        "This account does not support the required publishing access",
      ];
    case "REQUESTABLE":
    case "NOT_GRANTED":
      return [
        "MISSING_ACCESS",
        "missing_provider_permission",
        `Grant ${cap} access for this account`,
      ];
    case "REQUIRES_PROVIDER_APPROVAL":
      return [
        "MISSING_ACCESS",
        "requires_provider_approval",
        "The provider has not approved the required access for this app",
      ];
    default:
      return [
        "UNKNOWN",
        "permission_status_unknown",
        "The required account access could not be verified",
      ];
  }
}
async function requirePost(
  pool: Pool,
  ctx: RequestContext,
  id: string,
): Promise<SocialPost> {
  const post = await getSocialPost(pool, ctx.organizationId, id);
  if (!post) throw new ApiError(404, "not_found", "Content post not found");
  return post;
}
export async function preflightInternal(
  pool: Pool,
  ctx: RequestContext,
  id: string,
  options: { syncConnections?: boolean } = {},
): Promise<{
  post: SocialPost;
  status: string;
  snapshotHash: string;
  mediaCount: number;
  targets: TargetPlan[];
}> {
  if (options.syncConnections !== false) {
    await syncOrgConnections(pool, ctx.organizationId);
    await syncPermissionInventory(pool, ctx.organizationId);
  }
  const post = await requirePost(pool, ctx, id);
  const jobs = post.publishJobs
    .filter((job) => post.channels.includes(job.platform))
    .sort((a, b) =>
      a.platform < b.platform
        ? -1
        : a.platform > b.platform
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
    );
  if (!jobs.length)
    throw bad("Content post has no configured publishing targets");
  if (
    post.channels.some(
      (platform) => !jobs.some((job) => job.platform === platform),
    )
  )
    throw bad(
      "Content post targets are incomplete; recreate the draft before publishing",
    );
  const ids = jobs
    .map((job) => job.channel_connection_id)
    .filter((id): id is string => id !== null);
  const channels = new Map<string, Row>(
    (ids.length
      ? (
          await pool.query(SQL.load_channel_access[0], [
            ctx.organizationId,
            ids,
          ])
        ).rows
      : []
    ).map((row) => [row.id, row]),
  );
  const mediaCount = post.media.length;
  const common = post.media.map(item => ({ ...item, assetId: item.asset_id, altText: item.alt_text, sortOrder: item.sort_order }));
  const owned = mediaCount ? new Set((await pool.query<{id: string}>('SELECT id FROM "ContentMediaAsset" WHERE "orgId"=$1 AND id=ANY($2::text[])', [ctx.organizationId, common.map(item => item.assetId)])).rows.map(row => row.id)) : new Set<string>();
  const targets: TargetPlan[] = jobs.map((job) => {
    let selected = common;
    let selectionError: [string, string] | undefined;
    try {
      if (job.status !== "PUBLISHED" && common.some(item => !owned.has(item.assetId))) throw new ApiError(409, "delivery_media_invalid", "Publishing media must belong to this workspace");
      selected = resolveDeliveryMedia(job, common);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "delivery_media_invalid") throw error;
      selected = [];
      selectionError = [error.code, error.message];
    }
    const targetMediaCount = selected.length;
    const ready = selected.every(media => media.processing_status === "READY" && media.scan_status === "CLEAN");
    const cap = targetMediaCount ? "MEDIA_PUBLISH" : "SOCIAL_PUBLISH",
      channel = job.channel_connection_id
        ? channels.get(job.channel_connection_id)
        : undefined;
    let state = "READY",
      status = "READY",
      reasonCode: string | undefined,
      message: string | undefined;
    const fail = (tuple: [string, string, string]) => {
      [state, reasonCode, message] = tuple;
      status = "BLOCKED";
    };
    const content =
      post.variants.find((v) => v.id === job.variant_id)?.content ??
      post.content;
    if (job.status === "PUBLISHED" && job.external_post_id !== null) {
      state = "ALREADY_PUBLISHED";
      status = "PUBLISHED";
    } else if (job.status === "PUBLISHED" || metadata(job.metadata)._kasitek_outcome === "UNKNOWN") {
      state = status = "UNKNOWN";
      reasonCode = "provider_outcome_unknown";
      message =
        "The provider did not confirm the result; reconcile before retrying";
    } else if (["PROCESSING", "QUEUED"].includes(job.status)) {
      state = "IN_PROGRESS";
      status = job.status;
      reasonCode = "publish_already_in_progress";
      message = "A publish attempt is already in progress for this account";
    } else if (job.status === "CANCELED")
      fail([
        "BLOCKED",
        "publish_job_canceled",
        "This publish target was canceled and must be recreated",
      ]);
    else {
      const permission = permissionFailure(channel, cap),
        mediaError = platformMediaError(
          job.platform,
          selected.map((m) => m.kind),
          targetMediaCount,
        ),
        textError = textLengthError(job.platform, content);
      const url = metadata(post.metadata)[
        job.platform === "INSTAGRAM" ? "instagramImageUrl" : "tiktokMediaUrl"
      ];
      if (permission) fail(permission);
      else if (selectionError) fail(["INVALID_MEDIA", ...selectionError]);
      else if (!ready)
        fail([
          "INVALID_MEDIA",
          "media_not_ready",
          "Every attached media item must be ready and pass the safety scan",
        ]);
      else if (
        ["INSTAGRAM", "TIKTOK"].includes(job.platform) &&
        targetMediaCount === 0 &&
        !(typeof url === "string" && url.trim())
      )
        fail([
          "INVALID_MEDIA",
          "media_required",
          `${job.platform} requires an attached media item or a provider media URL`,
        ]);
      else if (mediaError) fail(["INVALID_MEDIA", ...mediaError]);
      else if (textError) fail(["INVALID_CONTENT", ...textError]);
      else if (
        !SUPPORTED_PLATFORMS.includes(
          job.platform as (typeof SUPPORTED_PLATFORMS)[number],
        )
      )
        fail([
          "UNSUPPORTED",
          "unsupported_platform",
          "This provider is not supported for batch publishing",
        ]);
    }
    return {
      jobId: job.id,
      channelConnectionId: job.channel_connection_id,
      accountRevision: channel?.updated_at?.toISOString() ?? null,
      externalAccountId: channel?.external_account_id ?? null,
      platform: job.platform,
      accountName: channel?.display_name ?? `${job.platform} account`,
      handle: channel?.handle ?? null,
      state,
      status,
      requiredCapability: cap,
      remediationMode: remediationMode(state, reasonCode),
      ...(reasonCode ? { reasonCode } : {}),
      ...(message ? { message } : {}),
    };
  });
  const status = targets.some((t) => t.state === "UNKNOWN")
    ? "UNKNOWN"
    : targets.some((t) => t.state === "IN_PROGRESS")
      ? "PROCESSING"
      : targets.some((t) => !["READY", "ALREADY_PUBLISHED"].includes(t.state))
        ? "BLOCKED"
        : "READY";
  return {
    post,
    status,
    snapshotHash: postSnapshotHash(post, targets),
    mediaCount,
    targets,
  };
}
export async function preflight(
  pool: Pool,
  ctx: RequestContext,
  id: string,
): Promise<unknown> {
  const plan = await preflightInternal(pool, ctx, id);
  return {
    postId: id,
    status: plan.status,
    snapshotHash: plan.snapshotHash,
    mediaCount: plan.mediaCount,
    targets: plan.targets.map(
      ({ jobId, channelConnectionId, ...view }) => view,
    ),
  };
}
async function loadBatch(pool: Pool, orgId: string, id: string): Promise<Row> {
  const row = (await pool.query(SQL.load_batch[0], [id, orgId])).rows[0];
  if (!row) throw new ApiError(404, "not_found", "Publish batch not found");
  return row;
}
export function batchTargetView(row: Row): PublishBatchTarget {
  const state =
    row.error_code === "provider_auth_required"
      ? "RECONNECT_REQUIRED"
      : row.error_code === "tiktok_publishing_consent_required"
        ? "MISSING_ACCESS"
        : ["PROCESSING", "QUEUED"].includes(row.status)
          ? "PROCESSING"
          : row.status;
  const message =
    safeErrorMessage(row.error_message) ??
    (row.status === "UNKNOWN"
      ? "The provider did not confirm the result; reconcile before retrying"
      : row.retryable
        ? "This target can be retried"
        : undefined);
  return {
    platform: row.platform,
    accountName: row.display_name ?? "Connected account",
    handle: row.handle,
    state,
    status: row.status,
    requiredCapability:
      metadata(row.metadata).requiredCapability ?? "SOCIAL_PUBLISH",
    remediationMode: remediationMode(
      state,
      row.error_code ?? undefined,
      row.retryable,
    ),
    ...(row.error_code !== null ? { reasonCode: row.error_code } : {}),
    ...(message ? { message } : {}),
  };
}
async function summary(pool: Pool, row: Row): Promise<Row> {
  const result: Row = {
    batchId: row.id,
    status: row.status,
    postId: row.post_id,
    snapshotHash: row.snapshot_hash,
    targets: (await pool.query(SQL.load_batch_targets[0], [row.id])).rows.map(
      batchTargetView,
    ),
  };
  for (const key of [
    "target",
    "published",
    "processing",
    "unknown",
    "failed",
    "blocked",
  ])
    result[`${key}Count`] = wireInteger(row[`${key}_count`]);
  if (row.error_code !== null) result.errorCode = row.error_code;
  const error = safeErrorMessage(row.error_message);
  if (error) result.errorMessage = error;
  if (row.completed_at !== null) result.completedAt = row.completed_at;
  return result;
}
export async function refreshBatchStatus(
  pool: Pool,
  id: string,
  orgId: string,
): Promise<Row> {
  await transaction(pool, async (tx) => {
    await tx.query(SQL.refresh_batch_status[0], [id]);
    const counts = (
      await tx.query({
        text: SQL.refresh_batch_status[1],
        values: [id],
        rowMode: "array",
      })
    ).rows[0]!.map(BigInt) as bigint[];
    const status = aggregateBatchStatus(
      ...(counts as [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ]),
    );
    await tx.query(SQL.refresh_batch_status[2], [
      id,
      status,
      counts[0],
      counts[1],
      counts[2]! + counts[3]!,
      counts[4],
      counts[5]! + counts[7]!,
      counts[6],
      orgId,
    ]);
    const post = (await tx.query<{ postId: string }>('SELECT "postId" FROM "SocialPublishBatch" WHERE id=$1 AND "orgId"=$2', [id, orgId])).rows[0];
    if (post) await refreshSocialPostPublishState(tx, post.postId);
  });
  return summary(pool, await loadBatch(pool, orgId, id));
}
export async function getBatch(
  pool: Pool,
  ctx: RequestContext,
  id: string,
): Promise<Row> {
  await loadBatch(pool, ctx.organizationId, id);
  return refreshBatchStatus(pool, id, ctx.organizationId);
}
export async function getLatestBatchForPost(
  pool: Pool,
  ctx: RequestContext,
  id: string,
): Promise<Row | null> {
  const batch = (
    await pool.query(SQL.get_latest_batch_for_post[0], [ctx.organizationId, id])
  ).rows[0];
  return batch ? getBatch(pool, ctx, batch.id) : null;
}
function idempotency(ctx: RequestContext, purpose: string): string {
  if (ctx.idempotencyKey === null)
    throw bad(`idempotency-key is required for ${purpose}`);
  return ctx.idempotencyKey;
}
export async function publishBatch(
  pool: Pool,
  ctx: RequestContext,
  id: string,
  expectedSnapshotHash?: string | null,
  options: import("../services/social/posts.js").PostMutationOptions & { platform?: string } = {},
): Promise<Row> {
  const key = idempotency(ctx, "batch content publishing");
  await syncOrgConnections(pool, ctx.organizationId);
  await syncPermissionInventory(pool, ctx.organizationId);
  let plan!: Awaited<ReturnType<typeof preflightInternal>>;
  const batchId = await transaction(pool, async (tx) => {
    await lockSocialPost(tx, ctx.organizationId, id, options);
    await lockSocialPublicationAccounts(tx, ctx.organizationId, id);
    await lockReviewedSocialAccounts(tx, ctx.organizationId, options.expectedAccounts);
    plan = await preflightInternal(pool, ctx, id, { syncConnections: false });
    if (expectedSnapshotHash != null && expectedSnapshotHash !== plan.snapshotHash)
      throw conflict("The approved content changed before publishing; review and approve the updated batch");
    if (options.platform) {
      plan.targets = plan.targets.filter(target => target.platform === options.platform);
      if (!plan.targets.length) throw bad("The selected platform is not configured for this post");
      plan.status = plan.targets.every(target => ["READY", "ALREADY_PUBLISHED"].includes(target.state)) ? "READY" : "BLOCKED";
    }
    await tx.query(SQL.publish_batch[0], [
      `kasitek.content.publish_batch:${ctx.organizationId}:${id}`,
    ]);
    const existing = (
      await tx.query(SQL.publish_batch[1], [ctx.organizationId, key])
    ).rows[0];
    if (existing) {
      const row = (await tx.query(SQL.publish_batch[2], [existing.id])).rows[0];
      const selection = (await tx.query<{ metadata: { requestedPlatform?: string | null } | null }>('SELECT metadata FROM "SocialPublishBatch" WHERE id=$1', [existing.id])).rows[0]?.metadata?.requestedPlatform ?? null;
      if (row.post_id !== id || row.snapshot_hash !== plan.snapshotHash)
        throw conflict(
          "This idempotency key was already used for a different content revision",
        );
      if (selection !== (options.platform ?? null)) throw conflict("This idempotency key was already used for different publishing destinations");
      return existing.id as string;
    }
    const batchId = createId(),
      allowed = plan.status === "READY";
    await tx.query(SQL.publish_batch[3], [
      batchId,
      plan.post.user_id,
      ctx.organizationId,
      id,
      plan.status,
      key,
      plan.snapshotHash,
      plan.targets.length,
      plan.targets.filter((t) => t.state === "ALREADY_PUBLISHED").length,
      plan.targets.filter((t) => t.state === "UNKNOWN").length,
      plan.targets.filter(
        (t) => !["READY", "ALREADY_PUBLISHED", "UNKNOWN"].includes(t.state),
      ).length,
    ]);
    await tx.query('UPDATE "SocialPublishBatch" SET metadata=COALESCE(metadata,\'{}\'::jsonb)||$2::jsonb WHERE id=$1', [batchId, canonicalJson({ requestedPlatform: options.platform ?? null })]);
    for (const t of plan.targets) {
      const status =
        t.state === "ALREADY_PUBLISHED"
          ? "PUBLISHED"
          : t.state === "READY" && allowed
            ? "QUEUED"
            : t.state === "IN_PROGRESS"
              ? "PROCESSING"
              : t.state === "UNKNOWN"
                ? "UNKNOWN"
                : "BLOCKED";
      const blocked = t.state === "READY" && !allowed;
      await tx.query(SQL.publish_batch[4], [
        createId(),
        batchId,
        t.jobId,
        t.platform,
        t.channelConnectionId,
        status,
        false,
        blocked ? "batch_preflight_blocked" : (t.reasonCode ?? null),
        blocked
          ? "This destination was not queued because another selected destination failed preflight"
          : (t.message ?? null),
        canonicalJson({ requiredCapability: t.requiredCapability }),
      ]);
      if (allowed && t.state === "READY")
        await tx.query(SQL.publish_batch[5], [
          t.jobId,
          canonicalJson({ _kasitek_batch_id: batchId, _kasitek_delegation: delegatedSocialAuthority(ctx, options.platform ? "content.posts.publish" : "content.posts.publish_batch") }),
          ctx.organizationId,
        ]);
      if (allowed && t.state === "READY")
        await tx.query('UPDATE "SocialPublishJob" SET "userId"=$2 WHERE id=$1', [t.jobId, ctx.userId]);
    }
    await stampSocialPublicationAccounts(tx, ctx.organizationId, id, plan.targets.filter(t => allowed && t.state === "READY").map(t => t.jobId));
    if (allowed && plan.targets.some((t) => t.state === "READY"))
      await tx.query(SQL.publish_batch[6], [id, ctx.organizationId]);
    return batchId;
  });
  const refreshed = await refreshBatchStatus(pool, batchId, ctx.organizationId);
  return {
    post: (await getSocialPost(pool, ctx.organizationId, id)) ?? plan.post,
    batch: refreshed,
  };
}
export async function retryFailedBatch(
  pool: Pool,
  ctx: RequestContext,
  id: string,
  options: import("../services/social/posts.js").PostMutationOptions = {},
): Promise<Row> {
  const key = idempotency(ctx, "batch content retry"),
    batch = await loadBatch(pool, ctx.organizationId, id);
  await refreshBatchStatus(pool, id, ctx.organizationId);
  await syncOrgConnections(pool, ctx.organizationId);
  await syncPermissionInventory(pool, ctx.organizationId);
  await transaction(pool, async (tx) => {
    await lockSocialPost(tx, ctx.organizationId, batch.post_id, options);
    await lockSocialPublicationAccounts(tx, ctx.organizationId, batch.post_id);
    await lockReviewedSocialAccounts(tx, ctx.organizationId, options.expectedAccounts);
    const plan = await preflightInternal(pool, ctx, batch.post_id, { syncConnections: false });
    if (plan.snapshotHash !== batch.snapshot_hash)
      throw conflict("The content changed after this batch was admitted; update the draft and publish a new batch");
    await tx.query(SQL.retry_failed_batch[0], [
      `kasitek.content.publish_batch.retry:${ctx.organizationId}:${id}`,
    ]);
    if ((await tx.query(SQL.retry_failed_batch[1], [id, key])).rows.length)
      return;
    const items = (await tx.query(SQL.retry_failed_batch[2], [id])).rows;
    if (!items.length)
      throw conflict(
        "No confirmed failed destinations are available to retry; unknown outcomes require provider reconciliation",
      );
    for (const item of items) {
      const target = plan.targets.find((t) => t.jobId === item.job_id);
      if (!target)
        throw conflict(
          "The batch target no longer exists; create a new draft before retrying",
        );
      if (target.state !== "READY")
        throw conflict(
          `${target.accountName} cannot be retried yet: ${target.message ?? "the destination is not ready"}`,
        );
      if (
        (
          await tx.query(SQL.retry_failed_batch[3], [
            item.job_id,
            canonicalJson({
              _kasitek_batch_id: id,
              _kasitek_delegation: delegatedSocialAuthority(ctx, "content.posts.publish_batch.retry"),
              lastRetryIdempotencyKey: key,
            }),
            ctx.organizationId,
          ])
        ).rowCount !== 1
      )
        throw conflict(
          "This destination changed while it was being prepared for retry",
        );
      await tx.query('UPDATE "SocialPublishJob" SET "userId"=$2 WHERE id=$1', [item.job_id, ctx.userId]);
      await tx.query(SQL.retry_failed_batch[4], [
        item.id,
        canonicalJson({ lastRetryIdempotencyKey: key }),
        id,
      ]);
    }
  });
  const summary = await refreshBatchStatus(pool, id, ctx.organizationId);
  return { post: await requirePost(pool, ctx, batch.post_id), batch: summary };
}
export async function refreshActiveBatches(
  pool: Pool,
  limit: number,
): Promise<number> {
  const rows = (
    await pool.query(SQL.refresh_active_batches[0], [Math.max(1, limit)])
  ).rows;
  let count = 0;
  for (const row of rows) {
    const batch = (await pool.query(SQL.refresh_active_batches[1], [row.id]))
      .rows[0];
    if (batch) {
      await refreshBatchStatus(pool, row.id, batch.orgId);
      count++;
    }
  }
  return count;
}
