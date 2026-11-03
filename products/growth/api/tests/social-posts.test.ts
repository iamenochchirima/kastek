import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { installPgTimestampParsers } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { registerSocialRoutes } from "../src/routes/social.js";
import { sha256 } from "../src/identity/session.js";
import {
  generatedSocialPostTitle,
  createSocialPostIdempotent,
  getSocialPost,
  listSocialPosts,
  updateSocialPost,
  deleteSocialPost,
  getSocialPostActivity,
} from "../src/services/social/posts.js";
import {
  listSocialChannels,
  platformCapabilities,
} from "../src/services/social/channels.js";
import { parseOptionalDatetime, validatePostSchedule } from "../src/services/social/common.js";
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
  assert.deepEqual((platformCapabilities("FACEBOOK").media as { images: unknown }).images, { supported: true, maxCount: 1 });
  assert.equal(platformCapabilities("unknown").canPublish, false);
});
test("scheduled posts require a future, explicit timestamp", () => {
  assert.throws(() => parseOptionalDatetime("2030-01-01T09:00"), /Scheduled time is invalid/);
  assert.throws(() => validatePostSchedule("SCHEDULED", null), /future/);
  assert.throws(() => validatePostSchedule("SCHEDULED", new Date(0)), /future/);
  assert.doesNotThrow(() => validatePostSchedule("SCHEDULED", new Date(Date.now() + 60_000)));
  assert.doesNotThrow(() => validatePostSchedule("DRAFT", null));
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
      await pool.query('ALTER TABLE "ContentMediaAsset" ADD COLUMN "archivedAt" timestamp, ADD COLUMN "defaultAltText" text');
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
      await assert.rejects(createSocialPostIdempotent(pool, "user", "org", { ...input, content: "Changed content" }, "synthetic-key"), /reused for a different request/);
      await assert.rejects(createSocialPostIdempotent(pool, "other-actor", "org", input, "synthetic-key"), /reused for a different request/);
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
      assert.equal(updated.publishJobs[0]!.id, one.publishJobs[0]!.id);
      assert.equal(updated.media.length, 1);
      assert.equal(updated.publishJobs[0]!.status, "PENDING");
      await pool.query('UPDATE "SocialPublishJob" SET status=\'PUBLISHED\',"externalPostId"=\'provider-post\' WHERE id=$1', [updated.publishJobs[0]!.id]);
      await assert.rejects(updateSocialPost(pool, "user", "org", one.id, {
        content: "must not replace delivered content", status: "DRAFT", channelSelections: { FACEBOOK: "channel" },
      }), /publishing attempt/);
      assert.equal((await getSocialPost(pool, "org", one.id))!.publishJobs[0]!.external_post_id, "provider-post");
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

      const draftInput = {
        content: "Facebook draft before connecting a Page.",
        channels: ["FACEBOOK"],
      };
      const draft = await createSocialPostIdempotent(pool, "user", "org", draftInput, "unassigned-draft");
      assert.equal(draft.status, "DRAFT");
      assert.equal(draft.primary_channel_id, null);
      assert.equal(draft.publishJobs[0]!.channel_connection_id, null);
      assert.equal(draft.publishJobs[0]!.status, "PENDING");
      assert.equal((await getSocialPost(pool, "org", draft.id))!.content, draftInput.content);
      const editedDraft = await updateSocialPost(pool, "user", "org", draft.id, {
        content: "Edited Facebook draft before connecting a Page.",
      });
      assert.equal(editedDraft.id, draft.id);
      assert.equal(editedDraft.publishJobs[0]!.id, draft.publishJobs[0]!.id);
      assert.equal(editedDraft.publishJobs[0]!.channel_connection_id, null);
      assert.equal((await getSocialPost(pool, "org", draft.id))!.content, "Edited Facebook draft before connecting a Page.");
      await assert.rejects(updateSocialPost(pool, "user", "org", draft.id, {
        status: "SCHEDULED", scheduledFor: "2030-01-01T12:00:00Z",
      }), /Choose a connected facebook account before scheduling/);
      await assert.rejects(createSocialPostIdempotent(pool, "user", "org", {
        ...draftInput, status: "SCHEDULED", scheduledFor: "2030-01-01T12:00:00Z",
      }), /Choose a connected facebook account before scheduling/);
      for (const invalidId of ["foreign-channel", "missing-channel"]) {
        await assert.rejects(createSocialPostIdempotent(pool, "user", "org", {
          ...draftInput, channelSelections: { FACEBOOK: invalidId },
        }), /Selected channel was not found/);
        await assert.rejects(updateSocialPost(pool, "user", "org", draft.id, {
          channelSelections: { FACEBOOK: invalidId },
        }), /Selected channel was not found/);
      }
      await pool.query('UPDATE "SocialChannelConnection" SET status=\'DISCONNECTED\' WHERE id=\'channel\'');
      await assert.rejects(updateSocialPost(pool, "user", "org", draft.id, {
        channelSelections: { FACEBOOK: "channel" },
      }), /Choose a connected facebook account before saving/);
      await pool.query('UPDATE "SocialChannelConnection" SET status=\'CONNECTED\' WHERE id=\'channel\'');
      const assigned = await updateSocialPost(pool, "user", "org", draft.id, {
        status: "SCHEDULED", scheduledFor: "2030-01-01T12:00:00Z", channelSelections: { FACEBOOK: "channel" },
      });
      assert.equal(assigned.publishJobs[0]!.channel_connection_id, "channel");
      assert.equal(assigned.publishJobs[0]!.status, "QUEUED");
      const retainedSelection = await updateSocialPost(pool, "user", "org", draft.id, {
        status: "DRAFT", content: "Edit retains the selected Page.",
      });
      assert.equal(retainedSelection.publishJobs[0]!.channel_connection_id, "channel");

      await pool.query(`CREATE TABLE "User"(id text,name text,email text,phone text,image text,"emailVerified" timestamp,"createdAt" timestamp,"updatedAt" timestamp);
        CREATE TABLE "Session"("userId" text,"refreshToken" text,"identityCheckedAt" timestamp,"providerRefreshedAt" timestamp,"sessionToken" text,expires timestamp,"lastActivityAt" timestamp);
        CREATE TABLE "Organization"(id text,"createdAt" timestamp);
        CREATE TABLE "OrganizationMember"("orgId" text,"userId" text,role text);
        INSERT INTO "User" VALUES('user','Synthetic','fixture@example.test',NULL,NULL,NOW(),NOW(),NOW());
        INSERT INTO "Organization" VALUES('org',NOW());
        INSERT INTO "OrganizationMember" VALUES('org','user','OWNER');`);
      await pool.query(`INSERT INTO "Session" VALUES('user','unused',NOW(),NOW(),$1,NOW()+INTERVAL '1 day',NOW())`, [sha256("social-draft-session")]);
      const config = readConfig({ DATABASE_URL: "postgres://unused", LOG_LEVEL: "silent" });
      const app = await buildApp({ pool, config }, [registerSocialRoutes]);
      try {
        const headers = { cookie: "kasitek_session=social-draft-session", origin: config.frontendUrl };
        const channelResponse = await app.inject({ url: "/api/social/channels", headers });
        assert.equal(channelResponse.statusCode, 200, channelResponse.body);
        const wireChannel = channelResponse.json().channels.find((channel: { id: string }) => channel.id === "channel");
        assert.equal(wireChannel.displayName, "Synthetic");
        assert.equal(wireChannel.userId, "user");
        assert.equal(wireChannel.display_name, undefined);
        assert.ok(Number.isFinite(Date.parse(wireChannel.createdAt)));
        const response = await app.inject({ method: "POST", url: "/api/social/posts", headers,
          payload: { ...draftInput, media: [{ assetId: "asset", altText: "Saved alternative text" }], metadata: { keep_snake_key: "unchanged" } } });
        assert.equal(response.statusCode, 201, response.body);
        const wirePost = response.json().post;
        assert.equal(wirePost.userId, "user");
        assert.ok(Number.isFinite(Date.parse(wirePost.createdAt)));
        assert.ok(Number.isFinite(Date.parse(wirePost.updatedAt)));
        assert.equal(wirePost.created_at, undefined);
        assert.equal(wirePost.scheduledFor, null);
        assert.equal(wirePost.publishJobs[0].postId, wirePost.id);
        assert.equal(wirePost.publishJobs[0].channelConnectionId, null);
        assert.equal(wirePost.variants[0].postId, wirePost.id);
        assert.equal(wirePost.media[0].assetId, "asset");
        assert.equal(wirePost.media[0].altText, "Saved alternative text");
        assert.equal(wirePost.media[0].mimeType, "image/png");
        assert.equal(wirePost.metadata.keep_snake_key, "unchanged");
        const fetched = await app.inject({ url: `/api/social/posts/${wirePost.id}`, headers });
        assert.deepEqual(fetched.json().post, wirePost);
        const edited = await app.inject({ method: "PATCH", url: `/api/social/posts/${wirePost.id}`,
          headers: { ...headers, "if-match": wirePost.updatedAt }, payload: { content: "Edited using the returned revision." } });
        assert.equal(edited.statusCode, 200, edited.body);
        assert.equal(edited.json().post.id, wirePost.id);
        assert.equal(edited.json().post.content, "Edited using the returned revision.");
        assert.ok(Number.isFinite(Date.parse(edited.json().post.updatedAt)));
        const listed = await app.inject({ url: "/api/social/posts", headers });
        assert.deepEqual(listed.json().posts.find((post: { id: string }) => post.id === wirePost.id), edited.json().post);
      } finally {
        await app.close();
      }
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
