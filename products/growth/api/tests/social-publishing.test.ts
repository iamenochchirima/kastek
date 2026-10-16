import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { installPgTimestampParsers, UtcTimestamp } from "../src/db.js";
import { readConfig } from "../src/config.js";
import { encryptSocialSecret } from "../src/integrations/crypto.js";
import {
  createSocialPostIdempotent,
  getSocialPost,
} from "../src/services/social/posts.js";
import {
  claimPublishJob,
  executeSocialPublishJob,
  deleteSocialPostFromPlatform,
  processTiktokWebhookEvents,
  removeThreadsConnectionData,
  threadsDataDeletionStatus,
} from "../src/services/social/publishing.js";
import { recordTiktokWebhookEvent } from "../src/services/social/webhooks.js";
import {
  getSocialPostInsights,
  parseInsightsFilters,
  numericValue,
} from "../src/services/social/insights.js";
import {
  publishPostToThreads,
  publishPostToInstagram,
  publishPostToLinkedin,
  deletePostFromProvider,
  providerJson,
} from "../src/services/social/provider-publishing.js";
installPgTimestampParsers();
const config = readConfig({
  DATABASE_URL: "postgres://unused",
  SOCIAL_TOKEN_ENCRYPTION_KEY: "isolated-social-fixture-secret",
});
const encrypted = encryptSocialSecret(config, "synthetic-provider-token");
const response = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });
test("provider publishing fixtures preserve multi-stage calls, trusted uploads, deletion and unknown transport outcomes", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fixture =
    (values: Response[]): typeof fetch =>
    async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      const value = values.shift();
      assert.ok(value, "unexpected fixture call");
      return value;
    };
  assert.deepEqual(
    await publishPostToThreads(
      config,
      encrypted,
      "threads-id",
      "synthetic",
      null,
      {
        fetch: fixture([
          response({ id: "container" }),
          response({ id: "published" }),
        ]),
      },
    ),
    ["published", "synthetic"],
  );
  assert.equal(
    calls[1]!.url,
    "https://graph.threads.com/v1.0/threads-id/threads_publish",
  );
  assert.equal(
    (calls[1]!.init.body as URLSearchParams).get("creation_id"),
    "container",
  );
  assert.deepEqual(
    await publishPostToInstagram(
      config,
      encrypted,
      "ig-id",
      { authMethod: "instagram_login" },
      "https://synthetic.example/image.png",
      "caption",
      {
        fetch: fixture([
          response({ id: "ig-container" }),
          response({ status_code: "FINISHED" }),
          response({ id: "ig-post" }),
        ]),
        sleep: async () => {
          throw Error("unexpected sleep");
        },
      },
    ),
    ["ig-post", "caption"],
  );
  assert.deepEqual(
    await publishPostToLinkedin(
      config,
      encrypted,
      "actor",
      null,
      "body",
      null,
      {
        fetch: fixture([
          new Response("", {
            status: 201,
            headers: { "x-restli-id": "urn:li:share:synthetic" },
          }),
        ]),
      },
    ),
    ["urn:li:share:synthetic", "body"],
  );
  await assert.rejects(
    publishPostToLinkedin(
      config,
      encrypted,
      "actor",
      null,
      "body",
      { bytes: Buffer.from("image"), mime_type: "image/png", alt_text: "alt" },
      {
        fetch: fixture([
          response({
            value: {
              uploadUrl: "https://attacker.example/image",
              image: "urn:li:image:fake",
            },
          }),
        ]),
      },
    ),
    /not trusted/,
  );
  await deletePostFromProvider(
    config,
    "X",
    encrypted,
    null,
    null,
    "synthetic",
    { fetch: fixture([new Response("", { status: 404 })]) },
  );
  await assert.rejects(
    deletePostFromProvider(
      config,
      "INSTAGRAM",
      encrypted,
      null,
      { authMethod: "instagram_login" },
      "synthetic",
    ),
    /Meta\/Facebook Login/,
  );
  await assert.rejects(
    providerJson("https://synthetic.example", {}, "fallback", {
      fetch: async () => {
        throw Error("socket timed out");
      },
    }),
    { status: 504, code: "gateway_timeout" },
  );
  assert.equal(numericValue(1.5), null);
  assert.equal(
    numericValue({ likes: 9223372036854775807n, comments: 1 }),
    9223372036854775807n,
  );
});

