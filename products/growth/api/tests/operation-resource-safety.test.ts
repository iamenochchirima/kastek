import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { installPgTimestampParsers } from "../src/db.js";
import { readConfig } from "../src/config.js";
import { invokeGrowthOperation } from "../src/operations/dispatch.js";
import type { RequestContext } from "../src/identity/request-context.js";
import { boundedGrowthOperationResult, operationReviewState, executeGrowthOperation, decideOperationReview, type OperationReviewRow } from "../src/operations/reviews.js";

test("approved and proposed review expiry agree across projections without expiring completed receipts", () => {
  const expired = { expiresAt: new Date(Date.now() - 1000) };
  for (const state of ["proposed", "approved"]) assert.equal(operationReviewState({ ...expired, state } as OperationReviewRow), "expired");
  for (const state of ["succeeded", "failed", "uncertain", "rejected"]) assert.equal(operationReviewState({ ...expired, state } as OperationReviewRow), state);
  assert.equal(operationReviewState({ state: "approved", expiresAt: new Date(Date.now() + 60000) } as OperationReviewRow), "approved");
});

test("bounded observations reconstruct exact Unicode results and reject changed continuations", () => {
  const value = { state: "succeeded", result: { text: "🌍 customer copy ".repeat(2000) } };
  let cursor: string | undefined, joined = "";
  do {
    const page = boundedGrowthOperationResult(value, cursor) as { result: { chunk: string; continuation: string | null } };
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    joined += page.result.chunk;
    cursor = page.result.continuation ?? undefined;
  } while (cursor);
  assert.deepEqual(JSON.parse(joined), value);
  const first = boundedGrowthOperationResult(value) as { result: { continuation: string } };
  assert.throws(() => boundedGrowthOperationResult({ ...value, state: "changed" }, first.result.continuation), /result changed/);
});

const database = process.env.CORE_OPERATIONS_TEST_DATABASE_URL;
test("reviewed Inbox and connection changes reject a concurrently changed resource before effects", { skip: !database }, async () => {
  installPgTimestampParsers();
  const fixture = await isolatedDatabase(database!, "operation_resources", ["User", "Organization", "OrganizationMember", "Conversation", "ExternalConnection"]);
  const { pool } = fixture;
  try {
    await pool.query(`INSERT INTO "User"(id,email,"createdAt","updatedAt") VALUES('owner','owner@example.test',now(),now());
      INSERT INTO "Organization"(id,name,slug,"ownerId","createdAt","updatedAt") VALUES('org','Business','resource-fixture','owner',now(),now());
      INSERT INTO "OrganizationMember"(id,"orgId","userId",role,"updatedAt") VALUES('member','org','owner','OWNER',now());
      INSERT INTO "Conversation"(id,"orgId",channel,"customerIdentifier","updatedAt") VALUES('conversation','org','email','immutable-recipient','2030-01-01T00:00:00.001');
      INSERT INTO "ExternalConnection"(id,"orgId",provider,"displayName","sourceType","sourceId",status,"updatedAt") VALUES('connection','org','EMAIL','Mailbox','EMAIL','email-source','CONNECTED','2030-01-01T00:00:00.002');`);
    const context: RequestContext = { principal: { kind: "direct_user", id: "owner", subjectUserId: "owner" }, userId: "owner", organizationId: "org", clientId: null, apiScopes: null, effectiveGrants: new Set(), correlationId: null, causationId: null, idempotencyKey: "resource-review-fixture" };
    const core = { pool, config: readConfig({ DATABASE_URL: database! }) };
    const stale = { expectedResourceRevisions: { conversationId: "2030-01-01T00:00:00Z", connectionId: "2030-01-01T00:00:00Z" } };
    for (const [operation,input] of [
      ["inbox.conversations.update", { conversationId: "conversation", starred: true }],
      ["inbox.conversations.mark_read", { conversationId: "conversation" }],
      ["inbox.messages.send", { conversationId: "conversation", text: "Exact reviewed message" }],
      ["connections.status.update", { connectionId: "connection", status: "REVOKED" }],
    ] as const) await assert.rejects(invokeGrowthOperation(core, context, operation, input, stale), /changed/);
    assert.equal((await pool.query('SELECT starred FROM "Conversation" WHERE id=\'conversation\'')).rows[0].starred, false);
    await invokeGrowthOperation(core, context, "inbox.conversations.update", { conversationId: "conversation", starred: true }, { expectedResourceRevisions: { conversationId: "2030-01-01T00:00:00.001Z" } });
    assert.equal((await pool.query('SELECT starred FROM "Conversation" WHERE id=\'conversation\'')).rows[0].starred, true);
  } finally { await fixture.close(); }
});

