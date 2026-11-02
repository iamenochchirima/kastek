import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { readConfig } from "../src/config.js";
import { installPgTimestampParsers } from "../src/db.js";
import { encryptSocialSecret } from "../src/integrations/crypto.js";
import { updatePublishedFacebookPost, reconcilePublishedFacebookEdit } from "../src/capabilities/content-published-edit.js";
import { getSocialPost, deleteSocialPost } from "../src/services/social/posts.js";
import { facebookPublishedMutationTarget } from "../src/services/social/provider-publishing.js";
import { deleteSocialPostFromPlatforms } from "../src/services/social/publishing.js";
import type { RequestContext } from "../src/identity/request-context.js";
installPgTimestampParsers();
const config = readConfig({ DATABASE_URL: "postgres://unused", SOCIAL_TOKEN_ENCRYPTION_KEY: "fixture" });
const context = (key = "edit-one", org = "org"): RequestContext => ({ principal: { kind: "direct_user", id: "user", subjectUserId: "user", clientId: null }, organizationId: org, userId: "user", clientId: null, effectiveGrants: new Set(), apiScopes: null, correlationId: null, causationId: null, idempotencyKey: key });
const schemaSql = `
 CREATE TYPE "SocialPlatform" AS ENUM('FACEBOOK','INSTAGRAM','THREADS','TIKTOK','BLUESKY','LINKEDIN','X');
 CREATE TYPE "SocialChannelStatus" AS ENUM('CONNECTED','DISCONNECTED','NEEDS_REAUTH');
 CREATE TYPE "SocialPublishJobStatus" AS ENUM('PENDING','QUEUED','PROCESSING','PUBLISHED','FAILED','CANCELED');
 CREATE TYPE "SocialPostStatus" AS ENUM('DRAFT','SCHEDULED','PROCESSING','PUBLISHED','FAILED');
 CREATE TABLE "SocialChannelConnection"(id text PRIMARY KEY,"userId" text,"orgId" text,platform "SocialPlatform",status "SocialChannelStatus","displayName" text,handle text,"externalAccountId" text,"accessToken" text,"refreshToken" text,metadata jsonb,"lastSyncedAt" timestamp,"createdAt" timestamp DEFAULT NOW(),"updatedAt" timestamp DEFAULT NOW());
 CREATE TABLE "SocialPost"(id text PRIMARY KEY,"userId" text,"orgId" text,"primaryChannelId" text,title text,prompt text,content text,channels text[],status "SocialPostStatus","scheduledFor" timestamp,"publishedAt" timestamp,metadata jsonb,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE "SocialPostVariant"(id text PRIMARY KEY,"postId" text REFERENCES "SocialPost" ON DELETE CASCADE,platform text,content text,status text,"aiGenerated" boolean,metadata jsonb,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE "SocialPublishJob"(id text PRIMARY KEY,"userId" text,"orgId" text,"postId" text REFERENCES "SocialPost" ON DELETE CASCADE,"variantId" text,"channelConnectionId" text,platform text,status "SocialPublishJobStatus","scheduledFor" timestamp,"publishedAt" timestamp,"externalPostId" text,"errorMessage" text,metadata jsonb,"deliverySnapshot" jsonb,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE "SocialPostVariantMedia"(id text PRIMARY KEY,"variantId" text REFERENCES "SocialPostVariant" ON DELETE CASCADE,"assetId" text,"sortOrder" integer,"altText" text,metadata jsonb);
 CREATE TABLE "ContentMediaAsset"(id text PRIMARY KEY,"orgId" text,kind text,"mimeType" text,"fileName" text,"byteSize" bigint,width integer,height integer,"durationMs" integer,"processingStatus" text,"scanStatus" text);
 CREATE TABLE "SocialPostMedia"(id text PRIMARY KEY,"postId" text REFERENCES "SocialPost" ON DELETE CASCADE,"assetId" text,"sortOrder" integer,"altText" text,metadata jsonb);
 CREATE TABLE "PublicApiWebhookSubscription"(id text,"orgId" text,status text,"eventTypes" jsonb);
 CREATE TABLE "PublicApiWebhookDelivery"(id text,"subscriptionId" text,"eventId" text,"eventType" text,payload jsonb,status text,"updatedAt" timestamp,UNIQUE("subscriptionId","eventId"));
 INSERT INTO "PublicApiWebhookSubscription" VALUES('subscription','org','ACTIVE','["content.post.updated"]');
`;
async function fixture(run: (pool: pg.Pool) => Promise<void>) {
 const schema = `published_edit_${randomUUID().replaceAll("-", "")}`;
 const admin = new pg.Pool({ connectionString: process.env.CORE_SOCIAL_TEST_DATABASE_URL });
 await admin.query(`CREATE SCHEMA "${schema}"`);
 const pool = new pg.Pool({ connectionString: process.env.CORE_SOCIAL_TEST_DATABASE_URL, options: `-c search_path=${schema} -c timezone=UTC` });
 try {
  await pool.query(schemaSql);
  await pool.query(`INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","externalAccountId","accessToken",metadata) VALUES('channel','user','org','FACEBOOK','CONNECTED','Page','123',$1,'{"permissions":["pages_manage_posts"],"permissionsInspected":true}')`, [encryptSocialSecret(config, "page-token")]);
  await pool.query(`INSERT INTO "SocialPost" VALUES('post','user','org','channel','Original title',NULL,'Original',ARRAY['FACEBOOK'],'PUBLISHED',NULL,NOW(),'{}',NOW(),NOW());INSERT INTO "SocialPostVariant" VALUES('variant','post','FACEBOOK','Original','APPROVED',false,'{}',NOW(),NOW());INSERT INTO "SocialPublishJob" VALUES('job','user','org','post','variant','channel','FACEBOOK','PUBLISHED',NULL,NOW(),'123_456',NULL,'{}','{"schema":"original","content":"Original"}',NOW(),NOW())`);
  await run(pool);
 } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
}
const opts = { skip: !process.env.CORE_SOCIAL_TEST_DATABASE_URL };
test("published Facebook edits preserve delivery evidence, enforce revision/account/org boundaries and replay once", opts, async () => fixture(async pool => {
 const original = (await getSocialPost(pool, "org", "post"))!;
 const input = { content: " Updated ", expectedUpdatedAt: original.updated_at.toISOString() };
 const calls: string[] = [];
 const transport: typeof fetch = async (url, init) => {
  assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer page-token");
  assert.ok(!String(url).includes("page-token")); calls.push(init?.method ?? "GET");
  if (init?.method === "POST") { assert.equal((init.body as URLSearchParams).get("message"), "Updated"); return Response.json({ success: true }); }
  return Response.json({ id: "123_456", message: "Updated" });
 };
 await assert.rejects(updatePublishedFacebookPost(pool, config, context("foreign", "foreign"), "post", input, { fetch: transport }), /Post not found/);
 await assert.rejects(updatePublishedFacebookPost(pool, config, context(), "post", input, { expectedAccounts: { channel: "stale" }, fetch: transport }), /publishing account changed/);
 assert.equal(calls.length, 0);
 const result = await updatePublishedFacebookPost(pool, config, context(), "post", input, { fetch: transport });
 assert.equal(result.content, "Updated"); assert.equal(result.status, "PUBLISHED"); assert.equal(result.title, "Original title");
 assert.equal(result.publishJobs[0]!.external_post_id, "123_456"); assert.deepEqual(result.publishJobs[0]!.deliverySnapshot, original.publishJobs[0]!.deliverySnapshot);
 assert.equal(result.variants[0]!.content, "Updated"); assert.deepEqual(calls, ["POST", "GET"]);
 await updatePublishedFacebookPost(pool, config, context(), "post", input, { fetch: transport }); assert.equal(calls.length, 2);
 assert.equal((await pool.query('SELECT count(*)::int AS count FROM "PublicApiWebhookDelivery"')).rows[0].count, 1);
 await assert.rejects(updatePublishedFacebookPost(pool, config, context("stale"), "post", input, { fetch: transport }), /reviewed content changed/);
 await assert.rejects(updatePublishedFacebookPost(pool, config, context(), "post", { ...input, content: "Different" }, { fetch: transport }), /another request/);
 await pool.query(`UPDATE "SocialPost" SET channels=ARRAY['FACEBOOK','X'] WHERE id='post'`);
 await assert.rejects(updatePublishedFacebookPost(pool, config, context("mixed"), "post", { ...input, expectedUpdatedAt: result.updated_at.toISOString() }, { fetch: transport }), /Facebook-only/);
}));
test("Facebook photo edits resolve the original Page story, and denied readback stays uncertain until read-only reconciliation", opts, async () => fixture(async pool => {
 await pool.query(`UPDATE "SocialPublishJob" SET "externalPostId"='456' WHERE id='job';INSERT INTO "ContentMediaAsset" VALUES('asset','org','IMAGE','image/png','image.png',1,1,1,NULL,'READY','CLEAN');INSERT INTO "SocialPostMedia" VALUES('media','post','asset',0,'alt','{}')`);
 const original = (await getSocialPost(pool, "org", "post"))!;
 const input = { content: "Photo caption", expectedUpdatedAt: original.updated_at.toISOString() };
 let writes = 0, denied = true;
 const transport: typeof fetch = async (url, init) => {
  if (String(url).includes("page_story_id")) return Response.json({ id: "456", page_story_id: "123_456" });
  if (init?.method === "POST") { writes++; assert.ok(String(url).endsWith("/123_456")); return Response.json({ success: true }); }
  return denied ? Response.json({ error: { message: "No permission" } }, { status: 403 }) : Response.json({ id: "123_456", message: "Photo caption" });
 };
 await assert.rejects(updatePublishedFacebookPost(pool, config, context(), "post", input, { fetch: transport }), /confirmation is unavailable/);
 assert.equal((await getSocialPost(pool, "org", "post"))!.content, "Original");
 await assert.rejects(deleteSocialPost(pool, "org", "post"), /reconciliation/);
 await assert.rejects(deleteSocialPostFromPlatforms(pool, config, "org", "post", { fetch: transport }), /reconciliation/);
 await assert.rejects(updatePublishedFacebookPost(pool, config, context("new-key"), "post", input, { fetch: transport }), /previous update requires reconciliation/);
 denied = false;
 const result = await reconcilePublishedFacebookEdit(pool, config, context(), "post", input, { fetch: transport });
 assert.equal(result.content, "Photo caption"); assert.equal(result.publishJobs[0]!.external_post_id, "456"); assert.equal(writes, 1);
 await assert.rejects(reconcilePublishedFacebookEdit(pool, config, context("never-written"), "post", { ...input, expectedUpdatedAt: result.updated_at.toISOString() }, { fetch: transport }), /no unconfirmed/);
}));
test("retrying a rejected edit reserves executing state before a new provider call", opts, async () => fixture(async pool => {
 const post = (await getSocialPost(pool, "org", "post"))!;
 const input = { content: "Retry text", expectedUpdatedAt: post.updated_at.toISOString() };
 await assert.rejects(updatePublishedFacebookPost(pool, config, context(), "post", input, { fetch: async () => Response.json({ error: { message: "Rejected" } }, { status: 400 }) }), /Rejected/);
 let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
 let called!: () => void; const started = new Promise<void>(resolve => { called = resolve; });
 const retry = updatePublishedFacebookPost(pool, config, context(), "post", input, { fetch: async (_url, init) => {
  if (init?.method === "POST") { called(); await wait; return Response.json({ success: true }); }
  return Response.json({ id: "123_456", message: "Retry text" });
 } });
 await started;
 await assert.rejects(updatePublishedFacebookPost(pool, config, context("competing"), "post", input, { fetch: async () => { throw Error("Must not send"); } }), /previous update requires reconciliation/);
 release(); await retry;
}));

