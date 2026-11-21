import test from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { installPgTimestampParsers } from "../src/db.js";
import { createSocialPostIdempotent, getSocialPost, updateSocialPost, deleteSocialPost } from "../src/services/social/posts.js";
import { claimPublishJob, changePublishJobState, recoverStalledSocialPublishJobs, deleteSocialPostFromPlatform, executeSocialPublishJob } from "../src/services/social/publishing.js";
import { readConfig } from "../src/config.js";
import { canonicalJson, apiJson } from "@kasitek-labs/server-support/json";
import { createHash, createECDH } from "node:crypto";
import { transaction } from "../src/db.js";
import { stampSocialPublicationAccounts } from "../src/services/social/account-admission.js";
import { encryptSocialSecret } from "../src/integrations/crypto.js";
import { refreshBatchStatus } from "../src/capabilities/content-batch.js";

const database = process.env.CORE_SOCIAL_RECOVERY_TEST_DATABASE_URL;
test("content edits preserve delivery references and stale approvals cannot mutate a newer revision", { skip: !database }, async () => {
  installPgTimestampParsers();
  const db = await isolatedDatabase(database!, "social_state_safety", ["SocialPost", "SocialPostVariant", "SocialPublishJob", "SocialPostMedia", "ContentMediaAsset", "SocialChannelConnection", "SocialPublishBatch", "SocialPublishBatchItem"]);
  try {
    await db.pool.query('ALTER TABLE "SocialPost" ALTER COLUMN channels DROP DEFAULT; ALTER TABLE "SocialPost" ALTER COLUMN channels TYPE "SocialPlatform"[] USING channels::text[]::"SocialPlatform"[]');
    await db.pool.query(`INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","updatedAt") VALUES('x','user','org','X','CONNECTED','Fixture',NOW())`);
    const original = await createSocialPostIdempotent(db.pool, "user", "org", { content: "Original", channels: ["X"], channelSelections: { X: "x" } }, "draft");
    const job = original.publishJobs[0]!;
    await db.pool.query(`INSERT INTO "SocialPublishBatch"(id,"userId","orgId","postId",status,"idempotencyKey","snapshotHash","targetCount","updatedAt") VALUES('blocked','user','org',$1,'BLOCKED','blocked','old-snapshot',1,NOW())`, [original.id]);
    await db.pool.query(`INSERT INTO "SocialPublishBatchItem"(id,"batchId","jobId",platform,status,"updatedAt") VALUES('item','blocked',$1,'X','BLOCKED',NOW())`, [job.id]);
    const changed = await updateSocialPost(db.pool, "user", "org", original.id, { content: "Revised", channelSelections: { X: "x" } }, { expectedPostRevision: original.updated_at.toISOString() });
    assert.equal(changed.publishJobs[0]!.id, job.id);
    assert.equal(changed.publishJobs[0]!.variant_id, job.variant_id);
    assert.equal((await db.pool.query('SELECT "jobId" FROM "SocialPublishBatchItem" WHERE id=\'item\'')).rows[0].jobId, job.id);
    await assert.rejects(updateSocialPost(db.pool, "user", "org", original.id, { content: "Stale", channelSelections: { X: "x" } }, { expectedPostRevision: original.updated_at.toISOString() }), /reviewed content changed/);
    const version=(await db.pool.query('SELECT "agentReviewRevision"::text AS revision FROM "SocialPost" WHERE id=$1',[original.id])).rows[0].revision as string;
    await db.pool.query('UPDATE "SocialPost" SET title=$2 WHERE id=$1',[original.id,"Changed by another writer"]);
    await assert.rejects(updateSocialPost(db.pool,"user","org",original.id,{content:"Stale reviewed content",channelSelections:{X:"x"}},
      {expectedPostRevision:changed.updated_at.toISOString(),expectedPostAgentRevision:version}),/reviewed content changed/);
    const outcomes = await Promise.allSettled([
      claimPublishJob(db.pool, job.id, ["PENDING"]),
      updateSocialPost(db.pool, "user", "org", original.id, { content: "Concurrent edit", channelSelections: { X: "x" } }, { expectedPostRevision: changed.updated_at.toISOString() }),
    ]);
    assert.equal(outcomes[0].status, "fulfilled");
    assert.equal((outcomes[0] as PromiseFulfilledResult<boolean>).value, true);
    const final = (await getSocialPost(db.pool, "org", original.id))!;
    assert.equal(final.publishJobs[0]!.status, "PROCESSING");
    assert.equal(final.publishJobs[0]!.id, job.id);
    if (outcomes[1].status === "rejected") assert.match(String(outcomes[1].reason), /publishing attempt|processing content|changed/);
    await assert.rejects(changePublishJobState(db.pool, "org", job.id, "cancel"), /changed|reconciliation/);
    await db.pool.query(`UPDATE "SocialPublishJob" SET status='PUBLISHED',"externalPostId"='late-confirmed',metadata='{}' WHERE id=$1`, [job.id]);
    await db.pool.query(`UPDATE "SocialPublishBatchItem" SET status='UNKNOWN',"errorCode"='provider_outcome_unknown',"errorMessage"='Old unknown outcome' WHERE id='item'`);
    const confirmed = await refreshBatchStatus(db.pool, "blocked", "org");
    assert.equal(confirmed.status, "SUCCEEDED");
    assert.equal((await getSocialPost(db.pool, "org", original.id))!.status, "PUBLISHED");
    const confirmedRevision = (await getSocialPost(db.pool, "org", original.id))!.updated_at.toISOString();
    await refreshBatchStatus(db.pool, "blocked", "org");
    assert.equal((await getSocialPost(db.pool, "org", original.id))!.updated_at.toISOString(), confirmedRevision);
    const originalPublishedAt = (await getSocialPost(db.pool, "org", original.id))!.published_at?.toISOString();
    await db.pool.query(`UPDATE "SocialPublishJob" SET "externalPostId"=NULL WHERE id=$1`, [job.id]);
    const unconfirmed = await refreshBatchStatus(db.pool, "blocked", "org");
    assert.equal(unconfirmed.status, "UNKNOWN");
    assert.equal(unconfirmed.publishedCount, 0);
    assert.equal((await getSocialPost(db.pool, "org", original.id))!.status, "PROCESSING");
    assert.equal(await claimPublishJob(db.pool, job.id, ["PUBLISHED"]), false);
    let providerCalls = 0;
    await assert.rejects(executeSocialPublishJob(db.pool, job.id, { config: readConfig({ DATABASE_URL: database! }), fetch: async () => { providerCalls++; throw new Error("Must not resend"); } }), /reconcile/);
    assert.equal(providerCalls, 0);
    await assert.rejects(changePublishJobState(db.pool, "org", job.id, "retry"), /reconciliation/);
    await db.pool.query(`UPDATE "SocialPublishJob" SET "externalPostId"='late-confirmed-again' WHERE id=$1`, [job.id]);
    assert.equal((await refreshBatchStatus(db.pool, "blocked", "org")).status, "SUCCEEDED");
    const restored = (await getSocialPost(db.pool, "org", original.id))!;
    assert.equal(restored.status, "PUBLISHED");
    assert.equal(restored.published_at?.toISOString(), originalPublishedAt);
  } finally { await db.close(); }
});

