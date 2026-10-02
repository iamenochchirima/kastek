import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { installPgTimestampParsers } from "../src-ts/db.js";
import {
  generatedSocialPostTitle,
  createSocialPostIdempotent,
  getSocialPost,
  listSocialPosts,
  updateSocialPost,
  deleteSocialPost,
  getSocialPostActivity,
} from "../src-ts/services/social/posts.js";
import {
  listSocialChannels,
  platformCapabilities,
} from "../src-ts/services/social/channels.js";
import { parseOptionalDatetime } from "../src-ts/services/social/common.js";
installPgTimestampParsers();
test("social schedule validation retains RFC3339 calendar and fraction boundaries", () => {
  assert.equal(
    parseOptionalDatetime("2030-01-01t12:00:00.123456z")!.toISOString(),
    "2030-01-01T12:00:00.123456Z",
  );
  assert.equal(
    parseOptionalDatetime("2016-12-31T23:59:60.123456Z")!.toISOString(),
    "2017-01-01T00:00:00.123456Z",
  );
  assert.throws(
    () => parseOptionalDatetime("2030-01-01T24:00:00Z"),
    /Scheduled time is invalid/,
  );
  assert.throws(
    () => parseOptionalDatetime("2030-02-30T12:00:00Z"),
    /Scheduled time is invalid/,
  );
});
test("content title generation uses Unicode characters and safe provider capability metadata", () => {
  assert.equal(
    generatedSocialPostTitle(" \n first   line \n second"),
    "first line",
  );
  assert.equal(
    generatedSocialPostTitle("😀".repeat(81)),
    "😀".repeat(77) + "...",
  );
  assert.equal(generatedSocialPostTitle(""), "Untitled social post");
  assert.equal(platformCapabilities("INSTAGRAM").supportsMediaUpload, true);
  assert.equal(platformCapabilities("unknown").canPublish, false);
});
test(
  "isolated content CRUD preserves media snapshots, scope boundaries and concurrent draft idempotency",
  { skip: !process.env.CORE_SOCIAL_TEST_DATABASE_URL },
  async () => {
    const schema = `social_test_${randomUUID().replaceAll("-", "")}`;
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
 CREATE TABLE "SocialChannelConnection"(id text PRIMARY KEY,"userId" text,"orgId" text,platform "SocialPlatform",status "SocialChannelStatus","displayName" text,handle text,"externalAccountId" text,metadata jsonb,"lastSyncedAt" timestamp,"createdAt" timestamp DEFAULT NOW(),"updatedAt" timestamp DEFAULT NOW());
 CREATE TABLE "SocialPost"(id text PRIMARY KEY,"userId" text,"orgId" text,"primaryChannelId" text,title text,prompt text,content text,channels "SocialPlatform"[],status "SocialPostStatus","scheduledFor" timestamp,"publishedAt" timestamp,metadata jsonb,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE "SocialPostVariant"(id text PRIMARY KEY,"postId" text REFERENCES "SocialPost" ON DELETE CASCADE,platform "SocialPlatform",content text,status "SocialVariantStatus","aiGenerated" boolean,metadata jsonb,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE "SocialPublishJob"(id text PRIMARY KEY,"userId" text,"orgId" text,"postId" text REFERENCES "SocialPost" ON DELETE CASCADE,"variantId" text,"channelConnectionId" text,platform "SocialPlatform",status "SocialPublishJobStatus","scheduledFor" timestamp,"publishedAt" timestamp,"externalPostId" text,"errorMessage" text,metadata jsonb,"deliverySnapshot" jsonb,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE "ContentMediaAsset"(id text PRIMARY KEY,"orgId" text,kind text,"mimeType" text,"fileName" text,"byteSize" bigint,width integer,height integer,"durationMs" integer,"processingStatus" "ContentMediaProcessingStatus","scanStatus" "ContentMediaScanStatus");
 CREATE TABLE "SocialPostMedia"(id text PRIMARY KEY,"postId" text REFERENCES "SocialPost" ON DELETE CASCADE,"assetId" text,"sortOrder" integer,"altText" text,metadata jsonb);
 INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName",metadata) VALUES('channel','user','org','FACEBOOK','CONNECTED','Synthetic','{"scope":"private","dpopPrivateKey":"private","authMethod":"meta"}'),('foreign-channel','foreign-user','foreign-org','FACEBOOK','CONNECTED','Foreign','{}');
 INSERT INTO "ContentMediaAsset" VALUES('asset','org','IMAGE','image/png','synthetic.png',9223372036854775807,1,1,NULL,'READY','CLEAN'),('foreign-asset','foreign-org','IMAGE','image/png','foreign.png',1,1,1,NULL,'READY','CLEAN');`);
      const input = {
        content: "  First line\nnext line ",
        channels: ["UNKNOWN", "FACEBOOK"],
        primaryChannelId: "channel",
        channelSelections: { FACEBOOK: "channel" },
        status: "SCHEDULED",
        scheduledFor: "2030-01-01T12:00:00.123456Z",
        media: [{ assetId: "asset", altText: "  A synthetic image " }],
        variants: [
          {
            platform: "FACEBOOK",
            content: " custom ",
            status: "APPROVED",
            aiGenerated: true,
          },
        ],
      };
      const [one, two] = await Promise.all([
        createSocialPostIdempotent(pool, "user", "org", input, "synthetic-key"),
        createSocialPostIdempotent(pool, "user", "org", input, "synthetic-key"),
      ]);
      assert.equal(one.id, two.id);
      assert.equal(one.title, "First line");
      assert.equal(one.publishJobs[0]!.status, "QUEUED");
      assert.equal(one.variants[0]!.content, "custom");
      assert.equal(
        one.scheduled_for!.toISOString(),
        "2030-01-01T12:00:00.123456Z",
      );
      assert.equal(one.media[0]!.byte_size, 9223372036854775807n);
      assert.deepEqual(one.publishJobs[0]!.deliverySnapshot, {
        schema: "kasitek-content-delivery-v1",
        platform: "FACEBOOK",
        media: [
          { assetId: "asset", sortOrder: 0, altText: "A synthetic image" },
        ],
      });
      assert.equal(await getSocialPost(pool, "foreign-org", one.id), undefined);
      assert.equal((await listSocialPosts(pool, "org")).length, 1);
      const channels = await listSocialChannels(pool, "org");
      assert.deepEqual(channels[0]!.metadata, { authMethod: "meta" });
      assert.equal(
        (one.primaryChannel!.metadata as { scope: string }).scope,
        "private",
      );
      await assert.rejects(
        createSocialPostIdempotent(
          pool,
          "user",
          "org",
          { ...input, media: [{ assetId: "foreign-asset" }] },
          "other",
        ),
        /belong to this workspace/,
      );
      await assert.rejects(
        createSocialPostIdempotent(
          pool,
          "user",
          "org",
          { ...input, channelSelections: { FACEBOOK: "foreign-channel" } },
          "other",
        ),
        /Selected channel was not found/,
      );
      const updated = await updateSocialPost(pool, "user", "org", one.id, {
        content: "new content",
        channelSelections: { FACEBOOK: "channel" },
        status: "DRAFT",
      });
      assert.equal(updated.title, "new content");
      assert.equal(updated.variants[0]!.content, "new content");
      assert.equal(updated.variants[0]!.status, "DRAFT");
      assert.notEqual(updated.publishJobs[0]!.id, one.publishJobs[0]!.id);
      assert.equal(updated.media.length, 1);
      assert.equal(updated.publishJobs[0]!.status, "PENDING");
      assert.equal(
        (
          (await getSocialPostActivity(pool, "org", one.id)) as {
            postId: string;
          }
        ).postId,
        one.id,
      );
      assert.equal(await deleteSocialPost(pool, "foreign-org", one.id), false);
      assert.equal(await deleteSocialPost(pool, "org", one.id), true);
      assert.equal(
        (
          await pool.query(
            'SELECT COUNT(*)::integer AS count FROM "SocialPublishJob"',
          )
        ).rows[0].count,
        0,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
