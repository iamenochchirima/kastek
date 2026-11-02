import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "@kasitek-labs/server-support/json";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { operationDomainKey, reconcileGrowthOperationReceipt } from "../src/operations/reconciliation.js";
import type { OperationReviewRow } from "../src/operations/reviews.js";
import { createSocialPostIdempotent } from "../src/services/social/posts.js";
import { readConfig } from "../src/config.js";

const database = process.env.CORE_SOCIAL_RECOVERY_TEST_DATABASE_URL;
test("lost operation results reconcile only exact durable domain receipts without executing an effect", { skip: !database }, async () => {
  const db = await isolatedDatabase(database!, "operation_receipt_recovery", ["SocialPost", "SocialPostVariant", "SocialPublishJob", "SocialPostMedia", "ContentMediaAsset", "SocialChannelConnection", "SocialPublishBatch", "GrowthMediaTransfer"]);
  try {
    await db.pool.query('ALTER TABLE "SocialPost" ALTER COLUMN channels DROP DEFAULT; ALTER TABLE "SocialPost" ALTER COLUMN channels TYPE "SocialPlatform"[] USING channels::text[]::"SocialPlatform"[]');
    const core = { pool: db.pool, config: readConfig({ DATABASE_URL: database! }) };
    const review = { id: "review", orgId: "org", userId: "user", principalId: "principal", principalKind: "oauth_user", operation: "content.posts.draft.create", state: "uncertain", input: {}, snapshot: {} } as OperationReviewRow;
    const key = operationDomainKey(review.id);
    assert.equal(await reconcileGrowthOperationReceipt(core, review), null);
    await db.pool.query(`INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","updatedAt") VALUES('x','user','org','X','CONNECTED','Fixture',NOW())`);
    const post = await createSocialPostIdempotent(db.pool, "user", "org", { content: "Approved", channels: ["X"], channelSelections: { X: "x" } }, key);
    assert.equal((await reconcileGrowthOperationReceipt(core, review))?.postId, post.id);
    assert.equal(await reconcileGrowthOperationReceipt(core, { ...review, orgId: "other" }), null);
    assert.equal(await reconcileGrowthOperationReceipt(core, { ...review, userId: "other" }), null);
    assert.equal(await reconcileGrowthOperationReceipt(core, { ...review, state: "approved" }), null);
    await db.pool.query(`INSERT INTO "SocialPublishBatch"(id,"userId","orgId","postId",status,"idempotencyKey","snapshotHash","targetCount",metadata,"updatedAt") VALUES('batch','original-author','org',$1,'RUNNING',$2,'exact',1,'{"requestedPlatform":"X"}',now())`, [post.id, key]);
    const publish = { ...review, operation: "content.posts.publish", input: { postId: post.id, platform: "X" }, snapshot: { snapshotHash: "exact" } };
    assert.equal((await reconcileGrowthOperationReceipt(core, publish))?.batchId, "batch");
    assert.equal(await reconcileGrowthOperationReceipt(core, { ...publish, snapshot: { snapshotHash: "changed" } }), null);
    assert.equal(await reconcileGrowthOperationReceipt(core, { ...publish, input: { postId: post.id, platform: "FACEBOOK" } }), null);
    const deletion = { ...review, operation: "content.posts.delete_published", input: { postId: post.id, platform: "X" } };
    for (const state of ["executing", "uncertain", "confirmed"]) {
      await db.pool.query(`UPDATE "SocialPublishJob" SET "externalPostId"='external',metadata=jsonb_build_object('_kasitek_delete_intent',jsonb_build_object('idempotencyKey',$1::text,'actorId','principal','externalPostId','external','state',$2::text)) WHERE id=$3`, [key, state, post.publishJobs[0]!.id]);
      const result = await reconcileGrowthOperationReceipt(core, deletion);
      assert.equal(result?.success ?? null, state === "confirmed" ? true : null);
    }
    assert.equal(await reconcileGrowthOperationReceipt(core, { ...deletion, principalId: "other" }), null);
    const edit = { ...review, operation: "content.posts.update_published", input: { postId: post.id, content: "Corrected caption", expectedUpdatedAt: "2030-01-01T00:00:00.000Z" } };
    const contentDigest = createHash("sha256").update(edit.input.content).digest("hex");
    for (const state of ["executing", "uncertain", "failed", "confirmed"]) {
      await db.pool.query(`UPDATE "SocialPublishJob" SET platform='FACEBOOK',"externalPostId"='external',metadata=jsonb_build_object('_kasitek_edit_intent',jsonb_build_object('idempotencyKey',$1::text,'actorId','principal','externalPostId','external','state',$2::text,'contentDigest',$3::text,'expectedUpdatedAt',$4::text)) WHERE id=$5`, [key, state, contentDigest, edit.input.expectedUpdatedAt, post.publishJobs[0]!.id]);
      const result = await reconcileGrowthOperationReceipt(core, edit);
      assert.equal(result?.receipt ?? null, state === "confirmed" ? "provider_post_updated" : null);
    }
    assert.equal(await reconcileGrowthOperationReceipt(core, { ...edit, principalId: "other" }), null);
    assert.equal(await reconcileGrowthOperationReceipt(core, { ...edit, input: { ...edit.input, content: "Another caption" } }), null);
    assert.equal(await reconcileGrowthOperationReceipt(core, { ...edit, input: { ...edit.input, expectedUpdatedAt: "2030-01-02T00:00:00.000Z" } }), null);
    assert.equal(await reconcileGrowthOperationReceipt(core, { ...edit, input: { ...edit.input, removePhoto: true } }), null);
    await db.pool.query(`UPDATE "SocialPublishJob" SET metadata=jsonb_set(metadata,'{_kasitek_edit_intent,removePhoto}','true') WHERE id=$1`, [post.publishJobs[0]!.id]);
    assert.equal((await reconcileGrowthOperationReceipt(core, { ...edit, input: { ...edit.input, removePhoto: true } }))?.receipt, "provider_post_updated");
    assert.equal(await reconcileGrowthOperationReceipt(core, edit), null);
    const bytes = Buffer.from("exact media"), checksum = createHash("sha256").update(bytes).digest("hex");
    await db.pool.query(`INSERT INTO "ContentMediaAsset"(id,"orgId","uploadedById",kind,"mimeType","byteSize",checksum,"storageKey","processingStatus","scanStatus",metadata,"updatedAt") VALUES('asset','org','user','IMAGE','image/png',$1,$2,'fixture','READY','CLEAN',jsonb_build_object('sourceKey',$3::text),now())`, [bytes.length, checksum, key]);
    const upload = { ...review, operation: "content.media.upload", input: { base64: bytes.toString("base64"), mimeType: "image/png" } };
    assert.equal((await reconcileGrowthOperationReceipt(core, upload))?.assetId, "asset");
    assert.equal(await reconcileGrowthOperationReceipt(core, { ...upload, input: { ...upload.input, base64: Buffer.from("changed").toString("base64") } }), null);
    await db.pool.query(`UPDATE "ContentMediaAsset" SET metadata='{"sourceKey":"growth-transfer:transfer"}' WHERE id='asset'`);
    await db.pool.query(`INSERT INTO "GrowthMediaTransfer"(id,"orgId","userId","principalId","principalKind","requestKey","mimeType","byteSize",checksum,state,"assetId","expiresAt") VALUES('transfer','org','user','principal','oauth_user','prepare','image/png',$1,$2,'FINALIZED','asset',now()+interval '1 hour')`, [bytes.length, checksum]);
    const transfer = { ...review, operation: "content.media.upload", input: { transferId: "transfer" }, snapshot: { transfer: createHash("sha256").update(canonicalJson({ checksum, byteSize: String(bytes.length), state: "READY" })).digest("hex") } };
    assert.equal((await reconcileGrowthOperationReceipt(core, transfer))?.assetId, "asset");
    await db.pool.query(`UPDATE "GrowthMediaTransfer" SET state='READY',"assetId"=NULL WHERE id='transfer'`);
    assert.equal((await reconcileGrowthOperationReceipt(core, transfer))?.receipt, "media_asset_persisted");
    assert.equal((await db.pool.query(`SELECT state,"assetId" FROM "GrowthMediaTransfer" WHERE id='transfer'`)).rows[0].assetId, null);
    assert.equal(await reconcileGrowthOperationReceipt(core, { ...transfer, principalId: "other" }), null);
    assert.equal(await reconcileGrowthOperationReceipt(core, { ...transfer, snapshot: { transfer: "changed" } }), null);
    assert.equal(await reconcileGrowthOperationReceipt(core, { ...review, operation: "inbox.messages.send" }), null);
  } finally { await db.close(); }
});