test("reviewed provider deletion captures its target before network and replays its confirmed receipt", { skip: !database }, async () => {
  installPgTimestampParsers();
  const db = await isolatedDatabase(database!, "social_delete_admission", ["SocialPost", "SocialPostVariant", "SocialPublishJob", "SocialPostMedia", "ContentMediaAsset", "SocialChannelConnection"]);
  const config = readConfig({ DATABASE_URL: database!, SOCIAL_TOKEN_ENCRYPTION_KEY: "isolated-deletion-fixture" });
  try {
    await db.pool.query('ALTER TABLE "SocialPost" ALTER COLUMN channels DROP DEFAULT; ALTER TABLE "SocialPost" ALTER COLUMN channels TYPE "SocialPlatform"[] USING channels::text[]::"SocialPlatform"[]');
    await db.pool.query(`INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","externalAccountId","accessToken","updatedAt") VALUES('x','user','org','X','CONNECTED','Fixture','fixture-account',$1,NOW())`, [encryptSocialSecret(config, "synthetic")]);
    const draft = await createSocialPostIdempotent(db.pool, "user", "org", { content: "Published copy", channels: ["X"], channelSelections: { X: "x" } }, "draft");
    await db.pool.query(`UPDATE "SocialPublishJob" SET status='PUBLISHED',"externalPostId"='exact-provider-post' WHERE id=$1`, [draft.publishJobs[0]!.id]);
    const admission = { idempotencyKey: "reviewed-delete", actorId: "user", expectedPostRevision: draft.updated_at.toISOString() };
    let release!: () => void;
    const pause = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const networkStarted = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    const deletion = deleteSocialPostFromPlatform(db.pool, config, "org", draft.id, "X", {
      deleteAdmission: admission,
      fetch: async url => { calls++; assert.match(String(url), /exact-provider-post/); started(); await pause; return new Response("", { status: 404 }); },
    });
    await networkStarted;
    await assert.rejects(deleteSocialPost(db.pool, "org", draft.id), /in progress|reconciliation/);
    const stored = (await getSocialPost(db.pool, "org", draft.id))!;
    const intent = (stored.publishJobs[0]!.metadata as Record<string, unknown>)._kasitek_delete_intent as Record<string, unknown>;
    assert.equal(intent.externalPostId, "exact-provider-post");
    assert.equal(intent.state, "executing");
    release();
    const result = await deletion;
    assert.equal(result.success, true);
    assert.equal(result.localDeleted, false);
    assert.ok(await getSocialPost(db.pool, "org", draft.id));
    const replay = await deleteSocialPostFromPlatform(db.pool, config, "org", draft.id, "X", { deleteAdmission: admission, fetch: async () => { throw new Error("A confirmed deletion must not call the provider twice"); } });
    assert.equal(replay.success, true);
    assert.equal(calls, 1);
  } finally { await db.close(); }
});

