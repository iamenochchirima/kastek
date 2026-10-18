import { randomBytes, randomUUID, createHash } from "node:crypto";
import Fastify from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { PlatformStore } from "../src/product/agents/store";
import { InboxStore, type ChannelBinding, type InboxCommand } from "../src/product/inbox/inbox-store";
import { registerInboxRoutes } from "../src/product/inbox/inbox-routes";
import { transaction } from "../src/infrastructure/database";
import { registerChannelPorts } from "../src/infrastructure/channel-ports";
import { beginOperation } from "../src/execution/lifecycle/execution";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("customer Inbox transactional website channel", () => {
  let admin: Pool, pool: Pool, platform: PlatformStore, inbox: InboxStore;
  const database = `agents_inbox_${randomUUID().replaceAll("-", "")}`, origin = "https://customer.test";
  const cancelled = new Set<string>(), withdrawn = new Set<string>();
  const grants = new Map<string, string>();
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href, max: 12 });
    await setupPlatformSchema(pool); platform = new PlatformStore(pool);
    inbox = new InboxStore(pool, {
      async admit(db, input) {
        const deployment = await platform.getWebsiteDeployment(input.deploymentId);
        await inbox.assertBinding(db, input.channelBinding, { organization_id: deployment.organization_id, version_id: input.versionId });
        const result = await platform.admitTaskInTransaction(db, { authority: { product: "agents", organizationId: deployment.organization_id,
          resourceId: input.deploymentId, callerClientId: "agents-website", principal: { kind: "visitor", deploymentId: input.deploymentId, sessionId: input.sessionId } },
          grantId: grants.get(input.sessionId)!, versionId: input.versionId, requestKey: input.requestKey, input: input.input,
          channelBinding: input.channelBinding, ...(input.executionConversationId ? { conversationId: input.executionConversationId } : {}) });
        return result.task;
      },
      async readableOutput(_db, taskId, body) { return withdrawn.has(taskId) ? null : body; },
      async cancelRoot(taskId) { cancelled.add(taskId); },
    });
    registerChannelPorts(pool, { assertBinding: (...args) => inbox.assertBinding(...args), requestHandoff: (...args) => inbox.requestHandoff(...args), publishAutomated: (...args) => inbox.publishAutomated(...args), context: (...args) => inbox.context(...args) });
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  async function actor() { return platform.ensureAccount({ issuer: "https://identity.test", subject: randomUUID(), email: "inbox@example.test", displayName: "Operator" }); }
  async function fixture() {
    const owner = await actor(), member = await actor(), outsider = await actor(), org = await platform.createOrganization(owner.id, "Inbox fixtures");
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')", [org.id, member.id]);
    const config = defaultBusinessConfiguration(); config.program = { id: "grounded-conversation", version: "1" };
    const agent = await platform.createAgent({ accountId: owner.id, organizationId: org.id, name: "Support", configuration: config });
    const version = await platform.createVersion({ accountId: owner.id, organizationId: org.id, agentId: agent.id, expectedRevision: 1 });
    const deployment = await platform.publishWebsite({ accountId: owner.id, organizationId: org.id, agentId: agent.id, versionId: version.id, allowedOrigins: [origin] });
    const sessionId = randomUUID(), token = randomBytes(32).toString("base64url");
    await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)", [sessionId, deployment.id, createHash("sha256").update(token).digest("hex"), origin]);
    grants.set(sessionId, (await platform.createWebsiteGrant({ deploymentId: deployment.id, origin, sessionId })).id);
    const visitor = { deploymentId: deployment.id, sessionId }, scope = { organizationId: org.id, accountId: owner.id }, conversation = await inbox.open(visitor);
    return { owner, member, outsider, org, agent, version, deployment, visitor, scope, conversation };
  }
  async function command(f: Awaited<ReturnType<typeof fixture>>, action: InboxCommand["action"], extra: Partial<InboxCommand> = {}, accountId = f.owner.id) {
    const current = await inbox.readStaff(f.scope, f.conversation.id);
    return inbox.command({ ...f.scope, accountId }, f.conversation.id, { commandId: randomUUID(), expectedRevision: current.conversation.revision, action, ...extra });
  }
  function binding(f: Awaited<ReturnType<typeof fixture>>, messageId: string, generation = "1"): ChannelBinding { return { customerConversationId: f.conversation.id, ownershipGeneration: generation, inputMessageId: messageId }; }
  it("recovers the same conversation and visitor message/task after lost acknowledgements", async () => {
    const f = await fixture(); expect((await inbox.open(f.visitor)).id).toBe(f.conversation.id);
    const input = { requestKey: randomUUID(), body: "What are your hours?" };
    const a = await inbox.ingress(f.visitor, f.conversation.id, input), b = await inbox.ingress(f.visitor, f.conversation.id, input);
    expect(b.replayed).toBe(true); expect(b.message.id).toBe(a.message.id); expect(b.message.task_id).toBe(a.message.task_id);
    expect((await pool.query("SELECT count(*) FROM agents_platform.tasks WHERE organization_id=$1", [f.org.id])).rows[0].count).toBe("1");
    await expect(inbox.ingress(f.visitor, f.conversation.id, { ...input, body: "Different" })).rejects.toMatchObject({ code: "INBOX_CONFLICT" });
  });
  it("enforces assignment, owner reassignment, current membership and mutation CAS", async () => {
    const f = await fixture(); await command(f, "claim", {}, f.member.id);
    await expect(command(f, "takeover")).rejects.toMatchObject({ code: "INBOX_ACCESS_DENIED" });
    await expect(command(f, "assign", { assigneeAccountId: f.owner.id }, f.member.id)).rejects.toMatchObject({ code: "INBOX_ACCESS_DENIED" });
    const reassigned = await command(f, "assign", { assigneeAccountId: f.owner.id }); expect(reassigned.assignee_account_id).toBe(f.owner.id);
    await expect(command(f, "takeover", { expectedRevision: "1" })).rejects.toMatchObject({ code: "INBOX_CONFLICT" });
    await expect(inbox.readStaff({ ...f.scope, accountId: f.outsider.id }, f.conversation.id)).rejects.toMatchObject({ code: "INBOX_ACCESS_DENIED" });
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2", [f.org.id, f.member.id]);
    await expect(inbox.readStaff({ ...f.scope, accountId: f.member.id }, f.conversation.id)).rejects.toMatchObject({ code: "INBOX_ACCESS_DENIED" });
  });
  it("allows exactly one racing assignment claim", async () => {
    const f = await fixture(), results = await Promise.allSettled([f.owner.id, f.member.id].map(accountId => inbox.command({ ...f.scope, accountId }, f.conversation.id, { commandId: randomUUID(), expectedRevision: "1", action: "claim" })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });
  it("takeover fences late output and queues only the bound task for cancellation", async () => {
    const f = await fixture(), input = await inbox.ingress(f.visitor, f.conversation.id, { requestKey: randomUUID(), body: "Please help" });
    await command(f, "claim"); await command(f, "takeover"); expect(cancelled.has(input.message.task_id!)).toBe(true);
    await expect(inbox.assertBinding(pool, binding(f, input.message.id), { organization_id: f.org.id, version_id: f.version.id })).rejects.toMatchObject({ code: "CHANNEL_OWNERSHIP_CHANGED" });
    await expect(beginOperation(pool, input.message.task_id!, { id: randomUUID(), kind: "model", name: "reply", request: {}, reservedTokens: 1, reservedMs: 1000 })).rejects.toMatchObject({ code: "CHANNEL_OWNERSHIP_CHANGED" });
    await transaction(pool, db => inbox.publishAutomated(db, { taskId: input.message.task_id!, binding: binding(f, input.message.id), output: "LATE PRIVATE OUTPUT" }));
    expect((await inbox.readVisitor(f.visitor, f.conversation.id)).messages.map(row => row.body)).toEqual(["Please help"]);
    expect((await pool.query("SELECT state FROM agents_platform.customer_deliveries WHERE task_id=$1", [input.message.task_id])).rows[0].state).toBe("suppressed");
    const observations=(await pool.query("SELECT observation FROM agents_platform.task_events WHERE task_id=$1 AND kind LIKE 'channel.%' ORDER BY sequence",[input.message.task_id])).rows.map(row=>row.observation);
    expect(observations.map(item=>item.kind)).toEqual(["channel.claim","channel.takeover","channel.delivery"]);
    expect(observations.at(-1).metadata.outcome).toBe("suppressed");
    expect(observations.every(item=>item.identity.customerConversationId===f.conversation.id)).toBe(true);
    expect(JSON.stringify(observations)).not.toContain("LATE PRIVATE OUTPUT");

  });
  it("persists human-owned input without admission and returns only on a new incoming message", async () => {
    const f = await fixture(); await command(f, "claim"); await command(f, "takeover");
    const backlog = await inbox.ingress(f.visitor, f.conversation.id, { requestKey: randomUUID(), body: "Book it please" }); expect(backlog.message.task_id).toBeNull();
    await command(f, "reply", { body: "I handled that for you" }); const returned = await command(f, "return");
    expect(returned.return_watermark).toBe("2"); expect((await pool.query("SELECT count(*) FROM agents_platform.tasks WHERE organization_id=$1", [f.org.id])).rows[0].count).toBe("0");
    const next = await inbox.ingress(f.visitor, f.conversation.id, { requestKey: randomUUID(), body: "Thank you, what happens next?" }); expect(next.message.task_id).toBeTruthy();
    const context = await inbox.context(pool, binding(f, next.message.id, returned.ownership_generation), next.message.id);
    expect(context.map(row => [row.authorKind, row.content])).toEqual([["visitor", "Book it please"], ["human", "I handled that for you"]]);
    await expect(inbox.assertBinding(pool, binding(f, backlog.message.id, returned.ownership_generation), { organization_id: f.org.id, version_id: f.version.id })).rejects.toMatchObject({ code: "CHANNEL_INPUT_DENIED" });
  });
  it("recovers a human reply and never repeats its publication", async () => {
    const f = await fixture(); await command(f, "claim"); const taken = await command(f, "takeover");
    const input: InboxCommand = { commandId: randomUUID(), expectedRevision: taken.revision, action: "reply", body: "Hello from support" };
    const a = await inbox.command(f.scope, f.conversation.id, input), b = await inbox.command(f.scope, f.conversation.id, input); expect(b.revision).toBe(a.revision);
    const read = await inbox.readVisitor(f.visitor, f.conversation.id); expect(read.messages.map(row => row.body)).toEqual(["Hello from support"]);
    expect((await pool.query("SELECT count(*) FROM agents_platform.customer_deliveries WHERE conversation_id=$1", [f.conversation.id])).rows[0].count).toBe("1");
    await expect(inbox.command(f.scope, f.conversation.id, { ...input, body: "Changed" })).rejects.toMatchObject({ code: "INBOX_CONFLICT" });
  });
  it("publishes one canonical automated reply, hides withdrawn evidence and preserves ordering", async () => {
    const f = await fixture(), incoming = await inbox.ingress(f.visitor, f.conversation.id, { requestKey: randomUUID(), body: "Hours?" }), taskId = incoming.message.task_id!;
    const publish = () => transaction(pool, db => inbox.publishAutomated(db, { taskId, binding: binding(f, incoming.message.id), output: "We open at nine" }));
    await publish(); await publish(); expect((await inbox.readVisitor(f.visitor, f.conversation.id)).messages.map(row => row.sequence)).toEqual(["1", "2"]);
    withdrawn.add(taskId); expect((await inbox.readVisitor(f.visitor, f.conversation.id)).messages[1]?.body).toBe("[Response unavailable]");
    const next = await inbox.ingress(f.visitor, f.conversation.id, { requestKey: randomUUID(), body: "And tomorrow?" });
    expect((await inbox.context(pool, binding(f, next.message.id), next.message.id)).some(row => row.authorKind === "assistant")).toBe(false);
  });
  it("records escalation idempotently and blocks further automated operations", async () => {
    const f = await fixture(), incoming = await inbox.ingress(f.visitor, f.conversation.id, { requestKey: randomUUID(), body: "I need a person" }), b = binding(f, incoming.message.id);
    await transaction(pool, db => inbox.requestHandoff(db, b, incoming.message.task_id!)); await transaction(pool, db => inbox.requestHandoff(db, b, incoming.message.task_id!));
    expect((await inbox.readStaff(f.scope, f.conversation.id)).conversation.state).toBe("handoff_pending");
    await expect(inbox.assertBinding(pool, b, { organization_id: f.org.id, version_id: f.version.id })).rejects.toMatchObject({ code: "CHANNEL_OWNERSHIP_CHANGED" });
  });
  it("prevents cross-visitor/deployment and operator-chat reads", async () => {
    const a = await fixture(), b = await fixture();
    await expect(inbox.readVisitor(a.visitor, b.conversation.id)).rejects.toMatchObject({ code: "INBOX_ACCESS_DENIED" });
    await expect(inbox.readStaff(a.scope, b.conversation.id)).rejects.toMatchObject({ code: "INBOX_ACCESS_DENIED" });
    await expect(inbox.readStaff(a.scope, randomUUID())).rejects.toMatchObject({ code: "INBOX_NOT_FOUND" });
    expect((await inbox.list(a.scope, { limit: 30 })).items).toHaveLength(1);
  });
  it("serves bounded HTTP timelines, validates mutations and omits staff identities for visitors", async () => {
    const f = await fixture(), app = Fastify();
    app.setErrorHandler((error: any, _request, reply) => reply.code(error.status ?? (error.name === "ZodError" ? 400 : 500)).send({ error: { code: error.code } }));
    registerInboxRoutes(app, { inbox, resolveScope: async () => f.scope, resolveVisitor: async () => f.visitor });
    await command(f, "claim"); await command(f, "takeover"); await command(f, "reply", { body: "Support message" });
    const path = `/api/website/${f.deployment.id}/customer-conversations/${f.conversation.id}/messages`;
    const result = await app.inject({ method: "GET", url: path }); expect(result.statusCode).toBe(200); expect(result.json().messages[0].body).toBe("Support message");
    expect(result.json().messages[0]).not.toHaveProperty("authorAccountId"); expect(result.json().conversation).not.toHaveProperty("sessionId");
    expect((await app.inject({ method: "GET", url: path + "?limit=101" })).statusCode).toBe(400);
    const submitted = await app.inject({ method: "POST", url: path, payload: { requestKey: randomUUID(), body: "Thank you" } }); expect(submitted.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: `/api/organizations/${f.org.id}/inbox?channel=website` })).json().conversations).toHaveLength(1);
    await app.close();
  });
  it("orders activity by exact timestamp then identity with signed filter/account/workspace-bound cursors", async () => {
    const f = await fixture(), ids = ["00000000-0000-4000-8000-000000000001", "ffffffff-ffff-4fff-8fff-ffffffffffff", "88888888-8888-4888-8888-888888888888"];
    await pool.query("UPDATE agents_platform.customer_conversations SET updated_at='2025-01-01' WHERE id=$1", [f.conversation.id]);
    for (const [index,id] of ids.entries()) {
      const session = randomUUID();
      await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)", [session,f.deployment.id,createHash("sha256").update(randomUUID()).digest("hex"),origin]);
      await pool.query(`INSERT INTO agents_platform.customer_conversations(id,organization_id,deployment_id,agent_id,version_id,session_id,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [id,f.org.id,f.deployment.id,f.agent.id,f.version.id,session,index===0?"2025-02-01T00:00:00.123456Z":"2025-01-15T00:00:00.654321Z"]);
    }
    const first = await inbox.list(f.scope,{limit:1}); expect(first.items.map(row=>row.id)).toEqual([ids[0]]); expect(first.nextCursor).toBeTruthy();
    // Mutating the original row cannot change the signed cursor's stored timestamp anchor.
    await pool.query("UPDATE agents_platform.customer_conversations SET updated_at=now() WHERE id=$1",[ids[0]]);
    expect((await inbox.list(f.scope,{limit:1})).items[0]?.id).toBe(ids[0]);
    const second = await inbox.list(f.scope,{limit:1,cursor:first.nextCursor!}); expect(second.items.map(row=>row.id)).toEqual([ids[1]]);
    const third = await inbox.list(f.scope,{limit:1,cursor:second.nextCursor!}); expect(third.items.map(row=>row.id)).toEqual([ids[2]]);
    for (const filters of [{state:"human_owned"},{agentId:f.agent.id},{assigned:"unassigned"}]) await expect(inbox.list(f.scope,{limit:1,cursor:first.nextCursor!,...filters})).rejects.toMatchObject({code:"INVALID_CURSOR"});
    await expect(inbox.list({...f.scope,accountId:f.member.id},{limit:1,cursor:first.nextCursor!})).rejects.toMatchObject({code:"INVALID_CURSOR"});
    const foreign = await fixture(); await expect(inbox.list(foreign.scope,{limit:1,cursor:first.nextCursor!})).rejects.toMatchObject({code:"INVALID_CURSOR"});
    await expect(inbox.list(f.scope,{limit:1,cursor:first.nextCursor!+"x"})).rejects.toMatchObject({code:"INVALID_CURSOR"});
  });
  it("enforces canonical message and customer version immutability in PostgreSQL", async () => {
    const f = await fixture(); await command(f, "claim"); await command(f, "takeover"); await command(f, "reply", { body: "Immutable support reply" });
    await expect(pool.query("UPDATE agents_platform.customer_messages SET body='changed' WHERE conversation_id=$1", [f.conversation.id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE agents_platform.customer_messages SET author_kind='visitor' WHERE conversation_id=$1", [f.conversation.id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE agents_platform.customer_conversations SET version_id=$2 WHERE id=$1", [f.conversation.id, randomUUID()])).rejects.toMatchObject({ code: "23514" });
  });
  it("rechecks withdrawn assistant evidence on bounded earlier pages for both audiences", async () => {
    const f=await fixture(),input=await inbox.ingress(f.visitor,f.conversation.id,{requestKey:randomUUID(),body:"Original question"}),taskId=input.message.task_id!;
    await transaction(pool,db=>inbox.publishAutomated(db,{taskId,binding:binding(f,input.message.id),output:"Historical evidence-derived answer"}));
    await command(f,"claim"); await command(f,"takeover");
    for(let i=0;i<101;i++)await inbox.ingress(f.visitor,f.conversation.id,{requestKey:randomUUID(),body:`Later human-owned message ${i}`});
    for(const read of [()=>inbox.readStaff(f.scope,f.conversation.id,"0",100,"4"),()=>inbox.readVisitor(f.visitor,f.conversation.id,"0",100,"4")])expect((await read()).messages[1]?.body).toBe("Historical evidence-derived answer");
    withdrawn.add(taskId);
    for(const read of [()=>inbox.readStaff(f.scope,f.conversation.id,"0",100,"4"),()=>inbox.readVisitor(f.visitor,f.conversation.id,"0",100,"4")])expect((await read()).messages[1]?.body).toBe("[Response unavailable]");
  });
  it("bounds reconnect history and exposes earlier and subsequent pages without losing message identities", async () => {
    const f = await fixture(); await command(f, "claim"); await command(f, "takeover");
    for (let i = 0; i < 105; i++) await inbox.ingress(f.visitor, f.conversation.id, { requestKey: randomUUID(), body: `Customer message ${i}` });
    const latest = await inbox.readVisitor(f.visitor, f.conversation.id); expect(latest.messages).toHaveLength(100); expect(latest.messages[0]?.sequence).toBe("6");
    const older = await inbox.readVisitor(f.visitor, f.conversation.id, "0", 100, latest.messages[0]!.sequence); expect(older.messages.map(row => row.sequence)).toEqual(["1", "2", "3", "4", "5"]);
    const app = Fastify(); registerInboxRoutes(app,{inbox,resolveScope:async()=>f.scope,resolveVisitor:async()=>f.visitor});
    for (const path of [`/api/website/${f.deployment.id}/customer-conversations/${f.conversation.id}/messages`,`/api/organizations/${f.org.id}/inbox/${f.conversation.id}`]) {
      const latestPage=(await app.inject({url:path})).json(); expect(latestPage.messages).toHaveLength(100); expect(latestPage.earlierBefore).toBe("6"); expect(latestPage.nextSequence).toBe("105");
      const earlierPage=(await app.inject({url:path+"?before="+latestPage.earlierBefore})).json(); expect(earlierPage.messages.map((row:any)=>row.sequence)).toEqual(["1","2","3","4","5"]); expect(earlierPage.earlierBefore).toBeNull(); expect(earlierPage.nextSequence).toBe("5"); expect(earlierPage.latestSequence).toBe("105");
      const incremental=(await app.inject({url:path+"?after=1&limit=100"})).json(); expect(incremental.nextSequence).toBe("101"); expect(incremental.latestSequence).toBe("105");
    } await app.close();
    const after = await inbox.readVisitor(f.visitor, f.conversation.id, "100"); expect(after.messages.map(row => row.sequence)).toEqual(["101", "102", "103", "104", "105"]);
    expect((await pool.query("SELECT count(*) FROM agents_platform.tasks WHERE organization_id=$1", [f.org.id])).rows[0].count).toBe("0");
  });
});
