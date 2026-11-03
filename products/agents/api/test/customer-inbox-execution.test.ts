import { contextGrantCeiling } from "../src/execution/models/settings";
import {connectFixtureModel} from "./model-fixture";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { composeInbox } from "../src/composition/inbox";
import { WebsiteAppearanceStore } from "../src/product/deployments/appearance-store";
import { PlatformStore } from "../src/product/agents/store";
import { defaultBusinessConfiguration, executionGrantSchema, requestDigest } from "../src/contracts/contracts";
import { beginOperation, finishOperation, loadExecution, settleTask, assertCurrentAuthority, transaction } from "../src/execution/lifecycle/execution";
import { admitChildren } from "../src/execution/delegation/delegation";
import { EvidenceStore } from "../src/execution/context/evidence";
import { TaskArtifactStore } from "../src/execution/artifacts/task-artifacts";
import { ConnectionVault } from "../src/infrastructure/vault";
import { ConnectionStore } from "../src/product/connections/connections";
import { ActionService } from "../src/workflows/report-delivery/actions";
import { createReportReceiver, initializeReportReceiver } from "../src/acceptance/report-receiver";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("trusted channel port runtime boundaries, not advanced public website functionality", () => {
  let admin: Pool, pool: Pool, store: PlatformStore, inbox: ReturnType<typeof composeInbox>, artifacts: TaskArtifactStore, connections: ConnectionStore, actions: ActionService;
  let receiver: ReturnType<typeof createReportReceiver>, target: { id: string; label: string; url: string; resource: string };
  const database = `agents_channel_runtime_${randomUUID().replaceAll("-", "")}`, receiverKey = randomBytes(24).toString("hex"), origin = "https://channel-fixture.test";
  const vault = new ConnectionVault("fixture", { fixture: randomBytes(32).toString("base64") }), bodies = new Map<string, Uint8Array>();
  let readGate: (() => Promise<void>) | undefined, acceptance: ((id: string) => Promise<void>) | undefined;
  let posts = 0, reads = 0;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href, max: 12 }); await setupPlatformSchema(pool); await initializeReportReceiver(pool);
    store = new PlatformStore(pool); inbox = composeInbox(pool, { publicOrigin: origin, async assertServices() { throw new Error("This fixture does not admit through the public website adapter"); } });
    receiver = createReportReceiver({ pool, keys: [{ apiKey: receiverKey, resource: "channel:reports" }], afterAccept: async id => acceptance?.(id) });
    receiver.addHook("onRequest", async request => { if (request.method === "POST") posts++; else if (request.method === "GET") reads++; });
    target = { id: "channel-report", label: "Controlled channel report receiver", url: `${await receiver.listen({ host: "127.0.0.1", port: 0 })}/deliveries`, resource: "channel:reports" };
    artifacts = new TaskArtifactStore(pool, { async put(key, value) { bodies.set(key, Buffer.from(value)); }, async get(key) { await readGate?.(); const value = bodies.get(key); if (!value) throw new Error("Private fixture artifact missing"); return value; }, async delete(key) { bodies.delete(key); } });
    connections = new ConnectionStore(pool, vault, [target]); actions = new ActionService(pool, { artifacts, vault, targets: [target] });
  });
  afterAll(async () => { await receiver?.close(); await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  async function fixture() {
    const account = await store.ensureAccount({ issuer: "https://channel-operator.test", subject: randomUUID(), email: "operator@channel.test", displayName: "Fixture operator" });
    const organization = await store.createOrganization(account.id, "Trusted runtime channel fixture"), scope = { accountId: account.id, organizationId: organization.id };
    await connectFixtureModel(pool,account.id,organization.id);
    const connection = await connections.create(scope, { operationId: randomUUID(), name: "Controlled reports", targetId: target.id, apiKey: receiverKey });
    const specialist = await store.createAgent({ ...scope, name: "Specialist", configuration: defaultBusinessConfiguration() }), specialistVersion = await store.createVersion({ ...scope, agentId: specialist.id, expectedRevision: 1 });
    const configuration = defaultBusinessConfiguration(); configuration.tools = ["agents.delegate", "sandbox.analyze"];
    configuration.capabilities.delegation = { enabled: true, maxChildren: 2, maxDepth: 1, bindings: [{ id: "research", versionId: specialistVersion.id, sourceRevisionIds: [], connectedToolBindingIds: [], tools: [], maxTokens: 8000, maxActiveMs: 60000 }] };
    configuration.capabilities.sandbox = { enabled: true, profileId: "python-analysis-v1" };
    configuration.capabilities.workflows = { enabled: true, profileId: "report-delivery-v1", connectionId: connection.id, reportArtifactName: "report.json", title: "Controlled report" };
    const agent = await store.createAgent({ ...scope, name: "Trusted channel coordinator", configuration }), version = await store.createVersion({ ...scope, agentId: agent.id, expectedRevision: 1 });
    // The public adapter's capability gate remains intact. These bindings test the trusted runtime port.
    await expect(store.publishWebsite({ ...scope, agentId: agent.id, versionId: version.id, allowedOrigins: [origin] })).rejects.toMatchObject({ code: "WEBSITE_CAPABILITY_DENIED" });
    const publicConfiguration = defaultBusinessConfiguration(); publicConfiguration.program = { id: "grounded-conversation", version: "1" }; publicConfiguration.tools = [];
    const publicAgent = await store.createAgent({ ...scope, name: "Normal website fixture", configuration: publicConfiguration }), publicVersion = await store.createVersion({ ...scope, agentId: publicAgent.id, expectedRevision: 1 });
    const deployment = await store.publishWebsite({ ...scope, agentId: publicAgent.id, versionId: publicVersion.id, allowedOrigins: [origin] }), sessionId = randomUUID(), token = randomBytes(32).toString("base64url");
    await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)", [sessionId, deployment.id, createHash("sha256").update(token).digest("hex"), origin]);
    const conversationId = randomUUID(), inputMessageId = randomUUID(), input = "Controlled trusted-channel request";
    // Seed only canonical product-fixture data. Native grants, publication and task admission remain real.
    await pool.query("INSERT INTO agents_platform.customer_conversations(id,organization_id,deployment_id,agent_id,version_id,session_id,next_sequence) VALUES($1,$2,$3,$4,$5,$6,2)", [conversationId, scope.organizationId, deployment.id, agent.id, version.id, sessionId]);
    await pool.query("INSERT INTO agents_platform.customer_messages(id,conversation_id,sequence,author_kind,body,request_key,request_digest,ownership_generation) VALUES($1,$2,1,'visitor',$3,$4,$5,1)", [inputMessageId, conversationId, input, randomUUID(), requestDigest({ input })]);
    const binding = { customerConversationId: conversationId, ownershipGeneration: "1", inputMessageId }, authority = { product: "agents" as const, organizationId: scope.organizationId, resourceId: agent.id, callerClientId: "agents-execution", principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } };
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id, operations: ["model.reply", "knowledge.read", "delegation.execute", "sandbox.execute", "artifact.read", "artifact.write", "effect.deliver"], maxInputBytes: configuration.model.maxInputBytes, maxOutputTokens: configuration.model.maxOutputTokens, maxContextTokens: contextGrantCeiling(configuration), rootTokenLimit: 32000, expiresAt: new Date(Date.now() + 600_000).toISOString(), revokedAt: null });
    await store.createGrant({ accountId: account.id, grant });
    const admitted = await store.admitTask({ authority, versionId: version.id, grantId: grant.id, requestKey: randomUUID(), input, channelBinding: binding });
    await pool.query("UPDATE agents_platform.customer_messages SET task_id=$2 WHERE id=$1", [inputMessageId, admitted.task.id]);
    await pool.query("UPDATE agents_platform.customer_conversations SET execution_conversation_id=$2 WHERE id=$1", [conversationId, admitted.task.conversation_id]);
    await pool.query("INSERT INTO agents_platform.customer_task_links(task_id,conversation_id,input_message_id,ownership_generation) VALUES($1,$2,$3,1)", [admitted.task.id, conversationId, inputMessageId]);
    const command = async (action: "claim" | "takeover" | "return" | "resolve" | "reopen" | "unassign" | "reply", body?: string) => {
      const current = await inbox.readStaff(scope, conversationId); return inbox.command(scope, conversationId, { commandId: randomUUID(), expectedRevision: current.conversation.revision, action, ...(body ? { body } : {}) });
    };
    await command("claim");
    return { scope, agent, version, connection, authority, grant, task: admitted.task, binding, conversationId, command };
  }
  it("pauses website grants and current Inbox binding while retaining staff history and stable deployment identity", async () => {
    const account=await store.ensureAccount({issuer:"https://pause.test",subject:randomUUID(),email:"owner@pause.test",displayName:"Owner"});
    const organization=await store.createOrganization(account.id,"Website pause"),scope={accountId:account.id,organizationId:organization.id};
    await connectFixtureModel(pool,account.id,organization.id);
    const configuration=defaultBusinessConfiguration();configuration.program={id:"grounded-conversation",version:"1"};configuration.tools=[];
    const agent=await store.createAgent({...scope,name:"Website support",configuration}),version=await store.createVersion({...scope,agentId:agent.id,expectedRevision:1});
    const deployment=await store.publishWebsite({...scope,agentId:agent.id,versionId:version.id,allowedOrigins:[origin]}),sessionId=randomUUID();
    await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)",[sessionId,deployment.id,createHash("sha256").update(randomUUID()).digest("hex"),origin]);
    const currentInbox=composeInbox(pool,{publicOrigin:origin,async assertServices(){}}),visitor={deploymentId:deployment.id,sessionId};
    const conversation=await currentInbox.open(visitor),messageId=randomUUID();
    await pool.query("INSERT INTO agents_platform.customer_messages(id,conversation_id,sequence,author_kind,body,request_key,request_digest,ownership_generation) VALUES($1,$2,1,'visitor',$3,$4,$5,1)",[messageId,conversation.id,"Controlled trusted-channel request",randomUUID(),requestDigest({fixture:true})]);
    const binding={customerConversationId:conversation.id,ownershipGeneration:"1",inputMessageId:messageId},nativeTask={organization_id:scope.organizationId,version_id:version.id};
    await currentInbox.assertBinding(pool,binding,nativeTask);
    const f={scope,conversationId:conversation.id},website={...deployment,session_id:sessionId};
    const appearances = new WebsiteAppearanceStore(pool), before = await appearances.get(f.scope, website.agent_id, website.id);
    const member=await store.ensureAccount({issuer:"https://pause.test",subject:randomUUID(),email:"member@pause.test",displayName:"Member"});
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[scope.organizationId,member.id]);
    const memberScope={...scope,accountId:member.id};expect((await appearances.get(memberScope,website.agent_id,website.id)).appearanceDigest).toBe(before.appearanceDigest);
    await expect(appearances.update(memberScope,website.agent_id,website.id,{appearance:before.appearance,paused:true,expectedAppearanceDigest:before.appearanceDigest})).rejects.toMatchObject({code:"ACCESS_DENIED"});
    const paused = await appearances.update(f.scope, website.agent_id, website.id, { appearance: { ...before.appearance, title: "Customer support", quickReplies: ["Opening hours"] }, paused: true, expectedAppearanceDigest: before.appearanceDigest });
    expect(paused.deploymentId).toBe(website.id); expect(paused.paused).toBe(true);
    await expect(appearances.update(f.scope, website.agent_id, website.id, { appearance: before.appearance, paused: false, expectedAppearanceDigest: before.appearanceDigest })).rejects.toMatchObject({code:"WEBSITE_SETTINGS_CHANGED"});
    await expect(store.createWebsiteGrant({deploymentId:website.id, origin, sessionId:website.session_id})).rejects.toMatchObject({code:"NOT_FOUND"});
    await expect(currentInbox.assertBinding(pool,binding,nativeTask)).rejects.toMatchObject({code:"CHANNEL_OWNERSHIP_CHANGED"});
    expect((await currentInbox.readStaff(f.scope,f.conversationId)).messages.map(item=>item.body)).toContain("Controlled trusted-channel request");
    const resumed=await appearances.update(f.scope, website.agent_id, website.id, {appearance:paused.appearance,paused:false,expectedAppearanceDigest:paused.appearanceDigest});
    expect(resumed.deploymentId).toBe(website.id);expect((await store.createWebsiteGrant({deploymentId:website.id,origin,sessionId:website.session_id})).principal.kind).toBe("visitor");
  });
  async function report(f: Awaited<ReturnType<typeof fixture>>) {
    const operationId = `analysis:${f.task.id}`;
    await beginOperation(pool, f.task.id, { id: operationId, kind: "resource", name: "sandbox.analyze", request: { fixtureArtifact: true }, reservedTokens: 0, reservedMs: 1000 });
    const artifact = await artifacts.put(f.task.id, operationId, { name: "report.json", contentType: "application/json", content: Buffer.from('{"controlled":true}') });
    await finishOperation(pool, f.task.id, operationId, "completed", { fixtureArtifact: true }, null, 0);
    const action = await actions.prepare(f.task.id, `report:${f.task.id}:deliver`, { connectionId: f.connection.id, artifactId: artifact.id });
    await actions.decide(f.scope, f.task.id, action.id, { operationId: randomUUID(), decision: "approve", expectedDigest: action.reviewDigest }); return action;
  }
  it("reads reviewed evidence with one connection and still rejects withdrawn current authority",async()=>{
    const f=await fixture(),action=await report(f),url=new URL(databaseUrl!);url.pathname=`/${database}`;
    const single=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:150,statement_timeout:2000,query_timeout:2500});
    try{const evidence=new EvidenceStore(single,artifacts.objects);expect(await evidence.reviewerPassages(f.scope,f.task.id,action.artifactId)).toEqual([]);
      await store.revokeGrant(f.scope.accountId,f.scope.organizationId,f.grant.id);
      await expect(evidence.reviewerPassages(f.scope,f.task.id,action.artifactId)).rejects.toMatchObject({code:'EVIDENCE_UNAVAILABLE'});
    }finally{await single.end();}
  },10000);
  async function waitFor(check:()=>Promise<boolean>){const deadline=Date.now()+5000;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error("Native lock checkpoint timed out");}
  it("commits takeover and its typed event while a runtime task writer waits for conversation authority",async()=>{
    const f=await fixture(),key=Math.floor(Math.random()*1000000000),fn=`takeover_gate_${f.task.id.replaceAll('-','')}`;
    let ready!:()=>void,check!:()=>void,runtimePid=0;
    const locked=new Promise<void>(resolve=>{ready=resolve;}),checkNow=new Promise<void>(resolve=>{check=resolve;});
    const gate=await pool.connect();await gate.query('SELECT pg_advisory_lock($1)',[key]);
    await pool.query(`CREATE FUNCTION agents_platform.${fn}() RETURNS trigger LANGUAGE plpgsql AS $gate$ BEGIN IF NEW.id='${f.conversationId}' AND NEW.state='human_owned' THEN PERFORM pg_advisory_xact_lock(${key});END IF;RETURN NEW;END $gate$;CREATE TRIGGER ${fn} BEFORE UPDATE ON agents_platform.customer_conversations FOR EACH ROW EXECUTE FUNCTION agents_platform.${fn}();`);
    const runtime=transaction(pool,async db=>{runtimePid=Number((await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);await db.query("SET LOCAL lock_timeout='5s'");const execution=await loadExecution(db,f.task.id,true);ready();await checkNow;try{await assertCurrentAuthority(db,execution);return 'ALLOWED';}catch(error){if(error&&typeof error==='object'&&'code' in error)return String(error.code);throw error;}});
    let takeover:ReturnType<typeof f.command>|undefined;
    try{await locked;takeover=f.command('takeover');takeover.catch(()=>{});
      await waitFor(async()=>Number((await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'")).rows[0].n)>0);
      check();await waitFor(async()=>Number((await pool.query('SELECT cardinality(pg_blocking_pids($1)) AS n',[runtimePid])).rows[0].n)>0);
      await gate.query('SELECT pg_advisory_unlock($1)',[key]);
      expect(await runtime).toBe('CHANNEL_OWNERSHIP_CHANGED');expect(await takeover).toMatchObject({state:'human_owned'});
      const observed=(await pool.query("SELECT kind,observation FROM agents_platform.task_events WHERE task_id=$1 AND kind='channel.takeover'",[f.task.id])).rows;expect(observed).toHaveLength(1);expect(observed[0].observation.kind).toBe('channel.takeover');
      await expect(pool.query('INSERT INTO agents_platform.customer_cancellations(task_id) VALUES($1)',[randomUUID()])).rejects.toMatchObject({code:'23503'});
    }finally{check();await gate.query('SELECT pg_advisory_unlock($1)',[key]);gate.release();await runtime.catch(()=>{});await takeover?.catch(()=>{});await pool.query(`DROP TRIGGER ${fn} ON agents_platform.customer_conversations;DROP FUNCTION agents_platform.${fn}();`);}
  },15000);
  it("continues to serialize two runtime writers of the same immutable task identity",async()=>{
    const f=await fixture();let firstReady!:()=>void,release!:()=>void,secondReady!:()=>void,firstPid=0,secondPid=0;
    const locked=new Promise<void>(resolve=>{firstReady=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{secondReady=resolve;});
    const first=transaction(pool,async db=>{firstPid=Number((await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);await loadExecution(db,f.task.id,true);firstReady();await hold;});await locked;
    const second=transaction(pool,async db=>{secondPid=Number((await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);await db.query("SET LOCAL lock_timeout='5s'");secondReady();await loadExecution(db,f.task.id,true);});
    try{await started;await waitFor(async()=>(await pool.query('SELECT pg_blocking_pids($1) AS pids',[secondPid])).rows[0].pids.includes(firstPid));}finally{release();await first;await second;}
  },15000);
  it("fences inherited specialist claims and resumed delegation while leaving unrelated private work authorized", async () => {
    const f = await fixture(), children = await admitChildren(pool, f.task.id, "delegation-one", { requests: [{ bindingId: "research", brief: "First controlled brief" }, { bindingId: "research", brief: "Second controlled brief" }] });
    for (const child of children) expect((await loadExecution(pool, child.taskId)).task.channel_binding).toEqual(f.binding);
    const operationId = `model:${children[0]!.taskId}`;
    await beginOperation(pool, children[0]!.taskId, { id: operationId, kind: "model", name: "model.generate", request: {}, reservedTokens: 10, reservedMs: 1000 });
    const privateTask = (await store.admitTask({ authority: f.authority, versionId: f.version.id, grantId: f.grant.id, requestKey: randomUUID(), input: "Private operator instructions must not become customer context" })).task;
    await f.command("takeover");
    for (const child of children) await expect(beginOperation(pool, child.taskId, { id: randomUUID(), kind: "model", name: "model.generate", request: {}, reservedTokens: 1, reservedMs: 1000 })).rejects.toMatchObject({ code: "TASK_CANCELLED" });
    await expect(admitChildren(pool, f.task.id, "delegation-two", { requests: [{ bindingId: "research", brief: "Must not execute" }] })).rejects.toMatchObject({ code: "TASK_CANCELLED" });
    expect(await admitChildren(pool, f.task.id, "delegation-one", { requests: [{ bindingId: "research", brief: "First controlled brief" }, { bindingId: "research", brief: "Second controlled brief" }] })).toEqual(children);
    await finishOperation(pool, children[0]!.taskId, operationId, "completed", "Provider accepted before takeover", null, 4);
    expect((await pool.query("SELECT state,accounted_tokens FROM agents_platform.operations WHERE id=$1", [operationId])).rows[0]).toMatchObject({ state: "completed", accounted_tokens: 4 });
    await settleTask(pool, children[0]!.taskId, { state: "completed", output: "Must not deliver late specialist output" });
    await settleTask(pool, children[1]!.taskId, { state: "cancelled" });
    await settleTask(pool, f.task.id, { state: "completed", output: "Must not deliver late root output" });
    expect((await inbox.readStaff(f.scope, f.conversationId)).messages.map(message => message.body)).toEqual(["Controlled trusted-channel request"]);
    expect((await pool.query("SELECT state FROM agents_platform.customer_deliveries WHERE task_id=$1", [f.task.id])).rows[0].state).toBe("suppressed");
    await beginOperation(pool, privateTask.id, { id: randomUUID(), kind: "model", name: "model.generate", request: {}, reservedTokens: 1, reservedMs: 1000 });
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1", [privateTask.id])).rows[0].state).not.toBe("cancel_requested");
  });
  it("lets takeover win a real approved-report claim race before any external POST", async () => {
    const f = await fixture(), action = await report(f), before = posts;
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    readGate = async () => { entered(); await barrier; };
    const delivery = actions.deliver(f.task.id, action.id); await reached;
    try { await f.command("takeover"); } finally { readGate = undefined; release(); }
    await expect(delivery).rejects.toMatchObject({ code: "TASK_CANCELLED" });
    await expect(actions.execute(f.task.id, action.id)).rejects.toMatchObject({ code: "TASK_CANCELLED" });
    expect(posts).toBe(before); expect((await pool.query("SELECT state,claimed_at FROM agents_platform.actions WHERE id=$1", [action.id])).rows[0]).toMatchObject({ state: "approved", claimed_at: null });
  });
  it("preserves a provider-accepted effect through takeover and lost acknowledgement using status-only reconciliation", async () => {
    const f = await fixture(), action = await report(f), beforePosts = posts, beforeReads = reads;
    let accepted!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { accepted = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    acceptance = async id => { if (id === action.id) { accepted(); await barrier; throw new Error("Controlled lost acknowledgement after durable provider acceptance"); } };
    const delivery = actions.deliver(f.task.id, action.id); await reached;
    expect((await pool.query("SELECT state FROM agents_platform.actions WHERE id=$1", [action.id])).rows[0].state).toBe("claimed");
    try { await f.command("takeover"); } finally { release(); }
    expect((await delivery).state).toBe("uncertain"); acceptance = undefined;
    expect((await new ActionService(pool, { vault, targets: [target], artifacts }).reconcile(action.id)).state).toBe("delivered");
    expect((await actions.execute(f.task.id, action.id)).state).toBe("delivered");
    expect(posts - beforePosts).toBe(1); expect(reads - beforeReads).toBeGreaterThan(0);
    expect((await pool.query("SELECT count(*)::int n FROM report_delivery_receiver.deliveries WHERE id=$1", [action.id])).rows[0].n).toBe(1);
    await expect(actions.prepare(f.task.id, "another-effect", { connectionId: f.connection.id, artifactId: action.artifactId })).rejects.toMatchObject({ code: "TASK_CANCELLED" });
  });
});