test("interrupted publish claims become unknown once and can never be blindly retried", { skip: !database }, async () => {
  installPgTimestampParsers();
  const db = await isolatedDatabase(database!, "social_claim_recovery", ["SocialPost", "SocialPostVariant", "SocialPublishJob", "SocialPostMedia", "ContentMediaAsset", "SocialChannelConnection"]);
  try {
    await db.pool.query('ALTER TABLE "SocialPost" ALTER COLUMN channels DROP DEFAULT; ALTER TABLE "SocialPost" ALTER COLUMN channels TYPE "SocialPlatform"[] USING channels::text[]::"SocialPlatform"[]');
    await db.pool.query(`INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","updatedAt") VALUES('x','user','org','X','CONNECTED','Fixture',NOW())`);
    const post = await createSocialPostIdempotent(db.pool, "user", "org", { content: "Publish", channels: ["X"], channelSelections: { X: "x" } }, "draft");
    const id = post.publishJobs[0]!.id;
    assert.equal(await claimPublishJob(db.pool, id, ["PENDING"]), true);
    assert.equal(await recoverStalledSocialPublishJobs(db.pool, 10), 0);
    await db.pool.query('UPDATE "SocialPublishJob" SET "updatedAt"=NOW()-INTERVAL \'16 minutes\' WHERE id=$1', [id]);
    const recovered = await Promise.all([recoverStalledSocialPublishJobs(db.pool, 10), recoverStalledSocialPublishJobs(db.pool, 10)]);
    assert.equal(recovered.reduce((sum, count) => sum + count, 0), 1);
    const unknown = (await getSocialPost(db.pool, "org", post.id))!;
    assert.equal((unknown.publishJobs[0]!.metadata as Record<string, unknown>)._kasitek_outcome, "UNKNOWN");
    assert.equal(await claimPublishJob(db.pool, id, ["FAILED"]), false);
    await assert.rejects(changePublishJobState(db.pool, "org", id, "retry"), /reconciliation/);
    await assert.rejects(changePublishJobState(db.pool, "org", id, "cancel"), /reconciliation/);
    await db.pool.query(`UPDATE "SocialPublishJob" SET status='PUBLISHED',"externalPostId"='confirmed',metadata='{}' WHERE id=$1`, [id]);
    await assert.rejects(changePublishJobState(db.pool, "org", id, "retry"), /reconciliation/);
    assert.equal((await getSocialPost(db.pool, "org", post.id))!.publishJobs[0]!.external_post_id, "confirmed");
  } finally { await db.close(); }
});


