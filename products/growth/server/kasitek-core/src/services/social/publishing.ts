import { SerdeFloat } from "@kasitek-labs/server-support/json";
import { parseSerdeValueJson } from "../../json.js";
import type { Pool } from "pg";
import { canonicalJson } from "@kasitek-labs/server-support/json";
import { transaction } from "../../db.js";
import { ApiError } from "../../error.js";
import { JOB_STATUSES, bad } from "./common.js";
import { SQL } from "./publishing-sql.js";
export interface PublishExecutionResult {
  jobId: string;
  postId: string;
  platform: string;
  status: string;
  externalPostId: string | null;
}
export interface PublishJobLoad {
  id: string;
  user_id: string;
  org_id: string | null;
  post_id: string;
  variant_id: string | null;
  channel_connection_id: string | null;
  platform: string;
  status: string;
  external_post_id: string | null;
  post_content: string;
  post_metadata: Record<string, unknown> | null;
  job_metadata: Record<string, unknown> | null;
  post_primary_channel_id: string | null;
  variant_content: string | null;
  media: Record<string, unknown>[];
}
export async function loadPublishJob(
  pool: Pool,
  id: string,
): Promise<PublishJobLoad | undefined> {
  return (await pool.query<PublishJobLoad>(SQL.load_publish_job[0], [id]))
    .rows[0];
}
export async function claimPublishJob(
  pool: Pool,
  id: string,
  statuses: string[],
): Promise<boolean> {
  if (statuses.some((status) => !JOB_STATUSES.includes(status)))
    throw bad("Invalid publish job status");
  return (
    (await pool.query(SQL.claim_publish_job[0], [id, statuses])).rowCount === 1
  );
}
export function isIndeterminatePublishError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    ([502, 503, 504].includes(error.status) ||
      (error.status === 400 && /timeout|timed out/i.test(error.message)))
  );
}
export function batchApprovalGrantsTiktokConsent(
  metadata: Record<string, unknown> | null,
): boolean {
  return (
    typeof metadata?._kasitek_batch_id === "string" &&
    metadata._kasitek_batch_id.trim() !== ""
  );
}
export async function markJobFailed(
  pool: Pool,
  jobId: string,
  postId: string,
  message: string,
  outcome: string | null,
): Promise<void> {
  await transaction(pool, async (tx) => {
    const result = await tx.query(SQL.mark_job_failed[0], [
      message,
      canonicalJson(outcome === null ? {} : { _kasitek_outcome: outcome }),
      jobId,
    ]);
    if (result.rowCount === 0) return;
    await tx.query(SQL.mark_job_failed[1], [
      canonicalJson({
        failedAt: new Date()
          .toISOString()
          .replace(/\.000Z$/, "Z")
          .replace(/Z$/, "+00:00"),
        failureReason: message,
      }),
      outcome ?? "FAILED",
      postId,
    ]);
  });
}
import { readConfig, type CoreConfig } from "../../config.js";
import {
  encryptSocialSecret,
  decryptSocialSecret,
} from "../../integrations/crypto.js";
import {
  refreshThreadsToken,
  refreshTiktokToken,
  saveRotatedTokens,
} from "../../integrations/provider-auth.js";
import * as bluesky from "../../integrations/bluesky-oauth.js";
import { syncOrgConnections } from "../connections.js";
import { recordMeterUsage } from "../billing.js";
import { publicMediaUrl, readContentMediaBytes } from "./media.js";
import * as providers from "./provider-publishing.js";
import { isValidPlatform, missing, internal, trimmed } from "./common.js";
export interface SocialExecutionOptions extends providers.ProviderOptions {
  config?: CoreConfig;
  blueskyTransport?: bluesky.BlueskyTransport;
  log?: { error(fields: Record<string, unknown>, message?: string): void };
}
interface PrivateChannel {
  id: string;
  external_account_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  metadata: Record<string, unknown> | null;
}
export function tokenExpiresWithin(
  metadata: Record<string, unknown> | null,
  milliseconds: number,
): boolean {
  return (
    typeof metadata?.expiresAt === "string" &&
    Number.isFinite(Date.parse(metadata.expiresAt)) &&
    Date.parse(metadata.expiresAt) <= Date.now() + milliseconds
  );
}
const PRIVATE_COLUMNS =
  'id,"externalAccountId" AS external_account_id,"accessToken" AS access_token,"refreshToken" AS refresh_token,metadata';
