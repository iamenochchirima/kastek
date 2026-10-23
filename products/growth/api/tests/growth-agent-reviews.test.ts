import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { parseGrowthAgentAction, type GrowthAgentAction, type GrowthDraftProposal } from "@kasitek-labs/contracts";
import { readConfig } from "../src/config.js";
import { installPgTimestampParsers } from "../src/db.js";
import { GrowthAgentReviewStore } from "../src/agents/reviews.js";
import { createSocialPostIdempotent } from "../src/services/social/posts.js";
import { growthAgentSocialFixture } from "./growth-agent-fixture.js";
const actor = { issuer: "https://growth.kasitek.co.za/identity", subject: "user" };
function action<K extends GrowthAgentAction["operation"]>(operation: K, input: unknown, extra: Record<string, unknown> = {}): GrowthAgentAction<K> {
  return parseGrowthAgentAction({ version: "1", requestId: randomUUID(), operationId: randomUUID(), tenantId: "org", actor,
    taskId: "task", conversationId: "conversation", featureId: "content", context: null, operation, input, ...extra }) as GrowthAgentAction<K>;
}
test("Growth exact draft review saves real records and reconciles lost replies under current actor/account authority", { skip: !process.env.GROWTH_AGENT_TEST_DATABASE_URL }, async () => {
  const connectionString = process.env.GROWTH_AGENT_TEST_DATABASE_URL!;
  const target = new URL(connectionString);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  assert.match(target.pathname, /^\/growth_agents_verification_[a-f0-9]+$/);
  installPgTimestampParsers();
  const schema = `growth_agent_test_${randomUUID().replaceAll("-", "")}`, admin = new pg.Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema} -c timezone=UTC` });
  try {
    await pool.query(`CREATE TABLE "User"(id text PRIMARY KEY,"emailVerified" timestamptz);
      CREATE TABLE "Organization"(id text PRIMARY KEY,name text,"reportingTimezone" text,"updatedAt" timestamptz DEFAULT now());
      CREATE TABLE "OrganizationMember"("orgId" text,"userId" text,role text);
      CREATE TABLE "OrganizationOnboardingProfile"("orgId" text,website text,industry text,"primaryGoal" text,"primaryGoals" text[]);
      INSERT INTO "User" VALUES('user',now()),('other',now());
      INSERT INTO "Organization" VALUES('org','Business','UTC',now()),('foreign-org','Foreign','UTC',now());
      INSERT INTO "OrganizationMember" VALUES('org','user','OWNER'),('foreign-org','other','OWNER');`);
    await pool.query(growthAgentSocialFixture);
    await pool.query(await readFile(new URL("../../database/prisma/migrations/20261023010000_growth_agent_reviews/migration.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../database/prisma/migrations/20260829180000_add_core_analytics_outbox/migration.sql", import.meta.url), "utf8"));
    const core = { config: readConfig({ DATABASE_URL: "postgres://unused" }), pool }, scope = { tenantId: "org", actor }, store = new GrowthAgentReviewStore(core);
    const draft: GrowthDraftProposal = { title: "Draft", content: "An approved post", channels: [], channelSelections: {} };
    const prepare = action("draft.prepare", { draft }), first = (await store.prepare(prepare)).review;
    await assert.rejects(store.decide(scope, first.id, { requestId: "no-account", payloadDigest: first.payloadDigest, decision: "approve" }), /Choose a connected account/);
    const selected = { ...draft, channels: ["FACEBOOK"], channelSelections: { FACEBOOK: "channel" } };
    const revised = (await store.revise(scope, "task", first.id, { requestId: "edit-one", payloadDigest: first.payloadDigest, draft: selected })).review;
    assert.notEqual(revised.id, first.id); assert.notEqual(revised.payloadDigest, first.payloadDigest);
    assert.equal((await store.prepare(prepare)).review.id, revised.id);
    await assert.rejects(store.prepare({ ...prepare, input: { draft: { ...draft, content: "changed" } } }), /reused for a different proposal/);
    await assert.rejects(store.decide(scope, first.id, { requestId: "stale", payloadDigest: first.payloadDigest, decision: "approve" }), /changed/);
    await assert.rejects(store.revise(scope, "task", revised.id, { requestId: "foreign", payloadDigest: revised.payloadDigest, draft: { ...selected, channelSelections: { FACEBOOK: "foreign-channel" } } }), /unavailable/);
    const approved = (await store.decide(scope, revised.id, { requestId: "approve-one", payloadDigest: revised.payloadDigest, decision: "approve" })).review;
    const commit = action("draft.commit", { reviewId: approved.id, payloadDigest: approved.payloadDigest });
    const [saved, replay] = await Promise.all([store.commit(commit), store.commit(commit)]);
    assert.equal(saved.result?.recordId, replay.result?.recordId); assert.equal(saved.result?.actorId, "user");
    const rows = (await pool.query('SELECT id,"userId",status::text FROM "SocialPost"')).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].userId, "user"); assert.equal(rows[0].status, "DRAFT");
    assert.equal((await store.reconcile(action("draft.reconcile", { reviewId: first.id }))).result?.recordId, saved.result?.recordId);
    assert.deepEqual(await store.list({ tenantId: "foreign-org", actor: { ...actor, subject: "other" } }, "task"), []);
    const lost = new GrowthAgentReviewStore(core, { create: async (...args) => { await createSocialPostIdempotent(...args); throw new Error("lost acknowledgement"); } });
    const pending = (await lost.prepare(action("draft.prepare", { draft: selected }, { operationId: "lost-ack" }))).review;
    await lost.decide(scope, pending.id, { requestId: "approve-two", payloadDigest: pending.payloadDigest, decision: "approve" });
    assert.equal((await lost.commit(action("draft.commit", { reviewId: pending.id, payloadDigest: pending.payloadDigest }))).review.state, "uncertain");
    assert.equal((await lost.reconcile(action("draft.reconcile", { reviewId: pending.id }))).review.state, "saved");
    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM "SocialPost"')).rows[0].count), 2);
    const interrupted = (await store.prepare(action("draft.prepare", { draft: selected }, { operationId: "outer-rollback" }))).review;
    await store.decide(scope, interrupted.id, { requestId: "approve-interrupted", payloadDigest: interrupted.payloadDigest, decision: "approve" });
    const notSaved = await store.reconcile(action("draft.reconcile", { reviewId: interrupted.id }));
    assert.equal(notSaved.review.state, "approved"); assert.equal(notSaved.result, null);
    const committedPost = await createSocialPostIdempotent(pool, "user", "org", {
      ...selected, status: "DRAFT", primaryChannelId: "channel",
      metadata: { growthAgentReviewId: interrupted.id, growthAgentPayloadDigest: interrupted.payloadDigest, growthAgentTaskId: "task" },
    }, `growth-agent-draft:${interrupted.id}`);
    // The domain save survived while the outer review transaction rolled back and its approval expired.
    await pool.query(`UPDATE "GrowthAgentReview" SET "expiresAt"=now()-interval '1 minute' WHERE id=$1`, [interrupted.id]);
    let creates = 0;
    const recovery = new GrowthAgentReviewStore(core, { create: async () => { creates++; throw new Error("Recovery must not create"); } });
    const recovered = await recovery.commit(action("draft.commit", { reviewId: interrupted.id, payloadDigest: interrupted.payloadDigest }));
    assert.equal(recovered.review.state, "saved"); assert.equal(recovered.result?.recordId, committedPost.id); assert.equal(creates, 0);
    await pool.query(`UPDATE "GrowthAgentReview" SET state='approved',result=NULL WHERE id=$1`, [interrupted.id]);
    const reconciled = await recovery.reconcile(action("draft.reconcile", { reviewId: interrupted.id }));
    assert.equal(reconciled.review.state, "saved"); assert.equal(reconciled.result?.recordId, committedPost.id); assert.equal(creates, 0);
    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM "SocialPost"')).rows[0].count), 3);
    const facts = (await pool.query("SELECT contract_name,envelope FROM analytics_outbox WHERE source_domain='growth_agents'")).rows;
    assert.equal(facts.filter(fact => fact.contract_name === "growth.agent.draft_saved@1").length, 3);
    assert.equal(facts.filter(fact => fact.contract_name === "growth.agent.review@1" && fact.envelope.data.action === "approved").length, 3);
    assert.equal(facts.some(fact => JSON.stringify(fact.envelope.data).includes("An approved post")), false);
    assert.equal(facts.some(fact => Object.hasOwn(fact.envelope.data, "installation_id") || Object.hasOwn(fact.envelope.data, "actor_id")), false);
    const beforeRollback = Number((await pool.query('SELECT COUNT(*) FROM "GrowthAgentReview"')).rows[0].count);
    await pool.query(`CREATE FUNCTION reject_fixture_review_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture analytics unavailable'; END $$;
      CREATE TRIGGER reject_fixture_review_fact BEFORE INSERT ON analytics_outbox FOR EACH ROW EXECUTE FUNCTION reject_fixture_review_fact()`);
    await assert.rejects(store.prepare(action("draft.prepare", { draft: selected }, { operationId: "outbox-rollback" })), /fixture analytics unavailable/);
    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM "GrowthAgentReview"')).rows[0].count), beforeRollback);
    await pool.query('DROP TRIGGER reject_fixture_review_fact ON analytics_outbox');
    const stale = (await store.prepare(action("draft.prepare", { draft: selected }, { operationId: "stale-account" }))).review;
    await pool.query(`UPDATE "SocialChannelConnection" SET "updatedAt"=now()+interval '1 second' WHERE id='channel'`);
    await assert.rejects(store.decide(scope, stale.id, { requestId: "stale-account", payloadDigest: stale.payloadDigest, decision: "approve" }), /account changed/);
    const revoked = (await store.prepare(action("draft.prepare", { draft: selected }, { operationId: "revoked" }))).review;
    await store.decide(scope, revoked.id, { requestId: "approve-revoked", payloadDigest: revoked.payloadDigest, decision: "approve" });
    await pool.query('DELETE FROM "OrganizationMember" WHERE "orgId"=$1 AND "userId"=$2', ["org", "user"]);
    await assert.rejects(store.commit(action("draft.commit", { reviewId: revoked.id, payloadDigest: revoked.payloadDigest })), /access is unavailable/);
    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM "SocialPost"')).rows[0].count), 3);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});