test("delegated queues require fresh review for edits or retries and revoked authority never reaches a provider", { skip: !database }, async () => {
  installPgTimestampParsers();
  const db = await isolatedDatabase(database!, "social_delegated_safety", ["SocialPost", "SocialPostVariant", "SocialPublishJob", "SocialPostMedia", "ContentMediaAsset", "SocialChannelConnection"]);
  try {
    await db.pool.query('ALTER TABLE "SocialPost" ALTER COLUMN channels DROP DEFAULT; ALTER TABLE "SocialPost" ALTER COLUMN channels TYPE "SocialPlatform"[] USING channels::text[]::"SocialPlatform"[]');
    await db.pool.query(`INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","updatedAt") VALUES('x','user','org','X','CONNECTED','Fixture',NOW())`);
    const post = await createSocialPostIdempotent(db.pool, "user", "org", { content: "Approved", channels: ["X"], channelSelections: { X: "x" } }, "draft");
    const id = post.publishJobs[0]!.id;
    await db.pool.query(`UPDATE "SocialPublishJob" SET status='QUEUED',metadata='{"_kasitek_delegation":{"version":0}}' WHERE id=$1`, [id]);
    await assert.rejects(updateSocialPost(db.pool, "user", "org", post.id, { content: "Unreviewed change", channelSelections: { X: "x" } }), /Unschedule this post/);
    assert.equal(await claimPublishJob(db.pool, id, ["QUEUED"]), true);
    let calls = 0;
    await assert.rejects(executeSocialPublishJob(db.pool, id, { config: readConfig({ DATABASE_URL: database! }), fetch: async () => { calls++; throw new Error("Provider must not be reached"); } }), /permission was revoked/);
    assert.equal(calls, 0);
    const failed = (await getSocialPost(db.pool, "org", post.id))!.publishJobs[0]!;
    assert.equal(failed.status, "FAILED");
    assert.notEqual((failed.metadata as Record<string, unknown>)._kasitek_outcome, "UNKNOWN");
    await assert.rejects(changePublishJobState(db.pool, "org", id, "retry"), /Review this post again/);
    await changePublishJobState(db.pool, "org", id, "cancel");
    assert.equal((await getSocialPost(db.pool, "org", post.id))!.publishJobs[0]!.metadata?._kasitek_delegation, undefined);
  } finally { await db.close(); }
});


