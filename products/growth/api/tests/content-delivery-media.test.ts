import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { contentLibraryFixture } from "./helpers/content-library-fixture.js";
import { resolveDeliveryMedia } from "../src/services/social/delivery-media.js";
import { loadPublishJob } from "../src/services/social/publishing.js";
import { createSocialPostIdempotent } from "../src/services/social/posts.js";
import { storagePath, uploadContentMediaBytes } from "../src/services/social/media.js";
import { contentActionSnapshot } from "../src/operations/content-preview.js";
import { preflightInternal } from "../src/capabilities/content-batch.js";
import type { RequestContext } from "../src/identity/request-context.js";

test("delivery selections distinguish legacy fallback, exact empty selection and malformed authority", () => {
  const common = [{ assetId: "one", altText: "Common one", sortOrder: 0 }, { assetId: "two", altText: "Common two", sortOrder: 1 }];
  const job = { platform: "FACEBOOK", status: "PENDING" };
  const snapshot = (media: unknown) => ({ ...job, deliverySnapshot: { schema: "kasitek-content-delivery-v1", platform: "FACEBOOK", media } });
  assert.deepEqual(resolveDeliveryMedia(job, common), common);
  assert.deepEqual(resolveDeliveryMedia({ ...job, deliverySnapshot: { schema: "legacy", media: [] } }, common), common);
  assert.deepEqual(resolveDeliveryMedia(snapshot([]), common), []);
  assert.deepEqual(resolveDeliveryMedia(snapshot([{ assetId: "two", altText: "Selected", sortOrder: 0 }]), common), [{ assetId: "two", altText: "Selected", sortOrder: 0 }]);
  assert.throws(() => resolveDeliveryMedia(snapshot([{ assetId: "foreign" }]), common), /unavailable/);
  assert.throws(() => resolveDeliveryMedia(snapshot([{ assetId: "one" }, { assetId: "one" }]), common), /unavailable/);
  assert.throws(() => resolveDeliveryMedia(snapshot(null), common), /unavailable/);
  assert.deepEqual(resolveDeliveryMedia({ ...snapshot([{ assetId: "purged-historical-photo" }]), status: "PUBLISHED" }, []), []);
});

const database = process.env.CORE_OPERATIONS_TEST_DATABASE_URL ?? process.env.CORE_SOCIAL_TEST_DATABASE_URL;
test("preflight and publish loading use identical authorized platform media selections without provider calls", { skip: !database, timeout: 60000 }, async () => {
  const fixture = await contentLibraryFixture(database!);
  const { pool } = fixture;
  const ctx = { organizationId: "library-org", userId: "library-user" } as RequestContext;
  try {
    const key = (await pool.query('SELECT "storageKey" FROM "ContentMediaAsset" WHERE id=$1', [fixture.asset.id])).rows[0].storageKey;
    const second = await uploadContentMediaBytes(pool, fixture.config, "library-user", "library-org", { bytes: await readFile(storagePath(fixture.config, key)), mimeType: "image/png", source: "delivery-fixture" });
    await pool.query(`INSERT INTO "ExternalConnection"(id,"orgId",provider,"sourceType","sourceId","displayName",status,"updatedAt") VALUES('delivery-connection','library-org','FACEBOOK','SOCIAL','fixture-facebook','Fixture Page','CONNECTED',now());
      INSERT INTO "ExternalConnectionPermission"(id,"connectionId",key,state,"updatedAt") VALUES('delivery-social','delivery-connection','SOCIAL_PUBLISH','GRANTED',now()),('delivery-media','delivery-connection','MEDIA_PUBLISH','GRANTED',now());`);
    const post = await createSocialPostIdempotent(pool, "library-user", "library-org", { content: "Selected delivery", channels: ["FACEBOOK"], channelSelections: { FACEBOOK: "fixture-facebook" }, media: [{ assetId: fixture.asset.id }, { assetId: second.id }] }, "delivery-two-common", { reusableVariantMedia: [{ platform: "FACEBOOK", media: [{ assetId: second.id, altText: "Platform alt" }] }] });
    const job = post.publishJobs[0]!;
    const selected = await loadPublishJob(pool, job.id);
    assert.deepEqual(selected?.media.map(item => item.assetId), [second.id]);
    assert.equal(selected?.media[0]?.altText, "Platform alt");
    const preflight = await preflightInternal(pool, ctx, post.id, { syncConnections: false });
    assert.equal(preflight.mediaCount, 2);
    assert.equal(preflight.targets[0]?.state, "READY");
    assert.equal(preflight.targets[0]?.requiredCapability, "MEDIA_PUBLISH");
    const firstHash = preflight.snapshotHash;
    const preview = JSON.parse((await contentActionSnapshot(fixture,ctx,{postId:post.id,platform:"FACEBOOK"},"content.posts.publish")).preview!);
    assert.equal(preview.media.length,1);
    assert.equal(preview.targets[0].media[0].assetId,second.id);

    await pool.query(`UPDATE "SocialPublishJob" SET "deliverySnapshot"='{"schema":"kasitek-content-delivery-v1","platform":"FACEBOOK","media":[]}' WHERE id=$1`, [job.id]);
    assert.deepEqual((await loadPublishJob(pool, job.id))?.media, []);
    const textOnly = await preflightInternal(pool, ctx, post.id, { syncConnections: false });
    assert.equal(textOnly.targets[0]?.state, "READY");
    assert.equal(textOnly.targets[0]?.requiredCapability, "SOCIAL_PUBLISH");
    assert.notEqual(textOnly.snapshotHash, firstHash);
    const textPreview = JSON.parse((await contentActionSnapshot(fixture,ctx,{postId:post.id,platform:"FACEBOOK"},"content.posts.publish")).preview!);
    assert.deepEqual(textPreview.media,[]);
    assert.deepEqual(textPreview.targets[0].media,[]);
    assert.equal(textPreview.accounts[0].requiredCapability,"SOCIAL_PUBLISH");
    for (const assetId of [fixture.foreignAsset.id, "missing-asset"]) {
      await pool.query(`UPDATE "SocialPublishJob" SET "deliverySnapshot"=jsonb_build_object('schema','kasitek-content-delivery-v1','platform','FACEBOOK','media',jsonb_build_array(jsonb_build_object('assetId',$2::text))) WHERE id=$1`, [job.id, assetId]);
      await assert.rejects(loadPublishJob(pool, job.id), (error: unknown) => (error as { code?: string }).code === "delivery_media_invalid");
      const invalid = await preflightInternal(pool, ctx, post.id, { syncConnections: false });
      assert.equal(invalid.targets[0]?.state, "INVALID_MEDIA");
      assert.equal(invalid.targets[0]?.reasonCode, "delivery_media_invalid");
    }
    await pool.query(`UPDATE "SocialPublishJob" SET status='PUBLISHED',"externalPostId"='already-published' WHERE id=$1;`, [job.id]);
    await pool.query('DELETE FROM "SocialPostMedia" WHERE "postId"=$1', [post.id]);
    assert.deepEqual((await loadPublishJob(pool, job.id))?.media, []);
    assert.equal((await preflightInternal(pool, ctx, post.id, { syncConnections: false })).targets[0]?.state, "ALREADY_PUBLISHED");
  } finally { await fixture.close(); }
});