test("two reviewed conversation writes cannot reuse a millisecond timestamp revision", { skip: !database }, async () => {
  installPgTimestampParsers();
  const fixture = await isolatedDatabase(database!, "operation_race", ["User", "Organization", "OrganizationMember", "Conversation"]);
  const {pool}=fixture,first=await pool.connect(),second=await pool.connect();
  try {
    await pool.query(`INSERT INTO "User"(id,email,"createdAt","updatedAt") VALUES('owner','owner@example.test',now(),now());
      INSERT INTO "Organization"(id,name,slug,"ownerId","createdAt","updatedAt") VALUES('org','Business','race-fixture','owner',now(),now());
      INSERT INTO "OrganizationMember"(id,"orgId","userId",role,"updatedAt") VALUES('member','org','owner','OWNER',now())`);
    await first.query("BEGIN");await second.query("BEGIN");
    const initial=(await first.query('SELECT NOW()::timestamp(3) AS revision')).rows[0].revision as Date;
    await pool.query('INSERT INTO "Conversation"(id,"orgId",channel,"customerIdentifier","updatedAt") VALUES($1,$2,$3,$4,$5)',["conversation","org","email","recipient",initial]);
    const context:RequestContext={principal:{kind:"direct_user",id:"owner",subjectUserId:"owner"},userId:"owner",organizationId:"org",clientId:null,apiScopes:null,effectiveGrants:new Set(),correlationId:null,causationId:null,idempotencyKey:"concurrent-review"};
    const config=readConfig({DATABASE_URL:database!}),options={expectedResourceRevisions:{conversationId:initial.toISOString(),conversationIdAgentRevision:"1"}};
    const firstResult=await invokeGrowthOperation({pool:first as unknown as typeof pool,config},context,"inbox.conversations.update",{conversationId:"conversation",starred:true},options) as {conversation:Record<string,unknown>};
    assert.equal(firstResult.conversation.starred,true);assert.equal("agentReviewRevision" in firstResult.conversation,false);
    const afterFirst=(await first.query('SELECT "updatedAt","agentReviewRevision"::text AS revision FROM "Conversation" WHERE id=$1',["conversation"])).rows[0];
    assert.equal(afterFirst.updatedAt.toISOString(),initial.toISOString());assert.equal(afterFirst.revision,"2");
    const pid=(await second.query('SELECT pg_backend_pid() AS id')).rows[0].id as number;
    const later=invokeGrowthOperation({pool:second as unknown as typeof pool,config},context,"inbox.conversations.update",{conversationId:"conversation",starred:false},options)
      .then(value=>({value}),error=>({error}));
    let waiting=false;
    for(let i=0;i<100&&!waiting;i++){
      waiting=Boolean((await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[pid])).rowCount);
      if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true,"second reviewed write must wait for the first row lock");
    await first.query("COMMIT");
    const rejected=await later;assert.ok("error" in rejected);assert.equal((rejected.error as {code:string}).code,"operation_review_conflict");
    await second.query("ROLLBACK");
    const beforeOrdinary=(await pool.query('SELECT "updatedAt","agentReviewRevision"::text AS revision FROM "Conversation" WHERE id=$1',["conversation"])).rows[0];
    await pool.query('UPDATE "Conversation" SET starred=false WHERE id=$1',["conversation"]);
    await assert.rejects(invokeGrowthOperation({pool,config},context,"inbox.conversations.update",{conversationId:"conversation",starred:true},
      {expectedResourceRevisions:{conversationId:beforeOrdinary.updatedAt.toISOString(),conversationIdAgentRevision:beforeOrdinary.revision}}),{code:"operation_review_conflict"});
    await pool.query('INSERT INTO "Conversation"(id,"orgId",channel,"customerIdentifier","updatedAt","agentReviewRevision") VALUES($1,$2,$3,$4,NOW(),$5::bigint)',["large","org","email","large-recipient","9007199254740992"]);
    const large=(await pool.query('UPDATE "Conversation" SET starred=true WHERE id=$1 RETURNING "agentReviewRevision"::text AS revision',["large"])).rows[0];
    assert.equal(large.revision,"9007199254740993");
    await pool.query('INSERT INTO "Conversation"(id,"orgId",channel,"customerIdentifier","updatedAt","agentReviewRevision") VALUES($1,$2,$3,$4,NOW(),$5::bigint)',["overflow","org","email","overflow-recipient","9223372036854775807"]);
    await assert.rejects(pool.query('UPDATE "Conversation" SET starred=true WHERE id=$1',["overflow"]),{code:"22003"});
  } finally {await first.query("ROLLBACK").catch(()=>{});await second.query("ROLLBACK").catch(()=>{});first.release();second.release();await fixture.close();}
});