test("reviewed account changes fence draft writes and queued publication reaches no provider after reconnect", { skip: !database }, async () => {
  installPgTimestampParsers();
  const db = await isolatedDatabase(database!, "social_account_safety", ["SocialPost", "SocialPostVariant", "SocialPublishJob", "SocialPostMedia", "ContentMediaAsset", "SocialChannelConnection"]);
  try {
    await db.pool.query('ALTER TABLE "SocialPost" ALTER COLUMN channels DROP DEFAULT; ALTER TABLE "SocialPost" ALTER COLUMN channels TYPE "SocialPlatform"[] USING channels::text[]::"SocialPlatform"[]');
    const config = readConfig({ DATABASE_URL: database!, SOCIAL_TOKEN_ENCRYPTION_KEY: "fixture" });
    await db.pool.query(`INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","externalAccountId","updatedAt") VALUES('x','user','org','X','CONNECTED','Fixture','approved-account',NOW())`);
    const account = (await db.pool.query('SELECT id,status::text,"updatedAt","agentReviewRevision"::text AS "agentReviewRevision" FROM "SocialChannelConnection" WHERE id=\'x\'')).rows[0];
    const expectedAccounts = { x: createHash("sha256").update(canonicalJson(JSON.parse(apiJson(account)))).digest("hex") };
    const post = await createSocialPostIdempotent(db.pool, "user", "org", { content: "Approved", channels: ["X"], channelSelections: { X: "x" } }, "draft", { expectedAccounts });
    const id = post.publishJobs[0]!.id;
    await transaction(db.pool, async tx => {
      await tx.query(`UPDATE "SocialPublishJob" SET status='QUEUED' WHERE id=$1`, [id]);
      await stampSocialPublicationAccounts(tx, "org", post.id);
    });
    const rotationPost = await createSocialPostIdempotent(db.pool, "user", "org", { content: "Token rotation", channels: ["X"], channelSelections: { X: "x" } }, "rotation");
    const rotationJob = rotationPost.publishJobs[0]!.id;
    await transaction(db.pool, async tx => {
      await tx.query(`UPDATE "SocialPublishJob" SET status='QUEUED' WHERE id=$1`, [rotationJob]);
      await stampSocialPublicationAccounts(tx, "org", rotationPost.id);
    });
    await db.pool.query(`UPDATE "SocialChannelConnection" SET "accessToken"=$1,"refreshToken"=$1,"updatedAt"=now()+interval '1 second' WHERE id='x'`, [encryptSocialSecret(config, "rotated-token")]);
    assert.equal(await claimPublishJob(db.pool, rotationJob, ["QUEUED"]), true);
    let calls = 0;
    const published = await executeSocialPublishJob(db.pool, rotationJob, { config, fetch: async (_url, init) => {
      calls++; assert.equal(new Headers(init?.headers).get("authorization"), "Bearer rotated-token");
      return new Response(JSON.stringify({ data: { id: "rotated-publication" } }));
    } });
    assert.equal(published.status, "PUBLISHED");
    assert.equal(published.externalPostId, "rotated-publication");
    assert.equal(calls, 1);
    await db.pool.query(`UPDATE "SocialChannelConnection" SET "externalAccountId"='reconnected-account' ,"updatedAt"=NOW() WHERE id='x'`);
    await assert.rejects(updateSocialPost(db.pool, "user", "org", post.id, { content: "Changed", channelSelections: { X: "x" } }, { expectedAccounts }), /publishing account changed/);
    await assert.rejects(createSocialPostIdempotent(db.pool, "user", "org", { content: "New", channels: ["X"], channelSelections: { X: "x" } }, "new", { expectedAccounts }), /publishing account changed/);
    assert.equal(await claimPublishJob(db.pool, id, ["QUEUED"]), true);
    await assert.rejects(executeSocialPublishJob(db.pool, id, { config, fetch: async () => { calls++; throw new Error("Provider must not be reached"); } }), /publishing account changed/);
    assert.equal(calls, 1);
    const failed = (await getSocialPost(db.pool, "org", post.id))!.publishJobs[0]!;
    assert.equal(failed.status, "FAILED");
    assert.notEqual((failed.metadata as Record<string, unknown>)._kasitek_outcome, "UNKNOWN");
    await assert.rejects(changePublishJobState(db.pool, "org", id, "retry", { expectedAccounts, delegation: null, actorUserId: "user" }), /publishing account changed/);
    const reconnected = (await db.pool.query('SELECT id,status::text,"updatedAt","agentReviewRevision"::text AS "agentReviewRevision" FROM "SocialChannelConnection" WHERE id=\'x\'')).rows[0];
    const freshAccounts = { x: createHash("sha256").update(canonicalJson(JSON.parse(apiJson(reconnected)))).digest("hex") };
    await changePublishJobState(db.pool, "org", id, "retry", { expectedAccounts: freshAccounts, delegation: null, actorUserId: "user" });
    const fresh = (await getSocialPost(db.pool, "org", post.id))!.publishJobs[0]!;
    assert.equal((fresh.metadata?._kasitek_account as Record<string, unknown>).externalAccountId, "reconnected-account");
    assert.equal(await claimPublishJob(db.pool, id, ["QUEUED"]), true);
    const reviewedRetry = await executeSocialPublishJob(db.pool, id, { config, fetch: async () => { calls++; return new Response(JSON.stringify({ data: { id: "fresh-review-publication" } })); } });
    assert.equal(reviewedRetry.status, "PUBLISHED");
    assert.equal(calls, 2);
  } finally { await db.close(); }
});