test("photo removal confirms the existing Page story, removes local associations and targets that story for future edits and deletion", opts, async () => fixture(async pool => {
 await pool.query(`UPDATE "SocialPublishJob" SET "externalPostId"='456' WHERE id='job';INSERT INTO "ContentMediaAsset" VALUES('asset','org','IMAGE','image/png','image.png',1,1,1,NULL,'READY','CLEAN');INSERT INTO "SocialPostMedia" VALUES('media','post','asset',0,'alt','{}');INSERT INTO "SocialPostVariantMedia" VALUES('variant-media','variant','asset',0,'alt','{}')`);
 const original = (await getSocialPost(pool, "org", "post"))!;
 let message = "Detached photo", photoReads = 0, writes = 0;
 const urls: string[] = [];
 const transport: typeof fetch = async (url, init) => {
  urls.push(String(url));
  if (String(url).includes("page_story_id")) { photoReads++; return Response.json({ id: "456", page_story_id: "123_456" }); }
  assert.ok(String(url).includes("/123_456"), "every mutation/read after resolution targets the same Page story");
  if (init?.method === "POST") {
   writes++; const body = init.body as URLSearchParams;
   assert.equal(body.get("attached_media"), writes === 1 ? "[]" : null);
   message = body.get("message")!; return Response.json({ success: true });
  }
  if (init?.method === "DELETE") return Response.json({ success: true });
  return Response.json({ id: "123_456", message });
 };
 const result = await updatePublishedFacebookPost(pool, config, context("detach-key"), "post", { content: message, expectedUpdatedAt: original.updated_at.toISOString(), removePhoto: true }, { fetch: transport });
 assert.equal(result.media.length, 0);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM "SocialPostVariantMedia"')).rows[0].n, 0);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM "ContentMediaAsset"')).rows[0].n, 1, "asset is retained");
 assert.equal(result.publishJobs[0]!.external_post_id, "456");
 assert.deepEqual(result.publishJobs[0]!.deliverySnapshot, original.publishJobs[0]!.deliverySnapshot);
 assert.deepEqual((result.publishJobs[0]!.metadata as Record<string, unknown>)._kasitek_facebook_story, { id: "123_456", originalExternalPostId: "456", photoDetached: true });
 await assert.rejects(updatePublishedFacebookPost(pool, config, context("detach-key"), "post", { content: message, expectedUpdatedAt: original.updated_at.toISOString(), removePhoto: false }, { fetch: transport }), /another request/);
 const edited = await updatePublishedFacebookPost(pool, config, context("next-caption"), "post", { content: "After detachment", expectedUpdatedAt: result.updated_at.toISOString() }, { fetch: transport });
 assert.equal(edited.content, "After detachment"); assert.equal(photoReads, 1); assert.equal(writes, 2);
 const deleted = await deleteSocialPostFromPlatforms(pool, config, "org", "post", { fetch: transport });
 assert.equal(deleted.success, true, JSON.stringify(deleted)); assert.equal(deleted.localDeleted, true);
 assert.equal(deleted.providerResults[0]!.externalPostId, "456", "receipt preserves the original photo id");
 assert.ok(urls.some(url => url.endsWith("/123_456")));
}));