test("old unstarted reviews go stale while an uncertain effect reconciles its original receipt", { skip: !database }, async () => {
  installPgTimestampParsers();
  const fixture=await isolatedDatabase(database!,"operation_review_versions",["User","Organization","OrganizationMember","SocialPost","Conversation"]),{pool}=fixture;
  try {
    await pool.query(await readFile(new URL("../../database/prisma/migrations/20260829180000_add_core_analytics_outbox/migration.sql",import.meta.url),"utf8"));
    await pool.query(await readFile(new URL("../sql/20261101140000_growth_operation_reviews.sql",import.meta.url),"utf8"));
    await pool.query(`INSERT INTO "User"(id,email,"createdAt","updatedAt") VALUES('owner','owner@example.test',now(),now());
      INSERT INTO "Organization"(id,name,slug,"ownerId","createdAt","updatedAt") VALUES('org','Business','review-version-fixture','owner',now(),now());
      INSERT INTO "OrganizationMember"(id,"orgId","userId",role,"updatedAt") VALUES('member','org','owner','OWNER',now());
      INSERT INTO "Conversation"(id,"orgId",channel,"customerIdentifier","updatedAt") VALUES('reviewed-conversation','org','email','recipient',now())`);
    const context:RequestContext={principal:{kind:"direct_user",id:"owner",subjectUserId:"owner"},userId:"owner",organizationId:"org",clientId:null,apiScopes:null,effectiveGrants:new Set(),correlationId:null,causationId:null,idempotencyKey:"old-review-fixture"};
    const core={pool,config:readConfig({DATABASE_URL:database!})},audit={id:"fixture",action:null,rateLimit:100,rateRemaining:99,rateResetSeconds:60,correlationId:null};
    const competing=[true,false].map((starred,index)=>({operation:"inbox.conversations.update",input:{conversationId:"reviewed-conversation",starred},requestId:`concurrent-review-${index}`,requestAudit:audit}));
    const proposals=await Promise.all(competing.map(call=>executeGrowthOperation(core,context,call))) as {review:{id:string;payloadDigest:string}}[];
    await Promise.all(proposals.map(proposal=>decideOperationReview(core,context,proposal.review.id,"approve",proposal.review.payloadDigest)));
    const outcomes=await Promise.allSettled(competing.map((call,index)=>executeGrowthOperation(core,context,{...call,reviewId:proposals[index]!.review.id})));
    assert.equal(outcomes.filter(outcome=>outcome.status==="fulfilled").length,1);
    const failed=outcomes.find(outcome=>outcome.status==="rejected") as PromiseRejectedResult;assert.equal(failed.reason.code,"operation_review_conflict");
    const input={draft:{content:"Reviewed text",channels:["FACEBOOK"]}},call={operation:"content.posts.draft.create",input,requestId:"old-review-fixture",requestAudit:audit};
    const prepared=await executeGrowthOperation(core,context,call) as {review:{id:string;payloadDigest:string}};
    await pool.query('UPDATE "GrowthOperationReview" SET snapshot=snapshot-$2 WHERE id=$1',[prepared.review.id,"agentReviewRevisionSchema"]);
    await assert.rejects(decideOperationReview(core,context,prepared.review.id,"approve",prepared.review.payloadDigest),{code:"operation_review_conflict"});
    await pool.query('UPDATE "GrowthOperationReview" SET state=\'approved\' WHERE id=$1',[prepared.review.id]);
    await assert.rejects(executeGrowthOperation(core,context,{...call,reviewId:prepared.review.id}),{code:"operation_review_conflict"});
    const other={...call,requestId:"old-uncertain-fixture"},uncertain=await executeGrowthOperation(core,context,other) as {review:{id:string}};
    await pool.query('UPDATE "GrowthOperationReview" SET state=\'uncertain\',snapshot=snapshot-$2 WHERE id=$1',[uncertain.review.id,"agentReviewRevisionSchema"]);
    await pool.query(`INSERT INTO "SocialPost"(id,"userId","orgId",content,channels,status,metadata,"createdAt","updatedAt")
      VALUES('saved','owner','org','Reviewed text',ARRAY['FACEBOOK']::public."SocialPlatform"[],'DRAFT',$1,NOW(),NOW())`,[JSON.stringify({_kasitek_agent_idempotency_key:`growth-operation:${uncertain.review.id}`,_kasitek_agent_request_digest:"a".repeat(64)})]);
    const recovered=await executeGrowthOperation(core,context,{...other,reviewId:uncertain.review.id});
    assert.deepEqual(recovered.result,{reconciled:true,postId:"saved",receipt:"draft_created"});
    assert.equal((await pool.query('SELECT count(*) FROM "SocialPost"')).rows[0].count,"1");
  } finally {await fixture.close();}
});