test("unreadable publication confirmations and Bluesky lost responses become unknown and cannot be retried", { skip: !database }, async () => {
  installPgTimestampParsers();
  const db = await isolatedDatabase(database!, "social_provider_unknown", ["SocialPost", "SocialPostVariant", "SocialPublishJob", "SocialPostMedia", "ContentMediaAsset", "SocialChannelConnection"]);
  try {
    await db.pool.query('ALTER TABLE "SocialPost" ALTER COLUMN channels DROP DEFAULT; ALTER TABLE "SocialPost" ALTER COLUMN channels TYPE "SocialPlatform"[] USING channels::text[]::"SocialPlatform"[]');
    const key = createECDH("prime256v1"); key.generateKeys();
    const encodedKey = key.getPrivateKey().toString("base64url");
    const config = readConfig({ DATABASE_URL: database!, SOCIAL_TOKEN_ENCRYPTION_KEY: "fixture", AUTH_BLUESKY_OAUTH_CLIENT_PRIVATE_KEY: encodedKey });
    await db.pool.query(`INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","accessToken","refreshToken","externalAccountId",metadata,"updatedAt") VALUES('x','user','org','X','CONNECTED','Fixture',$1,$1,'account','{}',now()),('bluesky','user','org','BLUESKY','CONNECTED','Fixture',$1,$1,'did:plc:fixture',$2,now())`, [encryptSocialSecret(config, "synthetic-token"), JSON.stringify({ authMethod: "oauth", pds: "https://pds.example.test", authorizationServer: "https://auth.example.test", dpopPrivateKey: encryptSocialSecret(config, encodedKey) })]);
    for (const scenario of ["malformed", "missing-id", "bluesky-lost-response"]) {
      const platform = scenario === "bluesky-lost-response" ? "BLUESKY" : "X", account = platform === "X" ? "x" : "bluesky";
      const post = await createSocialPostIdempotent(db.pool, "user", "org", { content: "Approved", channels: [platform], channelSelections: { [platform]: account } }, scenario);
      const id = post.publishJobs[0]!.id;
      assert.equal(await claimPublishJob(db.pool, id, ["PENDING"]), true);
      let writes = 0;
      await assert.rejects(executeSocialPublishJob(db.pool, id, {
        config,
        fetch: async () => { writes++; return new Response(scenario === "malformed" ? "not-json" : "{}", { status: 200 }); },
        blueskyTransport: {
          lookup: async () => [{ address: "8.8.8.8", family: 4 }],
          fetch: async url => {
            if (String(url).endsWith("/.well-known/oauth-authorization-server")) return new Response(JSON.stringify({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", pushed_authorization_request_endpoint: "https://auth.example.test/par" }));
            if (String(url).endsWith("/token")) return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", sub: "did:plc:fixture", expires_in: 3600 }));
            assert(String(url).endsWith("/xrpc/com.atproto.repo.createRecord"));
            writes++; throw new Error("Connection closed after provider accepted request");
          },
        },
      }), { status: 502 });
      assert.equal(writes, 1);
      const unknown = (await getSocialPost(db.pool, "org", post.id))!;
      assert.equal((unknown.publishJobs[0]!.metadata as Record<string, unknown>)._kasitek_outcome, "UNKNOWN");
      assert.equal(unknown.status, "PROCESSING");
      await assert.rejects(changePublishJobState(db.pool, "org", id, "retry"), /reconciliation/);
      assert.equal(await claimPublishJob(db.pool, id, ["FAILED"]), false);
    }
  } finally { await db.close(); }
});