test(
  "isolated durable publishing preserves claims, unknown outcomes, provider-confirmed deletion, webhook retries and precise insight history",
  { skip: !process.env.CORE_SOCIAL_TEST_DATABASE_URL },
  async () => {
    const schema = `social_publish_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({
      connectionString: process.env.CORE_SOCIAL_TEST_DATABASE_URL,
    });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: process.env.CORE_SOCIAL_TEST_DATABASE_URL,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });
    try {
      await pool.query(`CREATE TYPE "SocialPlatform" AS ENUM('FACEBOOK','INSTAGRAM','THREADS','TIKTOK','BLUESKY','LINKEDIN','X');CREATE TYPE "SocialChannelStatus" AS ENUM('CONNECTED','DISCONNECTED','NEEDS_REAUTH');CREATE TYPE "SocialPostStatus" AS ENUM('DRAFT','SCHEDULED','PROCESSING','PUBLISHED','FAILED');CREATE TYPE "SocialVariantStatus" AS ENUM('DRAFT','APPROVED','NEEDS_EDITS');CREATE TYPE "SocialPublishJobStatus" AS ENUM('PENDING','QUEUED','PROCESSING','PUBLISHED','FAILED','CANCELED');CREATE TYPE "ContentMediaProcessingStatus" AS ENUM('READY','FAILED');CREATE TYPE "ContentMediaScanStatus" AS ENUM('CLEAN','PENDING');
 CREATE TABLE "SocialChannelConnection"(id text PRIMARY KEY,"userId" text,"orgId" text,platform "SocialPlatform",status "SocialChannelStatus","displayName" text,handle text,"externalAccountId" text,"accessToken" text,"refreshToken" text,metadata jsonb,"lastSyncedAt" timestamp,"createdAt" timestamp DEFAULT NOW(),"updatedAt" timestamp DEFAULT NOW());
 CREATE TABLE "SocialPost"(id text PRIMARY KEY,"userId" text,"orgId" text,"primaryChannelId" text,title text,prompt text,content text,channels "SocialPlatform"[],status "SocialPostStatus","scheduledFor" timestamp,"publishedAt" timestamp,metadata jsonb,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE "SocialPostVariant"(id text PRIMARY KEY,"postId" text REFERENCES "SocialPost" ON DELETE CASCADE,platform "SocialPlatform",content text,status "SocialVariantStatus","aiGenerated" boolean,metadata jsonb,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE "SocialPublishJob"(id text PRIMARY KEY,"userId" text,"orgId" text,"postId" text REFERENCES "SocialPost" ON DELETE CASCADE,"variantId" text,"channelConnectionId" text,platform "SocialPlatform",status "SocialPublishJobStatus","scheduledFor" timestamp,"publishedAt" timestamp,"externalPostId" text,"errorMessage" text,metadata jsonb,"deliverySnapshot" jsonb,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE "ContentMediaAsset"(id text PRIMARY KEY,"orgId" text,kind text,"mimeType" text,"fileName" text,"byteSize" bigint,width integer,height integer,"durationMs" integer,"processingStatus" "ContentMediaProcessingStatus","scanStatus" "ContentMediaScanStatus");
 CREATE TABLE "SocialPostMedia"(id text PRIMARY KEY,"postId" text REFERENCES "SocialPost" ON DELETE CASCADE,"assetId" text,"sortOrder" integer,"altText" text,metadata jsonb);

 CREATE TABLE "SocialWebhookEvent"(id text PRIMARY KEY,provider text,"eventKey" text,"eventType" text,"externalAccountId" text,payload jsonb,status text,attempts integer,"nextAttemptAt" timestamp,"receivedAt" timestamp,"createdAt" timestamp,"updatedAt" timestamp,"processedAt" timestamp,"errorMessage" text,UNIQUE(provider,"eventKey"));
 CREATE TABLE "SocialDataDeletionRequest"(id text PRIMARY KEY,provider text,"confirmationCode" text,status text,"completedAt" timestamp,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE "SocialPostInsightObservation"(id text PRIMARY KEY,"orgId" text,"postId" text,"publishJobId" text,platform "SocialPlatform","metricKey" text,value bigint,availability text,"providerMetricKey" text,"observationKey" text UNIQUE,"observedAt" timestamp,"fetchedAt" timestamp,"windowStart" timestamp,"windowEnd" timestamp,"adapterVersion" text,metadata jsonb);
 CREATE TABLE "SocialPostInsightSyncState"(id text PRIMARY KEY,"orgId" text,platform "SocialPlatform",status text,retryable boolean,"consecutiveFailures" integer,"lastAttemptAt" timestamp,"lastSuccessAt" timestamp,"nextRetryAt" timestamp,"lastErrorCode" text,"lastErrorMessage" text,"updatedAt" timestamp,UNIQUE("orgId",platform));`);
      await pool.query(
        `INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","externalAccountId","accessToken",metadata) VALUES('x','user','org','X','CONNECTED','Synthetic','synthetic-x',$1,'{}'),('tiktok','user','org','TIKTOK','CONNECTED','Synthetic','synthetic-tiktok',$1,'{}'),('threads','user','org','THREADS','CONNECTED','Synthetic','synthetic-threads',$1,'{}')`,
        [encrypted],
      );
      const post = await createSocialPostIdempotent(
        pool,
        "user",
        "org",
        {
          content: "synthetic",
          channels: ["X"],
          channelSelections: { X: "x" },
        },
        "publish",
      );
      const job = post.publishJobs[0]!;
      assert.deepEqual(
        (
          await Promise.all([
            claimPublishJob(pool, job.id, ["PENDING"]),
            claimPublishJob(pool, job.id, ["PENDING"]),
          ])
        ).sort((a, b) => Number(b) - Number(a)),
        [true, false],
      );
      const published = await executeSocialPublishJob(pool, job.id, {
        config,
        fetch: async () =>
          response({ data: { id: "synthetic-post-id", text: "synthetic" } }),
      });
      assert.equal(published.status, "PUBLISHED");
      assert.equal(
        (await getSocialPost(pool, "org", post.id))!.status,
        "PUBLISHED",
      );
      await assert.rejects(
        deleteSocialPostFromPlatform(pool, config, "other-org", post.id, "X", {
          fetch: async () => {
            throw Error("unexpected external call");
          },
        }),
        /Post not found/,
      );
      const failure = await deleteSocialPostFromPlatform(
        pool,
        config,
        "org",
        post.id,
        "X",
        {
          fetch: async () => new Response("permission denied", { status: 403 }),
        },
      );
      assert.equal(failure.success, false);
      assert.ok(await getSocialPost(pool, "org", post.id));
      const deleted = await deleteSocialPostFromPlatform(
        pool,
        config,
        "org",
        post.id,
        "X",
        { fetch: async () => new Response("", { status: 404 }) },
      );
      assert.equal(deleted.localDeleted, true);
      const unknown = await createSocialPostIdempotent(
        pool,
        "user",
        "org",
        { content: "unknown", channels: ["X"], channelSelections: { X: "x" } },
        "unknown",
      );
      await claimPublishJob(pool, unknown.publishJobs[0]!.id, ["PENDING"]);
      await assert.rejects(
        executeSocialPublishJob(pool, unknown.publishJobs[0]!.id, {
          config,
          fetch: async () => {
            throw Error("socket timed out");
          },
        }),
        { status: 504 },
      );
      const unknownResult = (await getSocialPost(pool, "org", unknown.id))!;
      assert.equal(unknownResult.status, "PROCESSING");
      assert.equal(
        (unknownResult.publishJobs[0]!.metadata as { _kasitek_outcome: string })
          ._kasitek_outcome,
        "UNKNOWN",
      );
      const tik = await createSocialPostIdempotent(
        pool,
        "user",
        "org",
        {
          content: "TikTok",
          channels: ["TIKTOK"],
          channelSelections: { TIKTOK: "tiktok" },
        },
        "tik",
      );
      await pool.query(
        `UPDATE "SocialPublishJob" SET status='PROCESSING',"externalPostId"='synthetic-publish' WHERE id=$1`,
        [tik.publishJobs[0]!.id],
      );
      const envelope = {
        event: "post.publish.failed",
        user_openid: "synthetic-tiktok",
        content: JSON.stringify({
          publish_id: "synthetic-publish",
          reason: "synthetic rejection",
        }),
      };
      const bytes = Buffer.from(JSON.stringify(envelope));
      assert.equal(await recordTiktokWebhookEvent(pool, envelope, bytes), true);
      assert.equal(
        await recordTiktokWebhookEvent(pool, envelope, bytes),
        false,
      );
      assert.equal(await processTiktokWebhookEvents(pool, 1), 1);
      assert.equal(
        (await getSocialPost(pool, "org", tik.id))!.status,
        "FAILED",
      );
      assert.equal(
        (await pool.query('SELECT status FROM "SocialWebhookEvent"')).rows[0]
          .status,
        "PROCESSED",
      );
      await recordTiktokWebhookEvent(
        pool,
        { event: "post.publish.complete", content: "{}" },
        Buffer.from("synthetic-invalid"),
      );
      await processTiktokWebhookEvents(pool, 1);
      assert.equal(
        (
          await pool.query(
            `SELECT attempts,status,"nextAttemptAt">NOW() AS delayed FROM "SocialWebhookEvent" WHERE status='FAILED'`,
          )
        ).rows[0].delayed,
        true,
      );
      const insight = await createSocialPostIdempotent(
        pool,
        "user",
        "org",
        { content: "insights", channels: ["X"], channelSelections: { X: "x" } },
        "insights",
      );
      await pool.query(
        `UPDATE "SocialPublishJob" SET status='PUBLISHED',"externalPostId"='synthetic-insight',"publishedAt"='2030-01-01 00:00:00.123456' WHERE id=$1;`,
        [insight.publishJobs[0]!.id],
      );
      for (const [key, time, value] of [
        ["old", "2030-01-01 00:00:00.123455", "9007199254740993"],
        ["new", "2030-01-01 00:00:00.123456", "9007199254740995"],
      ])
        await pool.query(
          `INSERT INTO "SocialPostInsightObservation"(id,"orgId","postId","publishJobId",platform,"metricKey",value,availability,"observationKey","observedAt","fetchedAt","adapterVersion") VALUES($1,'org',$2,$3,'X','likes',$4,'available',$1,$5,$5,'fixture')`,
          [key, insight.id, insight.publishJobs[0]!.id, value, time],
        );
      const report = (await getSocialPostInsights(
        pool,
        "org",
        insight.id,
        parseInsightsFilters("x", "likes"),
      ))!;
      assert.equal(report.platforms[0]!.metrics[0]!.value, 9007199254740995n);
      assert.equal(report.platforms[0]!.metrics[0]!.absoluteChange, 2);
      assert.equal(
        report.platforms[0]!.metrics[0]!.observedAt.toISOString(),
        "2030-01-01T00:00:00.123456Z",
      );
      assert.equal(
        await getSocialPostInsights(
          pool,
          "foreign-org",
          insight.id,
          parseInsightsFilters(),
        ),
        undefined,
      );
      const threads = await createSocialPostIdempotent(
        pool,
        "user",
        "org",
        {
          content: "Keep authored content",
          channels: ["THREADS"],
          channelSelections: { THREADS: "threads" },
        },
        "threads",
      );
      assert.deepEqual(
        await removeThreadsConnectionData(
          pool,
          "synthetic-threads",
          "synthetic-confirmation",
        ),
        ["org"],
      );
      assert.equal(
        await threadsDataDeletionStatus(pool, "synthetic-confirmation"),
        "COMPLETED",
      );
      assert.ok(await getSocialPost(pool, "org", threads.id));
      assert.equal(
        (await getSocialPost(pool, "org", threads.id))!.publishJobs[0]!
          .channel_connection_id,
        null,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
