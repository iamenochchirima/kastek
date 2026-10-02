import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import { extractUser, resolveActiveOrgId } from "../identity/session.js";
import { requireAdmin } from "../services/orgs.js";
import { ApiError } from "../error.js";
import {
  bad,
  missing,
  trimmed,
  isValidPlatform,
  CHANNEL_STATUSES,
} from "../services/social/common.js";
import { registerSocialOAuthRoutes } from "./social-oauth.js";
import * as channels from "../services/social/channels.js";
import * as posts from "../services/social/posts.js";
import * as media from "../services/social/media.js";
import type { SocialPostUpsertRequest } from "../services/social/types.js";
const string = { type: ["string", "null"] };
const json = {};
const channelSchema = {
  type: "object",
  properties: {
    platform: string,
    displayName: string,
    handle: string,
    externalAccountId: string,
    status: string,
    metadata: json,
  },
};
const postSchema = {
  type: "object",
  properties: {
    title: string,
    prompt: string,
    content: string,
    channels: { type: ["array", "null"], items: { type: "string" } },
    status: string,
    scheduledFor: string,
    primaryChannelId: string,
    channelSelections: {
      type: ["object", "null"],
      additionalProperties: { type: "string" },
    },
    variants: {
      type: ["array", "null"],
      items: {
        type: "object",
        required: ["platform", "content"],
        properties: {
          platform: { type: "string" },
          content: { type: "string" },
          status: string,
          aiGenerated: { type: ["boolean", "null"] },
          metadata: json,
        },
      },
    },
    media: {
      type: ["array", "null"],
      items: {
        type: "object",
        required: ["assetId"],
        properties: {
          assetId: { type: "string" },
          sortOrder: {
            type: ["integer", "null"],
            minimum: -2147483648,
            maximum: 2147483647,
          },
          altText: string,
          metadata: json,
        },
      },
    },
    metadata: json,
  },
};
async function scope(
  request: FastifyRequest,
  context: CoreContext,
  admin = false,
) {
  const user = await extractUser(request, context);
  const org = await resolveActiveOrgId(request, context, user.id);
  if (admin) await requireAdmin(context.pool, org, user.id);
  return { user, org };
}
function id(request: FastifyRequest): string {
  return (request.params as { id: string }).id;
}
import * as publishing from "../services/social/publishing.js";
import * as insights from "../services/social/insights.js";
import * as auth from "../integrations/provider-auth.js";
import * as batch from "../capabilities/content-batch.js";
import * as webhooks from "../services/social/webhooks.js";
import { resolveProductContext } from "../identity/request-context.js";
import { syncOrgConnections } from "../services/connections.js";
import { createId } from "@paralleldrive/cuid2";
const conflict = (message: string) => new ApiError(409, "conflict", message);
export function registerSocialRoutes(
  app: FastifyInstance,
  context: CoreContext,
): void {
  registerSocialOAuthRoutes(app, context);
  app.post(
    "/api/social/channels",
    { schema: { body: channelSchema } },
    async (request, reply) => {
      const { user, org } = await scope(request, context, true);
      const input = request.body as {
        platform?: string;
        displayName?: string;
        status?: string;
        handle?: string;
        externalAccountId?: string;
        metadata?: unknown;
      };
      if (!input.platform || !isValidPlatform(input.platform))
        throw bad("A valid platform is required");
      const name = trimmed(input.displayName);
      if (!name) throw bad("Display name is required");
      const status = input.status ?? "CONNECTED";
      if (!CHANNEL_STATUSES.includes(status))
        throw bad("Invalid channel status");
      const channel = await channels.createSocialChannel(
        context.pool,
        user.id,
        org,
        input.platform,
        name,
        trimmed(input.handle),
        trimmed(input.externalAccountId),
        status,
        input.metadata ?? null,
      );
      return reply.code(201).send({ channel });
    },
  );
  app.patch(
    "/api/social/channels/:id",
    { schema: { body: channelSchema } },
    async (request) => {
      const { org } = await scope(request, context, true);
      const existing = await channels.getSocialChannel(
        context.pool,
        org,
        id(request),
      );
      if (!existing) throw missing("Channel not found");
      const input = request.body as {
        platform?: string | null;
        displayName?: string | null;
        status?: string | null;
        handle?: string | null;
        metadata?: unknown;
      };
      const platform = input.platform ?? existing.platform,
        status = input.status ?? existing.status;
      if (!isValidPlatform(platform)) throw bad("Invalid platform");
      if (!CHANNEL_STATUSES.includes(status))
        throw bad("Invalid channel status");
      return {
        channel: await channels.updateSocialChannel(
          context.pool,
          org,
          id(request),
          platform,
          trimmed(input.displayName) ?? existing.display_name,
          trimmed(input.handle) ?? existing.handle,
          status,
          input.metadata ?? existing.metadata,
        ),
      };
    },
  );
  app.delete("/api/social/channels/:id", async (request) => {
    const { org } = await scope(request, context, true);
    if (!(await channels.deleteSocialChannel(context.pool, org, id(request))))
      throw missing("Channel not found");
    return { success: true };
  });
  app.get("/api/social/posts", async (request) => {
    const { org } = await scope(request, context);
    return { posts: await posts.listSocialPosts(context.pool, org) };
  });
  app.get("/api/social/posts/:id", async (request) => {
    const { org } = await scope(request, context);
    const post = await posts.getSocialPost(context.pool, org, id(request));
    if (!post) throw missing("Post not found");
    return { post };
  });
  app.get("/api/social/posts/:id/activity", async (request) => {
    const { org } = await scope(request, context);
    const activity = await posts.getSocialPostActivity(
      context.pool,
      org,
      id(request),
    );
    if (!activity) throw missing("Post not found");
    return activity;
  });
  app.post(
    "/api/social/posts",
    { schema: { body: postSchema } },
    async (request, reply) => {
      const { user, org } = await scope(request, context);
      return reply
        .code(201)
        .send({
          post: await posts.createSocialPost(
            context.pool,
            user.id,
            org,
            request.body as SocialPostUpsertRequest,
          ),
        });
    },
  );
  app.patch(
    "/api/social/posts/:id",
    { schema: { body: postSchema } },
    async (request) => {
      const { user, org } = await scope(request, context);
      return {
        post: await posts.updateSocialPost(
          context.pool,
          user.id,
          org,
          id(request),
          request.body as SocialPostUpsertRequest,
        ),
      };
    },
  );
  app.post("/api/social/media", async (request, reply) => {
    const { user, org } = await scope(request, context);
    return reply
      .code(201)
      .send({
        asset: await media.uploadContentMedia(
          context.pool,
          context.config,
          user.id,
          org,
          request,
        ),
      });
  });
  app.get("/api/social/media/:id", async (request, reply) => {
    const { org } = await scope(request, context);
    const result = await media.downloadContentMedia(
      context.pool,
      context.config,
      org,
      id(request),
    );
    return reply
      .headers(result.headers)
      .type(result.mimeType)
      .send(result.bytes);
  });
  app.get("/api/social/media/:id/public", async (request, reply) => {
    const query = request.query as { expires?: string; signature?: string };
    if (
      typeof query.expires !== "string" ||
      !/^[-+]?\d+$/.test(query.expires) ||
      typeof query.signature !== "string"
    )
      throw bad("Invalid request");
    const expires = BigInt(query.expires);
    if (expires < -(1n << 63n) || expires >= 1n << 63n)
      throw bad("Invalid request");
    const result = await media.downloadPublicContentMedia(
      context.pool,
      context.config,
      id(request),
      expires,
      query.signature,
    );
    return reply
      .headers(result.headers)
      .type(result.mimeType)
      .send(result.bytes);
  });
  app.get("/api/social/channels", async (request) => {
    const { org } = await scope(request, context);
    for (const [operation, ensure] of [
      ["page_app_webhooks.ensure", auth.ensureMetaPageAppWebhooks],
      ["instagram_app_webhooks.ensure", auth.ensureMetaInstagramAppWebhooks],
      ["page_webhooks.ensure", auth.ensureMetaPageWebhookSubscriptions],
      [
        "account_webhooks.ensure",
        auth.ensureInstagramAccountWebhookSubscriptions,
      ],
    ] as const) {
      try {
        await ensure(context.pool, org, context.config);
      } catch (error) {
        request.log.warn(
          {
            event: "provider.call.failed",
            operation,
            org_id: org,
            error_type: error instanceof Error ? error.name : "unknown",
          },
          "failed to ensure provider webhooks",
        );
      }
    }
    return { channels: await channels.listSocialChannels(context.pool, org) };
  });
  app.post("/api/social/channels/:id/identity", async (request) => {
    const { org } = await scope(request, context, true);
    return {
      channel: await auth.refreshSocialChannelIdentity(
        context.pool,
        org,
        context.config,
        id(request),
      ),
    };
  });
  app.get("/api/social/channels/:id/tiktok-creator-info", async (request) => {
    const { org } = await scope(request, context);
    return {
      creator: await publishing.getTiktokCreatorInfo(
        context.pool,
        org,
        id(request),
        { config: context.config },
      ),
    };
  });
  const filters = (request: FastifyRequest) => {
    const query = request.query as {
      platform?: string;
      metrics?: string;
      publishedFrom?: string;
      published_from?: string;
      publishedTo?: string;
      published_to?: string;
      limit?: string;
    };
    const value = insights.parseInsightsFilters(
      query.platform,
      query.metrics,
      query.publishedFrom ?? query.published_from,
      query.publishedTo ?? query.published_to,
    );
    if (value.platform !== null && !isValidPlatform(value.platform))
      throw bad("Invalid social platform");
    let limit = 50;
    if (query.limit !== undefined) {
      if (!/^[-+]?\d+$/.test(query.limit)) throw bad("Invalid request");
      const parsed = BigInt(query.limit);
      if (parsed < -(1n << 63n) || parsed >= 1n << 63n)
        throw bad("Invalid request");
      limit = Number(parsed);
    }
    return { value, limit };
  };
  app.get("/api/social/posts/insights", async (request) => {
    const { org } = await scope(request, context);
    const { value, limit } = filters(request);
    return insights.listSocialPostInsights(context.pool, org, value, limit);
  });
  app.get("/api/social/posts/:id/insights", async (request) => {
    const { org } = await scope(request, context);
    const result = await insights.getSocialPostInsights(
      context.pool,
      org,
      id(request),
      filters(request).value,
    );
    if (!result) throw missing("Post not found");
    return result;
  });
  app.post("/api/social/posts/:id/insights/refresh", async (request) => {
    const { org } = await scope(request, context),
      value = filters(request).value;
    await insights.forceSyncSocialPostInsights(
      context.pool,
      org,
      id(request),
      1,
      { config: context.config },
    );
    const result = await insights.getSocialPostInsights(
      context.pool,
      org,
      id(request),
      value,
    );
    if (!result) throw missing("Post not found");
    return result;
  });
  app.delete("/api/social/posts/:id", async (request, reply) => {
    const { org } = await scope(request, context);
    const body = request.body as
      { deleteFromPlatforms?: boolean | null } | undefined;
    if (
      body !== undefined &&
      (body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        (body.deleteFromPlatforms !== undefined &&
          body.deleteFromPlatforms !== null &&
          typeof body.deleteFromPlatforms !== "boolean"))
    )
      throw bad("Invalid delete options");
    if (body?.deleteFromPlatforms) {
      const result = await publishing.deleteSocialPostFromPlatforms(
        context.pool,
        context.config,
        org,
        id(request),
      );
      if (!result.success)
        return reply
          .code(409)
          .send({
            ...result,
            error:
              "The post was not removed from KasiTek because one or more platform deletions failed.",
            authorizationRequired: result.authorizationRequired ?? null,
          });
      return result;
    }
    if (!(await posts.deleteSocialPost(context.pool, org, id(request))))
      throw missing("Post not found");
    return { success: true, localDeleted: true, providerResults: [] };
  });
  app.post(
    "/api/social/posts/:id/publish",
    { schema: { body: { type: "object", properties: { platform: string } } } },
    async (request) => {
      const { org } = await scope(request, context);
      const platform =
        (request.body as { platform?: string | null }).platform ?? "X";
      if (!isValidPlatform(platform))
        throw bad(`Manual publishing is not available yet for ${platform}`);
      const post = await posts.getSocialPost(context.pool, org, id(request));
      if (!post) throw missing("Post not found");
      if (!post.channels.includes(platform))
        throw bad(`This post is not configured for ${platform}`);
      if (
        post.publishJobs.some(
          (job) =>
            job.platform === platform &&
            job.status === "PUBLISHED" &&
            job.external_post_id !== null,
        )
      )
        throw conflict(`This post has already been published to ${platform}`);
      const job = post.publishJobs.find((job) => job.platform === platform);
      if (!job) throw missing("Publish job not found");
      if (
        !(await publishing.claimPublishJob(context.pool, job.id, [
          "PENDING",
          "FAILED",
          "QUEUED",
        ]))
      )
        throw conflict("This publish job is already being processed");
      const result = await publishing.executeSocialPublishJob(
        context.pool,
        job.id,
        { config: context.config, log: request.log },
      );
      return {
        post:
          (await posts.getSocialPost(context.pool, org, id(request))) ?? null,
        result,
      };
    },
  );
  app.post("/api/social/posts/:id/publish-batch", async (request, reply) => {
    const ctx = await resolveProductContext(request, context);
    ctx.idempotencyKey ??= `manual:content-publish-batch:${id(request)}:${createId()}`;
    return reply
      .code(202)
      .send(await batch.publishBatch(context.pool, ctx, id(request)));
  });
  app.get("/api/social/posts/:id/publish-batch/preflight", async (request) =>
    batch.preflight(
      context.pool,
      await resolveProductContext(request, context),
      id(request),
    ),
  );
  app.get("/api/social/posts/:id/publish-batch", async (request) => ({
    batch: await batch.getLatestBatchForPost(
      context.pool,
      await resolveProductContext(request, context),
      id(request),
    ),
  }));
  app.post("/api/social/publish-batches/:id/retry", async (request, reply) => {
    const ctx = await resolveProductContext(request, context);
    ctx.idempotencyKey ??= `manual:content-publish-batch-retry:${id(request)}:${createId()}`;
    return reply
      .code(202)
      .send(await batch.retryFailedBatch(context.pool, ctx, id(request)));
  });
  app.patch(
    "/api/social/publish-jobs/:id",
    { schema: { body: { type: "object", properties: { action: string } } } },
    async (request) => {
      const { org } = await scope(request, context);
      const action = (request.body as { action?: string | null }).action;
      if (action == null) throw bad("Action is required");
      const job = (
        await context.pool.query(
          'SELECT "postId",metadata FROM "SocialPublishJob" WHERE id=$1 AND "orgId"=$2 LIMIT 1',
          [id(request), org],
        )
      ).rows[0];
      if (!job) throw missing("Publish job not found");
      if (action === "cancel")
        await context.pool.query(
          `UPDATE "SocialPublishJob" SET status='CANCELED'::"SocialPublishJobStatus","errorMessage"=NULL,"updatedAt"=NOW() WHERE id=$1`,
          [id(request)],
        );
      else if (action === "retry" || action === "run_now") {
        if (job.metadata?._kasitek_outcome === "UNKNOWN")
          throw conflict(
            "This publish result is unknown; reconcile the provider before retrying",
          );
        if (action === "retry")
          await context.pool.query(
            `UPDATE "SocialPublishJob" SET status='QUEUED'::"SocialPublishJobStatus","errorMessage"=NULL,"scheduledFor"=NOW(),metadata=COALESCE(metadata,'{}'::jsonb)-'_kasitek_outcome',"updatedAt"=NOW() WHERE id=$1`,
            [id(request)],
          );
        else {
          if (
            !(await publishing.claimPublishJob(context.pool, id(request), [
              "PENDING",
              "FAILED",
              "QUEUED",
            ]))
          )
            throw conflict("This publish job is already processing");
          await publishing.executeSocialPublishJob(context.pool, id(request), {
            config: context.config,
            log: request.log,
          });
        }
      } else throw bad("Unsupported action");
      return {
        post:
          (await posts.getSocialPost(context.pool, org, job.postId)) ?? null,
      };
    },
  );
  const removed = async (
    request: FastifyRequest,
    confirmation: string | null,
  ) => {
    const signed = (request.body as { signed_request?: unknown })
      ?.signed_request;
    if (typeof signed !== "string") throw bad("Invalid request");
    const external = auth.verifyThreadsSignedRequest(context.config, signed);
    const orgs = await publishing.removeThreadsConnectionData(
      context.pool,
      external,
      confirmation,
    );
    for (const org of orgs)
      try {
        await syncOrgConnections(context.pool, org);
      } catch (error) {
        request.log.warn(
          {
            event: "operation.failed",
            operation: "social_connections.sync_after_uninstall",
            provider: "threads",
            org_id: org,
            error_type: error instanceof Error ? error.name : "unknown",
          },
          "failed to sync connections after Threads removal",
        );
      }
  };
  app.post("/api/social/oauth/threads/uninstall", async (request) => {
    await removed(request, null);
    return { success: true };
  });
  app.post("/api/social/oauth/threads/data-deletion", async (request) => {
    const confirmation = createId().replaceAll("-", "");
    await removed(request, confirmation);
    return {
      url: auth.threadsDataDeletionStatusUrl(context.config, confirmation),
      confirmation_code: confirmation,
    };
  });
  app.get(
    "/api/social/oauth/threads/data-deletion/status/:confirmation_code",
    async (request, reply) => {
      const confirmation = (request.params as { confirmation_code: string })
        .confirmation_code;
      const status =
        Buffer.byteLength(confirmation) <= 128
          ? await publishing.threadsDataDeletionStatus(
              context.pool,
              confirmation,
            )
          : undefined;
      if (status === undefined)
        return reply
          .code(404)
          .type("text/html; charset=utf-8")
          .send(
            "<!doctype html><title>Deletion request not found</title><h1>Deletion request not found</h1>",
          );
      const message =
        status === "COMPLETED"
          ? "Your Threads connection data has been deleted from KasiTek."
          : "Your Threads data deletion request is being processed.";
      return reply
        .type("text/html; charset=utf-8")
        .send(
          `<!doctype html><title>Threads data deletion</title><h1>Threads data deletion</h1><p>${message}</p>`,
        );
    },
  );
  app.register(async (webhook) => {
    webhook.removeContentTypeParser("application/json");
    webhook.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
    webhook.post("/api/webhooks/tiktok", async (request) => {
      const body = request.body as Buffer;
      webhooks.verifyTiktokWebhookSignature(
        typeof request.headers["tiktok-signature"] === "string"
          ? request.headers["tiktok-signature"]
          : undefined,
        body,
        context.config.rawEnv,
      );
      const payload = webhooks.parseTiktokWebhookEnvelope(
        body,
        context.config.rawEnv,
      );
      return {
        received: true,
        duplicate: !(await webhooks.recordTiktokWebhookEvent(
          context.pool,
          payload,
          body,
        )),
      };
    });
  });
}
