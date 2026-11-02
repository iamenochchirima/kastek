import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { CustomerFollowupChallenges } from "../src/product/customer-followup/challenges";
import { followupAccess } from "../src/product/customer-followup/access";
import { registerCustomerFollowupConsent } from "../src/product/customer-followup/routes";
import { CustomerFollowupNotifications, enqueueCustomerFollowup } from "../src/product/customer-followup/notifications";
import { transaction } from "../src/infrastructure/database";
import { dispatchCustomerFollowupsOnce } from "../src/product/customer-followup/runtime";
import { PlatformStore } from "../src/product/agents/store";
import { InboxStore } from "../src/product/inbox/inbox-store";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("customer follow-up verification", () => {
  let admin: Pool, pool: Pool, service: CustomerFollowupChallenges;
  const database = `agents_followup_${randomUUID().replaceAll("-", "")}`;
  let scope: { deploymentId: string; sessionId: string; conversationId: string };
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href });
    await setupPlatformSchema(pool);
    const platform = new PlatformStore(pool), owner = await platform.ensureAccount({ issuer: "https://identity.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await platform.createOrganization(owner.id, "Follow-up fixtures"); await connectFixtureModel(pool, owner.id, org.id);
    const agent = await platform.createAgent({ accountId: owner.id, organizationId: org.id, name: "Support", configuration: defaultBusinessConfiguration() });
    const version = await platform.createVersion({ accountId: owner.id, organizationId: org.id, agentId: agent.id, expectedRevision: 1 });
    const deployment = await platform.publishWebsite({ accountId: owner.id, organizationId: org.id, agentId: agent.id, versionId: version.id, allowedOrigins: ["https://customer.test"] });
    const sessionId = randomUUID(); await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)", [sessionId, deployment.id, createHash("sha256").update(randomBytes(32)).digest("hex"), "https://customer.test"]);
    const conversationId = randomUUID();
    await pool.query("INSERT INTO agents_platform.customer_conversations(id,organization_id,deployment_id,agent_id,version_id,session_id) VALUES($1,$2,$3,$4,$5,$6)", [conversationId, org.id, deployment.id, agent.id, version.id, sessionId]);
    scope = { deploymentId: deployment.id, sessionId, conversationId }; service = new CustomerFollowupChallenges(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  it("requires the scoped visitor, expires stale challenges on address changes and verifies only once", async () => {
    await expect(service.requestVerification({ ...scope, sessionId: randomUUID() }, "attacker@example.test")).rejects.toMatchObject({ code: "FOLLOWUP_UNAVAILABLE" });
    const first = await service.requestVerification(scope, "first@example.test");
    const second = await service.requestVerification(scope, "second@example.test");
    await expect(service.verifyEmail(scope, first.secret)).rejects.toMatchObject({ code: "FOLLOWUP_UNAVAILABLE" });
    await service.verifyEmail(scope, second.secret);
    await expect(service.verifyEmail(scope, second.secret)).rejects.toMatchObject({ code: "FOLLOWUP_UNAVAILABLE" });
    const result = await pool.query("SELECT email,status FROM agents_platform.customer_followup_preferences WHERE conversation_id=$1", [scope.conversationId]);
    expect(result.rows[0]).toEqual({ email: "second@example.test", status: "verified" });
  });
  it("rejects expired or revoked challenges and stores only a digest", async () => {
    const attempt = await service.requestVerification(scope, "third@example.test");
    const stored = await pool.query("SELECT secret_hash FROM agents_platform.customer_followup_challenges WHERE secret_hash=$1", [createHash("sha256").update(attempt.secret).digest("hex")]);
    expect(stored.rowCount).toBe(1); expect(stored.rows[0].secret_hash).not.toBe(attempt.secret);
    await pool.query("UPDATE agents_platform.customer_followup_challenges SET expires_at=now()-interval '1 second' WHERE secret_hash=$1", [stored.rows[0].secret_hash]);
    await expect(service.verifyEmail(scope, attempt.secret)).rejects.toMatchObject({ code: "FOLLOWUP_UNAVAILABLE" });
    const next = await service.requestVerification(scope, "third@example.test");
    await service.revoke(scope);
    await expect(service.verifyEmail(scope, next.secret)).rejects.toMatchObject({ code: "FOLLOWUP_UNAVAILABLE" });
  });
  it("exchanges a return challenge once into a session-scoped revocable access grant", async () => {
    const verification = await service.requestVerification(scope, "fourth@example.test"); await service.verifyEmail(scope, verification.secret);
    const messageId = randomUUID(), notificationId = randomUUID(), nextSession = randomUUID();
    await pool.query(`INSERT INTO agents_platform.customer_messages(id,conversation_id,sequence,author_kind,body,request_key,request_digest,ownership_generation)
      VALUES($1,$2,1,'human','Hello','reply','digest',1)`, [messageId, scope.conversationId]);
    await pool.query("UPDATE agents_platform.customer_conversations SET state='handoff_pending',next_sequence=2 WHERE id=$1", [scope.conversationId]);
    await pool.query(`INSERT INTO agents_platform.customer_followup_notifications(id,conversation_id,message_id,preference_revision,state)
      SELECT $1,$2,$3,revision,'sending' FROM agents_platform.customer_followup_preferences WHERE conversation_id=$2`, [notificationId, scope.conversationId, messageId]);
    const secret = await service.issueReturn(notificationId);
    await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)", [nextSession, scope.deploymentId, createHash("sha256").update(randomBytes(32)).digest("hex"), "https://customer.test"]);
    await expect(service.exchangeReturn({ deploymentId: scope.deploymentId, sessionId: randomUUID() }, secret)).rejects.toMatchObject({ code: "FOLLOWUP_UNAVAILABLE" });
    const next = { deploymentId: scope.deploymentId, sessionId: nextSession };
    expect(await service.exchangeReturn(next, secret)).toEqual({ conversationId: scope.conversationId });
    await expect(service.exchangeReturn(next, secret)).rejects.toMatchObject({ code: "FOLLOWUP_UNAVAILABLE" });
    const db = await pool.connect();
    try {
      expect(await followupAccess(db, next, scope.conversationId)).toBe(scope.conversationId);
      expect(await followupAccess(db, next, randomUUID())).toBeNull();
      const inbox = new InboxStore(pool, { followupAccess, admit: async () => { throw new Error("unexpected automated execution"); }, readableOutput: async (_db,_task,body) => body, cancelRoot: async () => {} });
      expect((await inbox.open(next)).id).toBe(scope.conversationId);
      const sent = await inbox.ingress(next, scope.conversationId, { requestKey:"returned-message", body:"More details" });
      expect(sent.message.body).toBe("More details");
      await service.revoke(scope);
      expect(await followupAccess(db, next, scope.conversationId)).toBeNull();
      await expect(inbox.readVisitor(next, scope.conversationId, "0", 10)).rejects.toMatchObject({code:"INBOX_ACCESS_DENIED"});
    } finally { db.release(); }
  });
  it("requires explicit consent and keeps the verification secret out of API responses", async () => {
    const app = Fastify(); let sent = "";
    registerCustomerFollowupConsent(app, { challenges: service, resolveVisitor: async () => scope, publicRate: async () => {}, send: async message => { sent = message.text; return { state: "accepted", providerId: "fixture" }; } });
    try {
      const path = `/api/website/${scope.deploymentId}/customer-conversations/${scope.conversationId}/followup`;
      const invalid = await app.inject({ method:"POST", url:`${path}/request`, payload:{email:"new@example.test",confirmed:false} });
      expect(invalid.statusCode).toBeGreaterThanOrEqual(400); expect(sent).toBe("");
      const accepted = await app.inject({ method:"POST", url:`${path}/request`, payload:{email:"new@example.test",confirmed:true} });
      expect(accepted.statusCode).toBe(200); expect(accepted.json()).toEqual({state:"confirmation_sent"});
      const code = sent.match(/[A-Za-z0-9_-]{43}/)?.[0]; expect(code).toBeTruthy(); expect(accepted.body).not.toContain(code);
      const verified = await app.inject({method:"POST",url:`${path}/verify`,payload:{code}}); expect(verified.json()).toEqual({state:"verified"});
    } finally { await app.close(); }
  });
  it("suppresses already-read replies and sends a claimed unread reply only once", async () => {
    const second = randomUUID(), third = randomUUID();
    for (const [id, sequence] of [[second,3],[third,4]] as const) await pool.query(`INSERT INTO agents_platform.customer_messages(id,conversation_id,sequence,author_kind,body,request_key,request_digest,ownership_generation)
      VALUES($1,$2,$3,'human','Hello',$4,'digest',1)`, [id, scope.conversationId, sequence, `reply-${sequence}`]);
    const suppressed = await transaction(pool, db => enqueueCustomerFollowup(db, scope.conversationId, second)); expect(suppressed).toBeTruthy();
    await service.markRead(scope, "3"); let count = 0, text = "";
    const sender = new CustomerFollowupNotifications(pool, async message => { count++; text = message.text; return {state:"accepted",providerId:"fixture"}; }, "https://agents.example/");
    expect(await sender.deliver(suppressed!)).toBe("not_pending"); expect(count).toBe(0);
    const pending = await transaction(pool, db => enqueueCustomerFollowup(db, scope.conversationId, third)); expect(pending).toBeTruthy();
    expect(await sender.deliver(pending!)).toBe("accepted"); expect(await sender.deliver(pending!)).toBe("not_pending"); expect(count).toBe(1);
    expect(text).toContain("https://agents.example/support/return/");
    const row = await pool.query("SELECT state,provider_id FROM agents_platform.customer_followup_notifications WHERE id=$1", [pending]);
    expect(row.rows[0]).toEqual({state:"accepted",provider_id:"fixture"});
  });
  it("does not send when notification consent is revoked before the provider request", async () => {
    const messageId = randomUUID();
    await pool.query(`INSERT INTO agents_platform.customer_messages(id,conversation_id,sequence,author_kind,body,request_key,request_digest,ownership_generation)
      VALUES($1,$2,5,'human','Hello','reply-5','digest',1)`, [messageId, scope.conversationId]);
    const id = await transaction(pool, db => enqueueCustomerFollowup(db, scope.conversationId, messageId)); expect(id).toBeTruthy();
    let physicalRequests = 0;
    const sender = new CustomerFollowupNotifications(pool, async (_message, beforeAttempt) => {
      await service.revoke(scope);
      try { await beforeAttempt?.(); } catch { return {state:"unknown"}; }
      physicalRequests++; return {state:"accepted",providerId:"unexpected"};
    }, "https://agents.example/");
    expect(await sender.deliver(id!)).toBe("suppressed"); expect(physicalRequests).toBe(0);
  });
  it("dispatches pending work by notification identity once", async () => {
    const verification=await service.requestVerification(scope,"dispatch@example.test");await service.verifyEmail(scope,verification.secret);
    const messageId=randomUUID();await pool.query(`INSERT INTO agents_platform.customer_messages(id,conversation_id,sequence,author_kind,body,request_key,request_digest,ownership_generation)
      VALUES($1,$2,6,'human','Hello','reply-6','digest',1)`,[messageId,scope.conversationId]);
    const id=await transaction(pool,db=>enqueueCustomerFollowup(db,scope.conversationId,messageId));expect(id).toBeTruthy();
    const urls:string[]=[];const fakeFetch=(async (url: string | URL | Request) => {urls.push(String(url));return new Response(JSON.stringify({invocationId:"inv_fixture"}),{status:200});}) as typeof fetch;
    await dispatchCustomerFollowupsOnce(pool,"http://127.0.0.1:18081",fakeFetch);await dispatchCustomerFollowupsOnce(pool,"http://127.0.0.1:18081",fakeFetch);
    expect(urls).toEqual([`http://127.0.0.1:18081/restate/send/AgentsCustomerFollowupV1/${id}/run`]);
  });
});
