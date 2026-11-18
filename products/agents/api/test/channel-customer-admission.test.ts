import { skillPackageCodec } from "../src/capabilities/skills/package";
import {publishCustomerTimeoutNotice,CUSTOMER_TIMEOUT_NOTICE} from "../src/product/inbox/customer-timeout-notice";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { ChannelStore } from "../src/product/channels/channel-store";
import { ConnectionVault } from "../src/infrastructure/vault";
import { composeInbox } from "../src/composition/inbox";
import { transaction } from "../src/infrastructure/database";
import { assertCurrentAuthority, event, loadExecution, settleTask } from "../src/execution/lifecycle/execution";
import { MemoryStore } from "../src/platform/memory/memory";
import { isCustomerPrincipal } from "../src/contracts/contracts";
import { customerConfiguration } from "../src/product/offerings/offerings";
import { connectFixtureModel } from "./model-fixture";
import { inspectionAuthority } from "../src/execution/context/evidence-policy";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { ChannelDelivery } from "../src/product/channels/channel-delivery";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("canonical channel customer admission without inference", () => {
  const database = `agents_channel_admission_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, platform: PlatformStore, channels: ChannelStore;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href });
    await setupPlatformSchema(pool); platform = new PlatformStore(pool);
    channels = new ChannelStore(pool, new ConnectionVault("test", { test: randomBytes(32).toString("base64") }));
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  async function fixture(physicalChannel = false) {
    const owner = await platform.ensureAccount({ issuer: "https://channel.fixture.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await platform.createOrganization(owner.id, "Customer channels"), scope = { accountId: owner.id, organizationId: org.id };
    await connectFixtureModel(pool, owner.id, org.id, "fixture/channel-model");
    const configured = await platform.createConfiguredAgent({ ...scope, name: "Support", offering: "faq" });
    const assetId = physicalChannel ? String(Math.floor(Math.random() * 1_000_000_000)) : randomUUID();
    const connection = await channels.create(scope, { kind: "telegram", mode: "bot", name: "Support bot", assetId, state: "active", credentials: { botToken: physicalChannel ? `${assetId}:fixture` : "fixture-bot-token" } });
    const deployment = await channels.bind(scope, connection.id, { expectedRevision: 1, agentId: configured.agent.id });
    const inbox = composeInbox(pool, { publicOrigin: "https://agents.fixture.test", assertServices: async () => undefined });
    const receive = (key: string, body: string) => inbox.ingressChannel({ deploymentId: deployment.id, externalConversationId: physicalChannel ? "1234" : "chat-1", senderId: physicalChannel ? "1234" : "customer-1", requestKey: key, body });
    return { scope, owner, org, ...configured, connection, deployment, inbox, receive };
  }
  it("sends one receipt-bound timeout notice and fences later customer activity",async()=>{
    let calls=0;
    const worker = new ChannelDelivery(pool,channels,composeInbox(pool,{publicOrigin:"https://agents.fixture.test",assertServices:async()=>undefined}),{
      assertPolicy:async()=>undefined,
      context:(_connection,credentials,beforeAttempt)=>({credential:credentials.botToken,fetch:async()=>{await beforeAttempt();calls++;return Response.json({ok:true,result:{message_id:42}});}}),
    });
    const timeout=async(f:Awaited<ReturnType<typeof fixture>>,taskId:string)=>{
      await pool.query("UPDATE agents_platform.tasks SET state='cancel_requested',error_code='TASK_DEADLINE',deadline_at=now()-interval '1 second' WHERE id=$1",[taskId]);
      await event(pool,taskId,"deadline-stop","cancel_requested",{errorCode:"TASK_DEADLINE"});
    };
    const f=await fixture(true),turn=await f.receive("deadline","Please help"),taskId=turn.message.task_id!;
    await timeout(f,taskId);
    expect(await publishCustomerTimeoutNotice(pool,taskId)).toBe(true);
    expect(await publishCustomerTimeoutNotice(pool,taskId)).toBe(false);
    const view=await f.inbox.readStaff(f.scope,turn.conversation.id);
    expect(view.messages.filter(m=>m.body===CUSTOMER_TIMEOUT_NOTICE)).toHaveLength(1);
    expect(view.messages.find(m=>m.body===CUSTOMER_TIMEOUT_NOTICE)?.displayKind).toBe("system");
    await worker.drain(10);await worker.drain(10);expect(calls).toBe(1);
    const newer=await fixture(true),old=await newer.receive("old-timeout","Please help"),oldId=old.message.task_id!;
    await timeout(newer,oldId);expect(await publishCustomerTimeoutNotice(pool,oldId)).toBe(true);
    await newer.receive("new-input","Never mind");
    await worker.drain(10);expect(calls).toBe(1);
    expect((await worker.readDeliveries(newer.scope,old.conversation.id))[0].state).toBe("suppressed");
  });
  it("preserves unknown provider receipts and never sends after takeover or disconnect",async()=>{
    let calls=0;
    const worker=new ChannelDelivery(pool,channels,composeInbox(pool,{publicOrigin:"https://agents.fixture.test",assertServices:async()=>undefined}),{
      assertPolicy:async()=>undefined,
      context:(_connection,credentials,beforeAttempt)=>({credential:credentials.botToken,fetch:async()=>{await beforeAttempt();calls++;throw new Error("network lost");}}),
    });
    async function timed(f:Awaited<ReturnType<typeof fixture>>,key:string){
      const turn=await f.receive(key,"Please help"),taskId=turn.message.task_id!;
      await pool.query("UPDATE agents_platform.tasks SET state='cancel_requested',error_code='TASK_DEADLINE',deadline_at=now()-interval '1 second' WHERE id=$1",[taskId]);
      await event(pool,taskId,"deadline-stop","cancel_requested",{errorCode:"TASK_DEADLINE"});
      expect(await publishCustomerTimeoutNotice(pool,taskId)).toBe(true);return turn;
    }
    const unknown=await fixture(true),turn=await timed(unknown,"unknown");
    await worker.drain(10);await worker.drain(10);
    expect(calls).toBe(1);expect((await worker.readDeliveries(unknown.scope,turn.conversation.id))[0].state).toBe("unknown");
    const takeover=await fixture(true),other=await timed(takeover,"takeover");
    await pool.query("UPDATE agents_platform.customer_conversations SET state='human_owned',ownership_generation=ownership_generation+1 WHERE id=$1",[other.conversation.id]);
    const disconnected=await fixture(true),third=await timed(disconnected,"disconnect");
    await pool.query("UPDATE agents_platform.channel_connections SET state='disconnected',revision=revision+1 WHERE id=$1",[disconnected.connection.id]);
    await worker.drain(10);expect(calls).toBe(1);
    expect((await worker.readDeliveries(takeover.scope,other.conversation.id))[0].state).toBe("suppressed");
    expect((await worker.readDeliveries(disconnected.scope,third.conversation.id))[0].state).toBe("suppressed");
  });
  it("requires unrevoked originating authority and does not replace a normal reply",async()=>{
    const revoked=await fixture(true),first=await revoked.receive("revoked","Please help"),firstTask=first.message.task_id!;
    await pool.query("UPDATE agents_platform.tasks SET state='cancel_requested',error_code='TASK_DEADLINE' WHERE id=$1",[firstTask]);
    await event(pool,firstTask,"deadline-stop","cancel_requested",{errorCode:"TASK_DEADLINE"});
    await pool.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=(SELECT grant_id FROM agents_platform.tasks WHERE id=$1)",[firstTask]);
    expect(await publishCustomerTimeoutNotice(pool,firstTask)).toBe(false);
    const normal=await fixture(true),second=await normal.receive("normal","Please help"),secondTask=second.message.task_id!;
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[secondTask]);
    await settleTask(pool,secondTask,{state:"completed",output:"Normal reply"});
    await event(pool,secondTask,"deadline-stop","cancel_requested",{errorCode:"TASK_DEADLINE"});
    expect(await publishCustomerTimeoutNotice(pool,secondTask)).toBe(false);
    const view=await normal.inbox.readStaff(normal.scope,second.conversation.id);
    expect(view.messages.some(message=>message.body===CUSTOMER_TIMEOUT_NOTICE)).toBe(false);
  });
  it("delivers a committed handoff receipt once and fences it after ownership changes", async () => {
    let calls = 0;
    const f = await fixture(true), incoming = await f.receive("support", "I need a person");
    const binding = { customerConversationId: incoming.conversation.id, inputMessageId: incoming.message.id, ownershipGeneration: incoming.conversation.ownership_generation };
    await transaction(pool, db => f.inbox.requestHandoff(db, binding, incoming.message.task_id!));
    const worker = new ChannelDelivery(pool, channels, f.inbox, { assertPolicy: async () => undefined,
      context: (_connection, credentials, beforeAttempt) => ({ credential: credentials.botToken, fetch: async () => { await beforeAttempt(); calls++; return Response.json({ ok: true, result: { message_id: 42 } }); } }) });
    await worker.drain(2); await worker.drain(2);
    expect(calls).toBe(1);
    expect((await worker.readDeliveries(f.scope, incoming.conversation.id)).map(row => row.state)).toEqual(["accepted"]);
    const other = await fixture(true), pending = await other.receive("support", "I need a person");
    await transaction(pool, db => other.inbox.requestHandoff(db, { customerConversationId: pending.conversation.id, inputMessageId: pending.message.id, ownershipGeneration: pending.conversation.ownership_generation }, pending.message.task_id!));
    const current = (await other.inbox.readStaff(other.scope, pending.conversation.id)).conversation;
    await other.inbox.command(other.scope, pending.conversation.id, { commandId: randomUUID(), expectedRevision: current.revision, action: "claim" });
    const claimed = (await other.inbox.readStaff(other.scope, pending.conversation.id)).conversation;
    await other.inbox.command(other.scope, pending.conversation.id, { commandId: randomUUID(), expectedRevision: claimed.revision, action: "takeover" });
    await worker.drain(2);
    expect(calls).toBe(1);
    expect((await worker.readDeliveries(other.scope, pending.conversation.id))[0].state).toBe("suppressed");
    const again = await fixture(true), old = await again.receive("old", "I need a person");
    await transaction(pool, db => again.inbox.requestHandoff(db, { customerConversationId: old.conversation.id, inputMessageId: old.message.id, ownershipGeneration: old.conversation.ownership_generation }, old.message.task_id!));
    let conversation = (await again.inbox.readStaff(again.scope, old.conversation.id)).conversation;
    await again.inbox.command(again.scope, old.conversation.id, { commandId: randomUUID(), expectedRevision: conversation.revision, action: "claim" });
    conversation = (await again.inbox.readStaff(again.scope, old.conversation.id)).conversation;
    await again.inbox.command(again.scope, old.conversation.id, { commandId: randomUUID(), expectedRevision: conversation.revision, action: "return" });
    const fresh = await again.receive("new", "I need a person again");
    await transaction(pool, db => again.inbox.requestHandoff(db, { customerConversationId: fresh.conversation.id, inputMessageId: fresh.message.id, ownershipGeneration: fresh.conversation.ownership_generation }, fresh.message.task_id!));
    await worker.drain(4);
    expect(calls).toBe(2);
    expect((await worker.readDeliveries(again.scope, old.conversation.id)).map(row => row.state)).toEqual(["suppressed", "accepted"]);
  });
  it("delivers a receipt-bound waiting notice after takeover, but suppresses it after a human reply", async () => {
    let calls = 0;
    const f = await fixture(true), incoming = await f.receive("waiting", "I need a person"), taskId = incoming.message.task_id!;
    const id = incoming.conversation.id;
    await transaction(pool, db => f.inbox.requestHandoff(db, {customerConversationId:id,inputMessageId:incoming.message.id,ownershipGeneration:incoming.conversation.ownership_generation}, taskId));
    let current = (await f.inbox.readStaff(f.scope,id)).conversation;
    await f.inbox.command(f.scope,id,{commandId:randomUUID(),expectedRevision:current.revision,action:"claim"});
    current = (await f.inbox.readStaff(f.scope,id)).conversation;
    await f.inbox.command(f.scope,id,{commandId:randomUUID(),expectedRevision:current.revision,action:"takeover"});
    current = (await f.inbox.readStaff(f.scope,id)).conversation;
    const notice = {taskId,conversationId:id,ownershipGeneration:current.ownership_generation,stage:1,body:"Still waiting for support."};
    await pool.query("INSERT INTO agents_platform.support_waiting_notices(task_id,stage,ownership_generation,body) VALUES($1,$2,$3,$4)",[taskId,notice.stage,notice.ownershipGeneration,notice.body]);
    expect(await transaction(pool,db=>f.inbox.publishWaitingNotice(db,notice))).toBe(true);
    expect((await f.inbox.readStaff(f.scope,id)).messages.map(message=>message.body)).toContain(notice.body);
    const worker = new ChannelDelivery(pool,channels,f.inbox,{assertPolicy:async()=>undefined,
      context:(_connection,credentials,beforeAttempt)=>({credential:credentials.botToken,fetch:async()=>{await beforeAttempt();calls++;return Response.json({ok:true,result:{message_id:42+calls}});}})});
    await worker.drain(4); expect(calls).toBe(1);
    const later = {...notice,stage:2};
    await pool.query("INSERT INTO agents_platform.support_waiting_notices(task_id,stage,ownership_generation,body) VALUES($1,$2,$3,$4)",[taskId,later.stage,later.ownershipGeneration,later.body]);
    expect(await transaction(pool,db=>f.inbox.publishWaitingNotice(db,later))).toBe(true);
    current = (await f.inbox.readStaff(f.scope,id)).conversation;
    await f.inbox.command(f.scope,id,{commandId:randomUUID(),expectedRevision:current.revision,action:"reply",body:"I can help."});
    await worker.drain(4);
    expect(calls).toBe(2);
    expect((await worker.readDeliveries(f.scope,id)).map(row=>row.state)).toEqual(["suppressed","accepted","suppressed","accepted"]);
  });
  it("admits current saved settings on the shared route and preserves history and human ownership across saves", async () => {
    const f = await fixture(), first = await f.receive("one", "Hello");
    const task = await loadExecution(pool, first.message.task_id!);
    expect(task.task.principal).toEqual({ kind: "channel_customer", deploymentId: f.deployment.id, participantId: first.conversation.id });
    expect(isCustomerPrincipal(task.task.principal)).toBe(true); expect(task.models.primary.binding.modelId).toBe("fixture/channel-model");
    expect(task.task.root_token_limit).toBe(task.models.primary.policy.maxRootTokens);
    const grant = (await pool.query("SELECT * FROM agents_platform.execution_grants WHERE id=$1", [task.task.grant_id])).rows[0];
    expect(grant.connected_tool_binding_ids).toEqual([]); expect(grant.operations).not.toContain("memory.read"); expect(grant.operations).not.toContain("connected.execute");
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.website_sessions WHERE deployment_id=$1", [f.deployment.id])).rows[0].n).toBe(0);
    await assertCurrentAuthority(pool, task);
    const config = structuredClone(f.snapshot.configuration); config.instructions = "Use updated public support instructions.";
    await expect(platform.saveConfiguration({ ...f.scope, agentId: f.agent.id, expectedRevision: 1, configuration: config })).rejects.toMatchObject({ code: "CONFIGURATION_CONFIRMATION_REQUIRED" });
    const saved = await platform.saveConfiguration({ ...f.scope, agentId: f.agent.id, expectedRevision: 1, configuration: config, confirmImpact: true });
    const binding = (await channels.listDeployments(f.scope, f.connection.id)).find(item => item.state === "active")!;
    expect(binding.id).toBe(f.deployment.id); expect(binding.versionId).toBe(saved.snapshot.id);
    expect((await loadExecution(pool, task.task.id)).task.version_id).toBe(f.snapshot.id);
    await assertCurrentAuthority(pool, await loadExecution(pool, task.task.id));
    const second = await f.receive("two", "Another question"); expect(second.conversation.id).toBe(first.conversation.id);
    const next = await loadExecution(pool, second.message.task_id!); expect(next.task.version_id).toBe(saved.snapshot.id); expect(next.task.conversation_id).toBe(task.task.conversation_id);
    await assertCurrentAuthority(pool, next);
    await expect(new MemoryStore(pool, skillPackageCodec).read({ organizationId: f.org.id, agentId: f.agent.id, principal: next.task.principal })).rejects.toMatchObject({ code: "MEMORY_SCOPE_DENIED" });
    const command = async (action: "claim" | "takeover" | "return") => { const current = await f.inbox.readStaff(f.scope, first.conversation.id); return f.inbox.command(f.scope, first.conversation.id, { commandId: randomUUID(), expectedRevision: current.conversation.revision, action }); };
    await command("claim"); await command("takeover");
    await expect(assertCurrentAuthority(pool, await loadExecution(pool, next.task.id))).rejects.toThrow();
    await f.inbox.drainCancellations();
    await settleTask(pool, task.task.id, { state: "cancelled" });
    await settleTask(pool, next.task.id, { state: "cancelled" });
    const human = await f.receive("three", "Please wait for a person"); expect(human.message.task_id).toBeNull();
    await command("return");
    const resumed = await f.receive("four", "Continue now"); expect(resumed.message.task_id).toBeTruthy();
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.tasks WHERE organization_id=$1", [f.org.id])).rows[0].n).toBe(3);
    expect((await f.inbox.readStaff(f.scope, first.conversation.id)).messages.map(item => item.body)).toEqual(["Hello", "Another question", "Please wait for a person", "Continue now"]);
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.private_model_continuations WHERE organization_id=$1", [f.org.id])).rows[0].n).toBe(0);
  });
  it("denies forged participants, absent channel fences and private customer configuration before task creation", async () => {
    const f = await fixture(), accepted = await f.receive("first", "Hello"), execution = await loadExecution(pool, accepted.message.task_id!);
    await expect(transaction(pool, db => platform.createChannelGrantInTransaction(db, { deploymentId: f.deployment.id, participantId: randomUUID() }))).rejects.toMatchObject({ code: "NOT_FOUND" });
    const grant = await transaction(pool, db => platform.createChannelGrantInTransaction(db, { deploymentId: f.deployment.id, participantId: accepted.conversation.id }));
    await expect(platform.admitTask({ versionId: f.snapshot.id, grantId: grant.id, authority: { product: "agents", organizationId: f.org.id, resourceId: f.deployment.id, callerClientId: "agents-channel", principal: execution.task.principal }, input: "Missing canonical message fence", requestKey: randomUUID(), configurationMode: "current" })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    const config = customerConfiguration("faq"); config.program = { id: "tool-directed", version: "1" }; config.memory.enabled = true;
    await expect(platform.saveConfiguration({ ...f.scope, agentId: f.agent.id, expectedRevision: 1, configuration: config, confirmImpact: true })).rejects.toMatchObject({ code: "PRIVATE_AGENT_CONFIGURATION" });
    expect((await platform.getAgent(f.scope.accountId, f.scope.organizationId, f.agent.id)).draft_revision).toBe(1);
    expect((await channels.listDeployments(f.scope, f.connection.id)).find(item => item.state === "active")!.versionId).toBe(f.snapshot.id);
    await channels.disconnect(f.scope, f.connection.id, f.connection.revision);
    await expect(inspectionAuthority(pool,await loadExecution(pool,accepted.message.task_id!))).resolves.toBeUndefined();
    await expect(assertCurrentAuthority(pool, await loadExecution(pool, accepted.message.task_id!))).rejects.toMatchObject({ code: "CHANNEL_OWNERSHIP_CHANGED" });
  });
});