export async function resolveConnectedChannelForPlatform(
  pool: Pool,
  org: string,
  platform: string,
  id: string | null,
): Promise<PrivateChannel> {
  if (id) {
    const row = (
      await pool.query<PrivateChannel>(
        `SELECT ${PRIVATE_COLUMNS} FROM "SocialChannelConnection" WHERE id=$1 AND "orgId"=$2 AND platform=$3::"SocialPlatform" AND status='CONNECTED'::"SocialChannelStatus" LIMIT 1`,
        [id, org, platform],
      )
    ).rows[0];
    if (row?.access_token !== null && row !== undefined) return row;
  }
  const row = (
    await pool.query<PrivateChannel>(
      `SELECT ${PRIVATE_COLUMNS} FROM "SocialChannelConnection" WHERE "orgId"=$1 AND platform=$2::"SocialPlatform" AND status='CONNECTED'::"SocialChannelStatus" ORDER BY "updatedAt" DESC LIMIT 1`,
      [org, platform],
    )
  ).rows[0];
  if (!row || row.access_token === null)
    throw bad(`Connect a ${platform.toLowerCase()} account before publishing`);
  return row;
}
function attachedUrl(
  media: Record<string, unknown>[],
  config: CoreConfig,
  kind: string | null,
): string | null {
  for (const item of media)
    if (
      (kind === null || item.kind === kind) &&
      typeof item.assetId === "string"
    )
      return publicMediaUrl(config, item.assetId);
  return null;
}
async function attachedImages(
  pool: Pool,
  config: CoreConfig,
  org: string,
  media: Record<string, unknown>[],
): Promise<providers.PublishImage[]> {
  const images: providers.PublishImage[] = [];
  for (const item of media) {
    if (item.kind !== "IMAGE")
      throw bad("This platform currently supports image attachments only");
    if (typeof item.assetId !== "string")
      throw bad("Attached image is invalid");
    const stored = await readContentMediaBytes(pool, config, org, item.assetId);
    images.push({
      bytes: stored.bytes,
      mime_type: stored.mime_type,
      alt_text: typeof item.altText === "string" ? item.altText : "",
    });
  }
  return images;
}
async function tiktokAccess(
  pool: Pool,
  config: CoreConfig,
  channel: PrivateChannel,
  refreshMessage: string,
  options: SocialExecutionOptions,
): Promise<string> {
  if (tokenExpiresWithin(channel.metadata, 300000)) {
    if (channel.refresh_token === null) throw bad(refreshMessage);
    const tokens = await refreshTiktokToken(
      config,
      channel.refresh_token,
      options.fetch,
    );
    if (tokens.access_token == null)
      throw bad("TikTok refresh did not return an access token");
    await saveRotatedTokens(
      pool,
      config,
      channel.id,
      tokens.access_token,
      tokens.refresh_token ?? null,
      tokens.expires_in ?? null,
    );
    return tokens.access_token;
  }
  if (channel.access_token === null) throw bad(refreshMessage);
  return decryptSocialSecret(config, channel.access_token);
}
export async function getTiktokCreatorInfo(
  pool: Pool,
  org: string,
  id: string,
  options: SocialExecutionOptions = {},
): Promise<unknown> {
  const config = options.config ?? readConfig(),
    channel = await resolveConnectedChannelForPlatform(pool, org, "TIKTOK", id),
    access = await tiktokAccess(
      pool,
      config,
      channel,
      "Reconnect TikTok to refresh creator settings",
      options,
    );
  const result = await providers.providerJson(
    providers.TIKTOK_CREATOR,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
    "Failed to query TikTok creator settings",
    options,
  );
  const code =
    typeof result.error?.code === "string" ? result.error.code : "ok";
  if (code !== "ok")
    throw bad(
      typeof result.error?.message === "string" ? result.error.message : code,
    );
  if (!("data" in result)) throw bad("TikTok did not return creator settings");
  return result.data;
}
export async function executeSocialPublishJob(
  pool: Pool,
  id: string,
  options: SocialExecutionOptions = {},
): Promise<PublishExecutionResult> {
  const job = await loadPublishJob(pool, id);
  if (!job) throw missing("Publish job not found");
  if (job.org_id === null)
    throw internal(
      "Social publish job does not have an organisation assignment",
    );
  const org = job.org_id,
    config = options.config ?? readConfig();
  if (job.status === "CANCELED") throw bad("Publish job is canceled");
  if (!isValidPlatform(job.platform)) throw bad("Unsupported social platform");
  const result = (
    status: string,
    external: string | null,
  ): PublishExecutionResult => ({
    jobId: job.id,
    postId: job.post_id,
    platform: job.platform,
    status,
    externalPostId: external,
  });
  if (job.status === "PUBLISHED" && job.external_post_id !== null)
    return result("PUBLISHED", job.external_post_id);
  const text = trimmed(job.variant_content) ?? job.post_content.trim();
  let external: string | null,
    channel: PrivateChannel,
    provider: string,
    published: string;
  try {
    switch (job.platform) {
      case "FACEBOOK": {
        if (job.media.length > 1)
          throw bad("The current Facebook adapter accepts one image per post");
        channel = await resolveConnectedChannelForPlatform(
          pool,
          org,
          "FACEBOOK",
          job.channel_connection_id,
        );
        const image = attachedUrl(job.media, config, "IMAGE");
        if (job.media.length && !image)
          throw bad("Facebook posts currently support image attachments only");
        [external, published] = await providers.publishPostToFacebook(
          config,
          channel.access_token!,
          channel.external_account_id,
          text,
          image,
          options,
        );
        provider = "meta-facebook";
        break;
      }
      case "INSTAGRAM": {
        const image =
          trimmed(
            typeof job.post_metadata?.instagramImageUrl === "string"
              ? job.post_metadata.instagramImageUrl
              : null,
          ) ?? attachedUrl(job.media, config, "IMAGE");
        if (image === null)
          throw bad(
            "Attach an image or add a public HTTPS image URL before publishing to Instagram",
          );
        channel = await resolveConnectedChannelForPlatform(
          pool,
          org,
          "INSTAGRAM",
          job.channel_connection_id,
        );
        [external, published] = await providers.publishPostToInstagram(
          config,
          channel.access_token!,
          channel.external_account_id,
          channel.metadata,
          image,
          text,
          options,
        );
        provider = "instagram";
        break;
      }
      case "THREADS": {
        if (job.media.length > 1)
          throw bad("The current Threads adapter accepts one image per post");
        const image = attachedUrl(job.media, config, "IMAGE");
        if (job.media.length && !image)
          throw bad("Threads posts currently support image attachments only");
        channel = await resolveConnectedChannelForPlatform(
          pool,
          org,
          "THREADS",
          job.channel_connection_id,
        );
        let access = channel.access_token!;
        if (tokenExpiresWithin(channel.metadata, 604800000)) {
          const tokens = await refreshThreadsToken(
            config,
            access,
            options.fetch,
          );
          if (tokens.access_token == null)
            throw bad("Threads refresh did not return an access token");
          await saveRotatedTokens(
            pool,
            config,
            channel.id,
            tokens.access_token,
            null,
            tokens.expires_in ?? null,
          );
          access = encryptSocialSecret(config, tokens.access_token);
        }
        if (channel.external_account_id === null)
          throw bad("Threads connection is missing its account identifier");
        [external, published] = await providers.publishPostToThreads(
          config,
          access,
          channel.external_account_id,
          text,
          image,
          options,
        );
        provider = "threads";
        break;
      }
      case "TIKTOK": {
        if (job.media.length > 1)
          throw bad(
            "The current TikTok adapter accepts one uploaded image or video per post",
          );
        channel = await resolveConnectedChannelForPlatform(
          pool,
          org,
          "TIKTOK",
          job.channel_connection_id,
        );
        const access = await tiktokAccess(
          pool,
          config,
          channel,
          "Reconnect TikTok to refresh publishing access",
          options,
        );
        const raw = job.post_metadata ?? {};
        if (
          typeof raw !== "object" ||
          raw instanceof SerdeFloat ||
          Array.isArray(raw)
        )
          throw bad("TikTok post metadata must be an object");
        const metadata = { ...raw };
        if (batchApprovalGrantsTiktokConsent(job.job_metadata))
          metadata.tiktokConsent = true;
        if (
          !trimmed(
            typeof metadata.tiktokMediaUrl === "string"
              ? metadata.tiktokMediaUrl
              : null,
          )
        ) {
          const kind =
            typeof metadata.tiktokMediaType === "string"
              ? metadata.tiktokMediaType === "PHOTO"
                ? "IMAGE"
                : "VIDEO"
              : null;
          const media = attachedUrl(job.media, config, kind);
          if (media !== null) {
            metadata.tiktokMediaUrl = media;
            metadata.tiktokMediaType = kind === "IMAGE" ? "PHOTO" : "VIDEO";
          }
        }
        [external, published] = await providers.publishPostToTiktok(
          access,
          metadata,
          text,
          options,
        );
        provider = "tiktok";
        break;
      }
      case "BLUESKY": {
        if (job.media.length > 4)
          throw bad("Bluesky posts can include at most 4 images");
        if (Array.from(text).length > 300)
          throw bad("Bluesky posts are limited to 300 characters");
        channel = await resolveConnectedChannelForPlatform(
          pool,
          org,
          "BLUESKY",
          job.channel_connection_id,
        );
        const metadata = channel.metadata;
        if (metadata === null)
          throw bad("Reconnect Bluesky using OAuth before publishing");
        if (metadata.authMethod !== "oauth")
          throw bad("Reconnect Bluesky using the new authorization flow");
        if (channel.refresh_token === null)
          throw bad("Reconnect Bluesky to refresh publishing access");
        if (typeof metadata.pds !== "string")
          throw bad("Bluesky connection is missing its PDS");
        if (typeof metadata.authorizationServer !== "string")
          throw bad("Bluesky connection is missing its authorization server");
        if (typeof metadata.dpopPrivateKey !== "string")
          throw bad("Bluesky connection is missing its DPoP key");
        const key = decryptSocialSecret(config, metadata.dpopPrivateKey),
          refresh = decryptSocialSecret(config, channel.refresh_token);
        let session: bluesky.RefreshedSession;
        try {
          session = await bluesky.refresh(
            config,
            refresh,
            metadata.authorizationServer,
            key,
            typeof metadata.dpopAuthorizationNonce === "string"
              ? metadata.dpopAuthorizationNonce
              : null,
            options.blueskyTransport,
          );
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.status === 400 &&
            /invalid_grant|Invalid refresh token|Token was not issued to this client/.test(
              error.message,
            )
          ) {
            await pool.query(SQL.execute_social_publish_job[0], [
              canonicalJson({
                reauthReason: "invalid_refresh_token",
                reauthRequiredAt: new Date()
                  .toISOString()
                  .replace(/Z$/, "+00:00"),
              }),
              channel.id,
              org,
            ]);
            await syncOrgConnections(pool, org);
            throw bad(
              "Bluesky connection expired. Reconnect Bluesky before publishing",
            );
          }
          throw error;
        }
        await saveRotatedTokens(
          pool,
          config,
          channel.id,
          session.accessToken,
          session.refreshToken,
          session.expiresIn,
        );
        if (channel.external_account_id === null)
          throw bad("Bluesky connection is missing its DID");
        const images = (await attachedImages(pool, config, org, job.media)).map(
          (image) => ({
            bytes: image.bytes,
            mimeType: image.mime_type,
            altText: image.alt_text,
          }),
        );
        let nonce: string | null;
        [external, nonce] = await bluesky.createPost(
          metadata.pds,
          channel.external_account_id,
          text,
          images,
          session.accessToken,
          key,
          typeof metadata.dpopResourceNonce === "string"
            ? metadata.dpopResourceNonce
            : null,
          options.blueskyTransport,
        );
        await pool.query(SQL.execute_social_publish_job[1], [
          canonicalJson({
            dpopAuthorizationNonce: session.authorizationNonce,
            dpopResourceNonce: nonce,
          }),
          channel.id,
        ]);
        provider = "bluesky";
        published = text;
        break;
      }
      case "X": {
        if (job.media.length > 4)
          throw bad("X posts can include at most 4 images");
        if (Array.from(text).length > 280)
          throw bad("X posts are currently limited to 280 characters");
        channel = await resolveConnectedChannelForPlatform(
          pool,
          org,
          "X",
          job.channel_connection_id,
        );
        [external, published] = await providers.publishPostToX(
          config,
          channel.access_token!,
          text,
          await attachedImages(pool, config, org, job.media),
          options,
        );
        provider = "x";
        break;
      }
      case "LINKEDIN": {
        if (job.media.length > 1)
          throw bad("The current LinkedIn adapter accepts one image per post");
        if (Array.from(text).length > 3000)
          throw bad("LinkedIn posts are currently limited to 3000 characters");
        channel = await resolveConnectedChannelForPlatform(
          pool,
          org,
          "LINKEDIN",
          job.channel_connection_id,
        );
        [external, published] = await providers.publishPostToLinkedin(
          config,
          channel.access_token!,
          channel.external_account_id,
          channel.metadata,
          text,
          (await attachedImages(pool, config, org, job.media))[0] ?? null,
          options,
        );
        provider = "linkedin";
        break;
      }
      default:
        throw bad(`Publishing is not implemented yet for ${job.platform}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error),
      detail = message.split(": ").at(-1)!;
    await markJobFailed(
      pool,
      job.id,
      job.post_id,
      detail,
      isIndeterminatePublishError(error) ? "UNKNOWN" : null,
    );
    throw error;
  }
  if (provider === "tiktok") {
    await pool.query(SQL.execute_social_publish_job[2], [
      external,
      channel.id,
      canonicalJson({
        provider: "tiktok",
        publishId: external,
        submittedText: published,
      }),
      job.id,
    ]);
    await pool.query(SQL.execute_social_publish_job[3], [job.post_id]);
    return result("PROCESSING", external);
  }
  const now = new Date().toISOString();
  await transaction(pool, async (tx) => {
    await tx.query(SQL.execute_social_publish_job[4], [
      now,
      external,
      channel.id,
      canonicalJson({ provider, publishedText: published }),
      job.id,
    ]);
    await tx.query(SQL.execute_social_publish_job[5], [
      now,
      channel.id,
      canonicalJson({
        latestPublishedPostId: external,
        latestPublishedPlatform: job.platform,
      }),
      job.post_id,
    ]);
  });
  try {
    await recordMeterUsage(
      pool,
      org,
      "social_publishes",
      1,
      "social_publish_job",
      job.id,
      `social-publish:${job.id}`,
    );
  } catch (error) {
    options.log?.error(
      {
        event: "operation.failed",
        operation: "social_publish.billing_record",
        org_id: org,
        job_id: job.id,
        error_type: error instanceof Error ? error.name : "unknown",
      },
      "publish saved but usage recording failed",
    );
  }
  return result("PUBLISHED", external);
}

import { getSocialPost, deleteSocialPost } from "./posts.js";
import {
  authorizationRequirement,
  isAuthorizationError,
} from "../../integrations/connection-permissions.js";
import { createId } from "@paralleldrive/cuid2";
import { refreshActiveBatches } from "../../capabilities/content-batch.js";
export interface ProviderDeletionResult {
  platform: string;
  externalPostId: string | null;
  status: string;
  message: string | null;
  authorization?: NonNullable<ReturnType<typeof authorizationRequirement>> & {
    connectionId: string;
  };
}
export interface SocialPostDeletionResult {
  success: boolean;
  localDeleted: boolean;
  providerResults: ProviderDeletionResult[];
  authorizationRequired?: NonNullable<
    ReturnType<typeof authorizationRequirement>
  > & { connectionId: string };
}
async function deletionChannel(
  pool: Pool,
  org: string,
  platform: string,
  id: string,
): Promise<PrivateChannel> {
  const row = (
    await pool.query<PrivateChannel>(SQL.resolve_channel_for_post_deletion[0], [
      id,
      org,
      platform,
    ])
  ).rows[0];
  if (!row)
    throw bad(
      `Reconnect the ${platform.toLowerCase()} account before deleting its post`,
    );
  return row;
}
async function saveBlueskyNonce(
  pool: Pool,
  id: string,
  authorization: string | null,
  resource: string | null,
): Promise<void> {
  const metadata = {
    ...(authorization !== null
      ? { dpopAuthorizationNonce: authorization }
      : {}),
    ...(resource !== null ? { dpopResourceNonce: resource } : {}),
  };
  if (Object.keys(metadata).length)
    await pool.query(SQL.save_bluesky_deletion_nonce[0], [
      canonicalJson(metadata),
      id,
    ]);
}
async function deleteBlueskyPost(
  pool: Pool,
  config: CoreConfig,
  channel: PrivateChannel,
  id: string,
  options: SocialExecutionOptions,
): Promise<void> {
  const metadata = channel.metadata;
  if (metadata === null)
    throw bad("Reconnect Bluesky using OAuth before deleting posts");
  const pds = metadata.pds;
  if (typeof pds !== "string")
    throw bad("Bluesky connection is missing its PDS");
  const did = channel.external_account_id;
  if (did === null) throw bad("Bluesky connection is missing its DID");
  if (typeof metadata.dpopPrivateKey !== "string")
    throw bad("Bluesky connection is missing its DPoP key");
  const key = decryptSocialSecret(config, metadata.dpopPrivateKey);
  if (channel.access_token === null)
    throw bad("Reconnect Bluesky before deleting posts");
  const token = decryptSocialSecret(config, channel.access_token),
    resource =
      typeof metadata.dpopResourceNonce === "string"
        ? metadata.dpopResourceNonce
        : null;
  let first: unknown;
  try {
    const nonce = await bluesky.deletePost(
      pds,
      did,
      id,
      token,
      key,
      resource,
      options.blueskyTransport,
    );
    await saveBlueskyNonce(pool, channel.id, null, nonce);
    return;
  } catch (error) {
    first = error;
  }
  if (channel.refresh_token === null) throw first;
  if (typeof metadata.authorizationServer !== "string")
    throw bad("Bluesky connection is missing its authorization server");
  const refresh = decryptSocialSecret(config, channel.refresh_token);
  let session: Awaited<ReturnType<typeof bluesky.refresh>>;
  try {
    session = await bluesky.refresh(
      config,
      refresh,
      metadata.authorizationServer,
      key,
      typeof metadata.dpopAuthorizationNonce === "string"
        ? metadata.dpopAuthorizationNonce
        : null,
      options.blueskyTransport,
    );
  } catch (error) {
    throw bad(
      `Bluesky deletion failed: ${errorMessage(first)}; token refresh failed: ${errorMessage(error)}`,
    );
  }
  await saveRotatedTokens(
    pool,
    config,
    channel.id,
    session.accessToken,
    session.refreshToken,
    session.expiresIn,
  );
  const nonce = await bluesky.deletePost(
    pds,
    did,
    id,
    session.accessToken,
    key,
    resource,
    options.blueskyTransport,
  );
  await saveBlueskyNonce(pool, channel.id, session.authorizationNonce, nonce);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export async function deleteSocialPostFromPlatforms(
  pool: Pool,
  config: CoreConfig,
  org: string,
  id: string,
  options: SocialExecutionOptions = {},
): Promise<SocialPostDeletionResult> {
  return deletePlatforms(pool, config, org, id, null, options);
}
export async function deleteSocialPostFromPlatform(
  pool: Pool,
  config: CoreConfig,
  org: string,
  id: string,
  platform: string,
  options: SocialExecutionOptions = {},
): Promise<SocialPostDeletionResult> {
  platform = platform.trim().replace(/[a-z]/g, (c) => c.toUpperCase());
  if (!platform)
    throw bad("A social platform is required for published-post deletion");
  return deletePlatforms(pool, config, org, id, platform, options);
}
async function deletePlatforms(
  pool: Pool,
  config: CoreConfig,
  org: string,
  id: string,
  platform: string | null,
  options: SocialExecutionOptions,
): Promise<SocialPostDeletionResult> {
  const post = await getSocialPost(pool, org, id);
  if (!post) throw missing("Post not found");
  const jobs = post.publishJobs.filter(
    (job) =>
      job.status === "PUBLISHED" &&
      (platform === null || job.platform.toUpperCase() === platform),
  );
  if (platform !== null && !jobs.length)
    throw missing(
      "No published post was found for the requested social platform",
    );
  const results: ProviderDeletionResult[] = [];
  for (const job of jobs) {
    const result: ProviderDeletionResult = {
      platform: job.platform,
      externalPostId: job.external_post_id,
      status: "FAILED",
      message: null,
    };
    results.push(result);
    if (job.external_post_id === null) {
      result.message = "No provider post ID was saved for this published job";
      continue;
    }
    if (job.channel_connection_id === null) {
      result.message = "The published job has no channel connection";
      continue;
    }
    try {
      const channel = await deletionChannel(
        pool,
        org,
        job.platform,
        job.channel_connection_id,
      );
      if (job.platform === "BLUESKY")
        await deleteBlueskyPost(
          pool,
          config,
          channel,
          job.external_post_id,
          options,
        );
      else {
        if (channel.access_token === null)
          throw bad(
            `Reconnect the ${job.platform.toLowerCase()} account before deleting its post`,
          );
        await providers.deletePostFromProvider(
          config,
          job.platform,
          channel.access_token,
          channel.external_account_id,
          channel.metadata,
          job.external_post_id,
          options,
        );
      }
      result.status = "DELETED";
    } catch (error) {
      result.message = errorMessage(error);
      options.log?.error(
        {
          event: "provider.call.failed",
          provider: job.platform,
          operation: "content.post.delete",
          org_id: org,
          post_id: id,
          job_id: job.id,
          error_code: error instanceof ApiError ? error.code : "internal_error",
        },
        "provider post deletion was not confirmed",
      );
      if (isAuthorizationError(error)) {
        let metadata: Record<string, unknown> | null = null;
        try {
          metadata = (
            await deletionChannel(
              pool,
              org,
              job.platform,
              job.channel_connection_id,
            )
          ).metadata;
        } catch {}
        const required = authorizationRequirement(
          job.platform,
          metadata,
          "SOCIAL_POST_DELETE",
        );
        if (required)
          result.authorization = {
            ...required,
            connectionId: job.channel_connection_id,
          };
      }
    }
  }
  if (results.some((result) => result.status !== "DELETED")) {
    const required = results.find(
      (result) => result.authorization,
    )?.authorization;
    return {
      success: false,
      localDeleted: false,
      providerResults: results,
      ...(required ? { authorizationRequired: required } : {}),
    };
  }
  if (platform !== null) {
    for (const job of jobs)
      await pool.query(SQL.delete_social_post_from_platforms_internal[0], [
        job.id,
        `Deleted from ${job.platform} through KasiTek`,
        id,
      ]);
    if (
      BigInt(
        (
          await pool.query(SQL.delete_social_post_from_platforms_internal[1], [
            id,
          ])
        ).rows[0].count,
      ) > 0n
    )
      return { success: true, localDeleted: false, providerResults: results };
  }
  if (!(await deleteSocialPost(pool, org, id))) throw missing("Post not found");
  return { success: true, localDeleted: true, providerResults: results };
}
export async function removeThreadsConnectionData(
  pool: Pool,
  externalUserId: string,
  confirmationCode: string | null,
): Promise<string[]> {
  return transaction(pool, async (tx) => {
    const orgs = (
      await tx.query(SQL.remove_threads_connection_data[0], [externalUserId])
    ).rows.map((row) => row.orgId as string);
    for (let i = 1; i <= 3; i++)
      await tx.query(SQL.remove_threads_connection_data[i]!, [externalUserId]);
    if (confirmationCode !== null)
      await tx.query(SQL.remove_threads_connection_data[4], [
        createId(),
        confirmationCode,
      ]);
    return orgs;
  });
}
export async function threadsDataDeletionStatus(
  pool: Pool,
  confirmation: string,
): Promise<string | undefined> {
  return (await pool.query(SQL.threads_data_deletion_status[0], [confirmation]))
    .rows[0]?.status;
}
interface WebhookEvent {
  id: string;
  event_type: string;
  external_account_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
}
interface TiktokJob {
  id: string;
  org_id: string;
  external_post_id: string | null;
}
const nowRfc3339 = () =>
  new Date()
    .toISOString()
    .replace(/\.000Z$/, "Z")
    .replace(/Z$/, "+00:00");
async function processTiktokWebhookEvent(
  pool: Pool,
  event: WebhookEvent,
): Promise<boolean> {
  let content: Record<string, unknown> | null = null;
  if (typeof event.payload.content === "string") {
    try {
      content = parseSerdeValueJson(event.payload.content) as Record<
        string,
        unknown
      > | null;
    } catch {
      content = { raw: event.payload.content };
    }
  }
  if (
    [
      "post.publish.complete",
      "post.publish.publicly_available",
      "post.publish.failed",
    ].includes(event.event_type)
  ) {
    const publishId = content?.publish_id;
    if (typeof publishId !== "string")
      throw bad("TikTok publish webhook is missing publish_id");
    const job = (
      await pool.query<TiktokJob>(SQL.find_tiktok_webhook_job[0], [
        publishId,
        event.external_account_id,
      ])
    ).rows[0];
    if (!job) throw missing("TikTok publish job was not found");
    if (event.event_type === "post.publish.failed") {
      const reason =
        typeof content?.reason === "string"
          ? content.reason
          : "TikTok rejected the post";
      return transaction(pool, async (tx) => {
        const updated = (
          await tx.query(SQL.fail_tiktok_job_from_webhook[0], [
            job.id,
            reason,
            canonicalJson({
              tiktokWebhookEvent: "post.publish.failed",
              tiktokWebhookContent: content,
            }),
          ])
        ).rows[0];
        if (!updated) return false;
        await tx.query(SQL.fail_tiktok_job_from_webhook[1], [
          canonicalJson({ failedAt: nowRfc3339(), failureReason: reason }),
          updated.postId,
        ]);
        return true;
      });
    }
    const publicId =
      typeof content?.post_id === "string" ? content.post_id : null;
    const updated = await transaction(pool, async (tx) => {
      const row = (
        await tx.query(SQL.complete_tiktok_job_from_webhook[0], [
          job.id,
          publicId,
          canonicalJson({
            tiktokWebhookEvent: event.event_type,
            tiktokWebhookContent: content,
          }),
        ])
      ).rows[0];
      if (!row) return false;
      await tx.query(SQL.complete_tiktok_job_from_webhook[1], [
        canonicalJson({
          latestPublishedPostId: publicId ?? job.external_post_id,
          latestPublishedPlatform: "TIKTOK",
          tiktokWebhookEvent: event.event_type,
        }),
        row.postId,
      ]);
      return true;
    });
    if (updated)
      await recordMeterUsage(
        pool,
        job.org_id,
        "social_publishes",
        1,
        "social_publish_job",
        job.id,
        `social-publish:${job.id}`,
      );
    return updated;
  }
  if (event.event_type === "authorization.removed") {
    if (event.external_account_id === null) return false;
    const orgs = (
      await pool.query(SQL.process_tiktok_webhook_event[0], [
        canonicalJson({ tiktokAuthorizationRemovedAt: nowRfc3339() }),
        event.external_account_id,
      ])
    ).rows;
    for (const org of orgs) await syncOrgConnections(pool, org.orgId);
    return true;
  }
  return false;
}
export async function processTiktokWebhookEvents(
  pool: Pool,
  limit: number,
): Promise<number> {
  let count = 0;
  for (let i = 0; i < Math.max(1, limit); i++) {
    const event = (
      await pool.query<WebhookEvent>(SQL.claim_tiktok_webhook_event[0])
    ).rows[0];
    if (!event) break;
    try {
      const handled = await processTiktokWebhookEvent(pool, event);
      await pool.query(SQL.finish_tiktok_webhook_event[0], [
        event.id,
        handled ? "PROCESSED" : "IGNORED",
        null,
        false,
      ]);
    } catch (error) {
      await pool.query(SQL.finish_tiktok_webhook_event[0], [
        event.id,
        "FAILED",
        errorMessage(error),
        event.attempts < 8,
      ]);
    }
    count++;
  }
  return count;
}
interface PendingTiktok {
  id: string;
  post_id: string;
  org_id: string;
  channel_connection_id: string;
  publish_id: string;
}
export async function reconcileTiktokPublishJobs(
  pool: Pool,
  limit: number,
  options: SocialExecutionOptions = {},
): Promise<number> {
  const config = options.config ?? readConfig();
  const jobs = (
    await pool.query<PendingTiktok>(SQL.reconcile_tiktok_publish_jobs[0], [
      Math.max(1, limit),
    ])
  ).rows;
  let count = 0;
  for (const job of jobs) {
    const channel = await resolveConnectedChannelForPlatform(
      pool,
      job.org_id,
      "TIKTOK",
      job.channel_connection_id,
    );
    const access = await tiktokAccess(
      pool,
      config,
      channel,
      "Reconnect TikTok to check publish status",
      options,
    );
    const response = await providers.providerJson(
      "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ publish_id: job.publish_id }),
      },
      "Failed to check TikTok publish status",
      options,
    );
    if (
      typeof response.error?.code === "string" &&
      response.error.code !== "ok"
    )
      continue;
    const data = response.data ?? null;
    if (data?.status === "PUBLISH_COMPLETE") {
      const external =
          typeof data.publicaly_available_post_id?.[0] === "string"
            ? data.publicaly_available_post_id[0]
            : job.publish_id,
        now = new Date();
      const updated = await transaction(pool, async (tx) => {
        if (
          (
            await tx.query(SQL.reconcile_tiktok_publish_jobs[1], [
              now,
              external,
              canonicalJson({ tiktokStatus: data }),
              job.id,
            ])
          ).rowCount === 0
        )
          return false;
        await tx.query(SQL.reconcile_tiktok_publish_jobs[2], [
          now,
          canonicalJson({
            latestPublishedPostId: external,
            latestPublishedPlatform: "TIKTOK",
          }),
          job.post_id,
        ]);
        return true;
      });
      if (!updated) continue;
      await recordMeterUsage(
        pool,
        job.org_id,
        "social_publishes",
        1,
        "social_publish_job",
        job.id,
        `social-publish:${job.id}`,
      );
      count++;
    } else if (data?.status === "FAILED") {
      await markJobFailed(
        pool,
        job.id,
        job.post_id,
        typeof data.fail_reason === "string"
          ? data.fail_reason
          : "TikTok rejected the post",
        null,
      );
      count++;
    }
  }
  return count;
}
export async function processDueSocialPublishJobs(
  pool: Pool,
  limit: number,
  options: SocialExecutionOptions = {},
): Promise<number> {
  const webhooks = await processTiktokWebhookEvents(pool, limit),
    reconciled = await reconcileTiktokPublishJobs(pool, limit, options);
  const due = (
    await pool.query(SQL.process_due_social_publish_jobs[0], [
      Math.max(1, limit),
    ])
  ).rows;
  let count = 0;
  for (const job of due) {
    if (!(await claimPublishJob(pool, job.id, ["QUEUED"]))) continue;
    try {
      await executeSocialPublishJob(pool, job.id, options);
    } catch {}
    count++;
  }
  await refreshActiveBatches(pool, limit);
  return count + webhooks + reconciled;
}