test("unconfirmed photo removal keeps local media until read-only reconciliation confirms no attachments", opts, async () => fixture(async pool => {
 await pool.query(`UPDATE "SocialPublishJob" SET "externalPostId"='456' WHERE id='job';INSERT INTO "ContentMediaAsset" VALUES('asset','org','IMAGE','image/png','image.png',1,1,1,NULL,'READY','CLEAN');INSERT INTO "SocialPostMedia" VALUES('media','post','asset',0,'alt','{}');INSERT INTO "SocialPostVariantMedia" VALUES('variant-media','variant','asset',0,'alt','{}')`);
 const original = (await getSocialPost(pool, "org", "post"))!;
 const input = { content: "Detached photo", expectedUpdatedAt: original.updated_at.toISOString(), removePhoto: true };
 let attached = true, writes = 0;
 const transport: typeof fetch = async (url, init) => {
  if (String(url).includes("page_story_id")) return Response.json({ id: "456", page_story_id: "123_456" });
  if (init?.method === "POST") { writes++; return Response.json({ success: true }); }
  return Response.json({ id: "123_456", message: "Detached photo", ...(attached ? { attachments: { data: [{ type: "photo" }] } } : {}) });
 };
 await assert.rejects(updatePublishedFacebookPost(pool, config, context(), "post", input, { fetch: transport }), /confirmation is unavailable/);
 assert.equal((await getSocialPost(pool, "org", "post"))!.media.length, 1);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM "SocialPostVariantMedia"')).rows[0].n, 1);
 attached = false;
 const result = await reconcilePublishedFacebookEdit(pool, config, context(), "post", input, { fetch: transport });
 assert.equal(result.media.length, 0); assert.equal(writes, 1);
}));
test("detached Facebook story identity fails closed on malformed or mismatched receipts", () => {
 assert.equal(facebookPublishedMutationTarget("456", {}), "456");
 assert.equal(facebookPublishedMutationTarget("456", { _kasitek_facebook_story: { id: "123_456", originalExternalPostId: "456", photoDetached: true } }), "123_456");
 for (const marker of ["bad", [], { id: "123_456", originalExternalPostId: "other", photoDetached: true }, { id: "https://example.test", originalExternalPostId: "456", photoDetached: true }, { id: "123_456", originalExternalPostId: "456" }])
  assert.throws(() => facebookPublishedMutationTarget("456", { _kasitek_facebook_story: marker }), /story identity is invalid/);
});
test("photo removal rejects posts without one image before calling Facebook", opts, async () => fixture(async pool => {
 const original = (await getSocialPost(pool, "org", "post"))!;
 let requests = 0;
 await assert.rejects(updatePublishedFacebookPost(pool, config, context(), "post", { content: "Caption", expectedUpdatedAt: original.updated_at.toISOString(), removePhoto: true }, { fetch: async () => { requests++; throw new Error("Must not send"); } }), /one image/);
 assert.equal(requests, 0);
}));

test("Threads published edit execution reports the API limitation without contacting a provider", opts, async () => fixture(async pool => {
 await pool.query(`UPDATE "SocialPost" SET channels=ARRAY['THREADS'] WHERE id='post';UPDATE "SocialPublishJob" SET platform='THREADS' WHERE id='job'`);
 const before = (await getSocialPost(pool, "org", "post"))!;
 let calls = 0;
 await assert.rejects(updatePublishedFacebookPost(pool, config, context("threads-edit"), "post", {content:"Changed",expectedUpdatedAt:before.updated_at.toISOString()}, {fetch:async()=>{calls++;throw Error("Must not contact provider");}}), (error: any) => error.code === "platform_edit_unsupported" && error.message === "The Threads API does not support editing published posts.");
 assert.equal(calls, 0);
 assert.equal((await getSocialPost(pool, "org", "post"))!.content, before.content);
}));
