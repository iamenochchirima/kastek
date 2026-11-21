import { skillPackageCodec } from "../src/capabilities/skills/package";
import {dropClosedTestDatabase} from "./support/database-cleanup";
import { connectFixtureModel } from "./model-fixture";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/platform/memory/memory";
import { memoryContextAllowed } from "../src/execution/business/business";
import { registerMemoryRoutes } from "../src/integrations/http/memory-routes";
import { defaultBusinessConfiguration, type AgentConfiguration } from "../src/contracts/contracts";
import { contextGrantCeiling } from "../src/execution/models/settings";
import { orchestrationTools } from "../src/contracts/orchestration";
import { SHARED_HARNESS_RELEASE, SHARED_WORKFLOW_NAME } from "../src/contracts/execution";
import { admitChildren } from "../src/execution/delegation/delegation";
import { beginOperation, finishOperation, settleTask } from "../src/execution/lifecycle/execution";
import { dispatchTasksOnce } from "../src/execution/lifecycle/dispatcher";
import { PlatformStore } from "../src/product/agents/store";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite("scoped PostgreSQL memory and immutable skills", () => {
  let admin: Pool, pool: Pool, platform: PlatformStore, memory: MemoryStore;
  const database = `agents_memory_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href });
    for (const file of (await readdir(resolve(__dirname, "../schema"))).filter(file => file.endsWith(".sql")).sort()) await pool.query(await readFile(resolve(__dirname, "../schema", file), "utf8"));
    platform = new PlatformStore(pool); memory = new MemoryStore(pool, skillPackageCodec);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin,database); await admin.end(); } });
  async function fixture() {
    const account = await platform.ensureAccount({ issuer: "http://localhost:8080/realms/memory", subject: randomUUID(), email: "memory@example.test", displayName: "Owner" });
    const organization = await platform.createOrganization(account.id, "Memory test");
    await connectFixtureModel(pool, account.id, organization.id);
    const agent = await platform.createAgent({ accountId: account.id, organizationId: organization.id, name: "Assistant", configuration: defaultBusinessConfiguration() });
    return { account, organization, agent, management: { accountId: account.id, organizationId: organization.id, agentId: agent.id },
      scope: { organizationId: organization.id, agentId: agent.id, principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } } };
  }
  it("requires explicit management acceptance; follows scoped full-text retrieval across conversations", async () => {
    const f = await fixture();
    const initial = await memory.read(f.scope); expect(initial.generation).toBe(0); expect(initial.memories).toEqual([]);
    const candidate = await memory.propose(f.scope, { operationId: randomUUID(), kind: "semantic", content: "I prefer short research reports." });
    expect(candidate.status).toBe("candidate"); expect((await memory.read(f.scope)).memories).toEqual([]);
    const accepted = await memory.mutate(f.management, candidate.id, { action: "accept", operationId: randomUUID(), expectedRevision: 1 });
    expect(accepted.revision).toBe(2);
    const found = await memory.read({ ...f.scope }, "research"); expect(found.memories.map(row => row.id)).toEqual([candidate.id]); expect(found.generation).toBe(1);
    expect((await memory.read(f.scope, "unmatched")).memories).toEqual([]);
    const other = await fixture(); expect((await memory.read(other.scope)).memories).toEqual([]);
    await expect(memory.read({ ...f.scope, principal: other.scope.principal })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(memory.read({ ...f.scope, principal: { kind: "visitor", deploymentId: randomUUID(), sessionId: randomUUID() } })).rejects.toMatchObject({ code: "MEMORY_SCOPE_DENIED" });
  });
  it("injects personal memory only for enabled, human-authorized turns", () => {
    expect(memoryContextAllowed({ memory: { enabled: true } }, "human", ["memory.read"])).toBe(true);
    expect(memoryContextAllowed({ memory: { enabled: false } }, "human", ["memory.read"])).toBe(false);
    expect(memoryContextAllowed({ memory: { enabled: true } }, "visitor", ["memory.read"])).toBe(false);
    expect(memoryContextAllowed({ memory: { enabled: true } }, "channel_customer", ["memory.read"])).toBe(false);
    expect(memoryContextAllowed({ memory: { enabled: true } }, "human", [])).toBe(false);
  });
  it("bounds pre-loop recall and keeps the full record available by id", async () => {
    const f = await fixture();
    for (let index = 0; index < 6; index++) {
      const candidate = await memory.propose(f.scope, { operationId: randomUUID(), kind: "semantic", content: `Report preference ${index} for research summaries.` });
      await memory.mutate(f.management, candidate.id, { action: "accept", operationId: randomUUID(), expectedRevision: 1 });
    }
    const selected = await memory.readForContext(f.scope, "report research preference", 3);
    expect(selected.memories).toHaveLength(3);
    expect(selected.nextOffset).toBe(3);
    const full = await memory.readOne(f.scope, selected.memories[0]!.id);
    expect(full.memory.content).toBe(selected.memories[0]!.content);
  });
  it("deduplicates proposals, detects request conflicts, prevents stale correction and forgotten-memory resurrection", async () => {
    const f = await fixture(), operationId = randomUUID();
    const input = { operationId, kind: "semantic" as const, content: "Always write Spanish responses." };
    const [first, duplicate] = await Promise.all([memory.propose(f.scope, input), memory.propose(f.scope, input)]);
    expect(duplicate.id).toBe(first.id); expect((await memory.read(f.scope)).generation).toBe(0);
    await expect(memory.propose(f.scope, { ...input, content: "Changed request" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await memory.mutate(f.management, first.id, { action: "accept", operationId: randomUUID(), expectedRevision: 1 });
    const corrected = await memory.mutate(f.management, first.id, { action: "correct", operationId: randomUUID(), expectedRevision: 2, content: "Always write English responses." });
    expect(corrected.revision).toBe(3);
    await expect(memory.mutate(f.management, first.id, { action: "correct", operationId: randomUUID(), expectedRevision: 2, content: "stale" })).rejects.toMatchObject({ code: "MEMORY_CONFLICT" });
    await memory.mutate(f.management, first.id, { action: "forget", operationId: randomUUID(), expectedRevision: 3 });
    expect((await memory.read(f.scope)).memories).toEqual([]);
    expect((await memory.propose(f.scope, input)).status).toBe("forgotten");
    for (const content of [input.content, corrected.content]) await expect(memory.propose(f.scope, { ...input, operationId: randomUUID(), content })).rejects.toMatchObject({ code: "MEMORY_SUPPRESSED" });
  });
  it("retains scenario and conflict assertions through exact review and correction without verifying them", async () => {
    const f = await fixture();
    const candidate = await memory.propose(f.scope, { operationId: randomUUID(), kind: "semantic", content: "For the hypothetical pilot, bookings are free.",
      assertion: { context: "hypothetical", conflict: "not_assessed" } });
    await expect(memory.mutate(f.management, candidate.id, { operationId: randomUUID(), expectedRevision: 1, action: "accept", content: "Unreviewed replacement" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const accepted = await memory.mutate(f.management, candidate.id, { operationId: randomUUID(), expectedRevision: 1, action: "accept",
      assertion: { context: "hypothetical", conflict: "reported" } });
    expect(accepted).toMatchObject({ revision: 2, verified: false, assertion: { context: "hypothetical", conflict: "reported" } });
    const before = await memory.read(f.scope), operationId = randomUUID();
    const correction = { operationId, expectedRevision: 2, action: "correct" as const, content: "Current bookings have the quoted fee.",
      assertion: { context: "current" as const, conflict: "resolved" as const } };
    const corrected = await memory.mutate(f.management, candidate.id, correction);
    expect(corrected).toMatchObject({ revision: 3, origin: "user_supplied", verified: false, assertion: correction.assertion });
    expect((await memory.read(f.scope)).generation).toBe(before.generation + 1);
    expect(await memory.mutate(f.management, candidate.id, correction)).toEqual(corrected);
    await expect(memory.mutate(f.management, candidate.id, { ...correction, assertion: { context: "hypothetical", conflict: "reported" } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(memory.mutate(f.management, candidate.id, { ...correction, operationId: randomUUID() })).rejects.toMatchObject({ code: "MEMORY_CONFLICT" });
    const revisions = (await pool.query("SELECT revision,assertion_context,assertion_conflict,assertion_origin,actor FROM agents_platform.memory_revisions WHERE memory_id=$1 ORDER BY revision", [candidate.id])).rows;
    expect(revisions.map(row => [row.revision, row.assertion_context, row.assertion_conflict])).toEqual([[1, "hypothetical", "not_assessed"], [2, "hypothetical", "reported"], [3, "current", "resolved"]]);
    expect(revisions.every(row => row.assertion_origin === "user_supplied" && row.actor)).toBe(true);
  });
  it("serializes namespace generation against dispatch and denies revoked membership", async () => {
    const f = await fixture(), reading = await memory.read(f.scope), db = await pool.connect();
    await db.query("BEGIN"); await db.query("SELECT id FROM agents_platform.memory_scopes WHERE id=$1 FOR SHARE", [reading.scope.id]);
    let completed = false;
    const writing = memory.propose(f.scope, { operationId: randomUUID(), kind: "semantic", content: "Wait behind dispatch claim." }).then(value => { completed = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 50)); expect(completed).toBe(false);
    await db.query("COMMIT"); db.release(); await writing;
    expect((await memory.read(f.scope)).generation).toBe(reading.generation);
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2", [f.organization.id, f.account.id]);
    await expect(memory.read(f.scope)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it("publishes immutable scoped skill revisions and rejects foreign bindings", async () => {
    const f = await fixture(), input = { operationId: randomUUID(), name: "research-report", description: "Write a research report", body: "Cite the original sources." };
    const one = await memory.publishSkill(f.management, input), replay = await memory.publishSkill(f.management, input);
    expect(replay.id).toBe(one.id); expect(one.revision).toBe(1);
    const two = await memory.publishSkill(f.management, { ...input, operationId: randomUUID(), body: "Cite sources and dates." }); expect(two.revision).toBe(2);
    expect((await memory.readSkills(f.scope, [one.id]))[0]?.body).toBe(input.body);
    await expect(pool.query("UPDATE agents_platform.skill_revisions SET body='changed' WHERE id=$1", [one.id])).rejects.toMatchObject({ code: "23514" });
    const other = await fixture(); await expect(memory.readSkills(other.scope, [one.id])).rejects.toMatchObject({ code: "SKILL_SCOPE_DENIED" });
    expect(await memory.listSkills(f.account.id, f.organization.id, f.agent.id)).toHaveLength(2);
  });
  it("deletes owned source history, cancels open tasks and suppresses linked memory without resurrection", async () => {
    const f = await fixture(), config=defaultBusinessConfiguration();
    const management={accountId:f.account.id,organizationId:f.organization.id};
    async function publish(name:string,configuration:AgentConfiguration){const agent=await platform.createAgent({...management,name,configuration});return platform.createVersion({...management,agentId:agent.id,expectedRevision:1});}
    const leaf=await publish("Source deletion leaf",defaultBusinessConfiguration());
    const role=(id:string,versionId:string)=>({id,versionId,tools:[],sourceRevisionIds:[],connectedToolBindingIds:[],maxTokens:null,maxActiveMs:null});
    const middleConfig=defaultBusinessConfiguration();middleConfig.program={id:"tool-directed",version:"4"};middleConfig.tools=[...orchestrationTools];
    middleConfig.capabilities.delegation={enabled:true,maxChildren:2,maxDepth:null,policy:{maxTasks:null,maxStalls:3},bindings:[role("leaf",leaf.id)]};
    const middle=await publish("Source deletion specialist",middleConfig);
    config.program={id:"tool-directed",version:"4"};config.tools=["knowledge.search",...orchestrationTools];
    config.capabilities.delegation={enabled:true,maxChildren:2,maxDepth:null,policy:{maxTasks:null,maxStalls:3},bindings:[role("middle",middle.id),role("completed",leaf.id)]};
    const draft=await platform.updateDraft({...management,agentId:f.agent.id,configuration:config,expectedRevision:1});
    const version=await platform.createVersion({...management,agentId:f.agent.id,expectedRevision:draft.draft_revision});
    const authority={product:"agents" as const,organizationId:f.organization.id,resourceId:f.agent.id,callerClientId:"agents-execution",principal:f.scope.principal};
    const grant={...authority,id:randomUUID(),versionId:version.id,operations:["model.reply" as const,"knowledge.read" as const,"delegation.execute" as const],maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:contextGrantCeiling(config),rootTokenLimit:32000,expiresAt:new Date(Date.now()+60_000).toISOString(),revokedAt:null};
    await platform.createGrant({accountId:f.account.id,grant});
    const prior=await platform.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Earlier permitted work."});
    const operationId=`tool:${prior.task.id}:search`;
    await beginOperation(pool,prior.task.id,{id:operationId,kind:"tool",name:"knowledge.search",request:{query:"earlier"},reservedTokens:0,reservedMs:30000,retrySafe:true});
    await finishOperation(pool,prior.task.id,operationId,"completed",{profile:"lexical-v1",passages:[],omitted:0},null,0);
    await settleTask(pool,prior.task.id,{state:"completed",output:"Earlier answer."});
    const receipt=(await pool.query("SELECT state,output,error_code,accounted_tokens FROM agents_platform.operations WHERE id=$1",[operationId])).rows[0];
    const admitted=await platform.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),conversationId:prior.task.conversation_id,input:"My preference is detailed reports."});
    const unrelated=await platform.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Unrelated conversation."});
    const children=await admitChildren(pool,admitted.task.id,"source-delete:children",{requests:[{bindingId:"middle",brief:"Review this conversation."},{bindingId:"completed",brief:"Finish independent work."}]},{adaptive:true});
    const child=children[0]!,terminal=children[1]!;
    const [grandchild]=await admitChildren(pool,child.taskId,"source-delete:grandchild",{requests:[{bindingId:"leaf",brief:"Review the selected details."}]},{adaptive:true});
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[terminal.taskId]);
    await settleTask(pool,terminal.taskId,{state:"completed",output:"Retained specialist finding."});
    const active=[admitted.task.id,child.taskId,grandchild!.taskId];
    await pool.query(`UPDATE agents_platform.tasks SET state=CASE id WHEN $1::uuid THEN 'waiting_children' WHEN $2::uuid THEN 'waiting_review' ELSE 'reconciling' END,runtime_invocation_id='inv_source_delete_'||id::text WHERE id=ANY($3::uuid[])`,[admitted.task.id,child.taskId,active]);
    await pool.query("UPDATE agents_platform.task_outbox SET dispatched_at=now() WHERE task_id=ANY($1::uuid[])",[[...active,unrelated.task.id]]);
    const proposed=await memory.propose(f.scope,{operationId:randomUUID(),kind:"semantic",content:"Prefer detailed reports.",sourceTaskId:admitted.task.id});
    await memory.mutate(f.management,proposed.id,{operationId:randomUUID(),expectedRevision:1,action:"accept"});
    const other=await fixture();
    await expect(memory.deleteConversationSources(other.management,admitted.task.conversation_id)).rejects.toMatchObject({code:"NOT_FOUND"});
    const childConversation=(await pool.query("SELECT conversation_id FROM agents_platform.tasks WHERE id=$1",[child.taskId])).rows[0].conversation_id;
    await memory.deleteConversationSources({...management,agentId:middle.agent_id},childConversation);
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=ANY($1::uuid[]) ORDER BY id",[[child.taskId,grandchild!.taskId]])).rows.map(row=>row.state)).toEqual(["cancel_requested","cancel_requested"]);
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[admitted.task.id])).rows[0].state).toBe("waiting_children");
    expect((await pool.query("SELECT state,output FROM agents_platform.tasks WHERE id=$1",[terminal.taskId])).rows[0]).toEqual({state:"completed",output:"Retained specialist finding."});
    const deleted=await (async()=>{
      const writer=await pool.connect();let deleting:ReturnType<MemoryStore["deleteConversationSources"]>|undefined,committed=false;
      try{
        await writer.query("BEGIN");await writer.query("SET LOCAL lock_timeout='1s'");
        await writer.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[f.organization.id]);
        let finished=false;deleting=memory.deleteConversationSources(f.management,admitted.task.conversation_id).then(value=>{finished=true;return value;});
        await new Promise(resolve=>setTimeout(resolve,50));expect(finished).toBe(false);
        await writer.query("SELECT id FROM agents_platform.tasks WHERE id=$1 FOR NO KEY UPDATE",[admitted.task.id]);
        await writer.query("COMMIT");committed=true;return await deleting;
      }finally{if(!committed)await writer.query("ROLLBACK");writer.release();await deleting?.catch(()=>{});}
    })();
    expect(deleted.taskIds).toEqual([prior.task.id,admitted.task.id].sort());
    expect((await memory.read(f.scope)).memories).toEqual([]);
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[admitted.task.id])).rows[0].state).toBe("cancel_requested");
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[unrelated.task.id])).rows[0].state).toBe("accepted");
    const cancellationEvents=(await pool.query("SELECT task_id,event_key FROM agents_platform.task_events WHERE task_id=ANY($1::uuid[]) AND kind='cancel_requested' ORDER BY task_id",[active])).rows;
    expect(cancellationEvents).toHaveLength(3);
    await expect(memory.propose(f.scope,{operationId:randomUUID(),kind:"semantic",content:"Fresh inference",sourceTaskId:admitted.task.id})).rejects.toMatchObject({code:"MEMORY_SCOPE_DENIED"});
    const generation=(await memory.read(f.scope)).generation;
    expect(await memory.deleteConversationSources(f.management,admitted.task.conversation_id)).toEqual(deleted);
    expect((await memory.read(f.scope)).generation).toBe(generation);
    expect((await pool.query("SELECT task_id,event_key FROM agents_platform.task_events WHERE task_id=ANY($1::uuid[]) AND kind='cancel_requested' ORDER BY task_id",[active])).rows).toEqual(cancellationEvents);
    const cancelled:string[]=[];
    const options={ingressUrl:"http://runtime.fixture",adminUrl:"http://runtime.fixture",runtimeRoutes:{[SHARED_HARNESS_RELEASE]:{ingressUrl:"http://runtime.fixture",adminUrl:"http://runtime.fixture",workflowName:SHARED_WORKFLOW_NAME}},fetch:(async(url,init)=>{
      const path=new URL(String(url)).pathname;
      if(init?.method==="PATCH"&&path.endsWith("/cancel")){cancelled.push(path);return Response.json({});}
      if(path.startsWith("/restate/output/"))return Response.json({message:"Invocation cancelled"},{status:409});
      throw Error("Source deletion must not dispatch new work");
    }) as typeof fetch};
    for(let n=0;n<3;n++)await dispatchTasksOnce(pool,options);
    expect(cancelled.some(path=>path.includes(admitted.task.id))).toBe(true);expect(cancelled.some(path=>path.includes(child.taskId))).toBe(true);expect(cancelled.some(path=>path.includes(grandchild!.taskId))).toBe(true);
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=ANY($1::uuid[])",[active])).rows.map(row=>row.state)).toEqual(["cancelled","cancelled","cancelled"]);
    expect((await pool.query("SELECT state,output FROM agents_platform.tasks WHERE id=$1",[prior.task.id])).rows[0]).toEqual({state:"completed",output:"Earlier answer."});
    expect((await pool.query("SELECT state,output,error_code,accounted_tokens FROM agents_platform.operations WHERE id=$1",[operationId])).rows[0]).toEqual(receipt);
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[unrelated.task.id])).rows[0].state).toBe("accepted");
  });
  it("expires memory before retrieval and distinguishes backend failure from an empty result", async () => {
    const f = await fixture();
    const candidate = await memory.propose(f.scope, { operationId: randomUUID(), kind: "semantic", content: "Temporary preference", expiresAt: new Date(Date.now()+60_000).toISOString() });
    await memory.mutate(f.management,candidate.id,{action:"accept",operationId:randomUUID(),expectedRevision:1});
    expect((await memory.read(f.scope)).memories).toHaveLength(1);
    await pool.query("UPDATE agents_platform.memories SET expires_at=now()-interval '1 second' WHERE id=$1",[candidate.id]);
    const before = await pool.query("UPDATE agents_platform.memory_scopes SET next_expiry_at=now()-interval '1 second' WHERE organization_id=$1 RETURNING generation",[f.organization.id]);
    const expired = await memory.read(f.scope); expect(expired.memories).toEqual([]); expect(expired.generation).toBe(Number(before.rows[0].generation)+1);
    const unavailable = new MemoryStore(new Pool({ connectionString:"postgresql://invalid:invalid@127.0.0.1:1/postgres",connectionTimeoutMillis:100 }), skillPackageCodec);
    try { await expect(unavailable.read(f.scope)).rejects.toBeDefined(); } finally { await unavailable.pool.end(); }
  });
  it("management HTTP routes preserve candidate/review/revision separation", async () => {
    const f = await fixture(), app = Fastify();
    registerMemoryRoutes(app, { pool, resolveScope: async () => f.management });
    const base = `/api/organizations/${f.organization.id}/agents/${f.agent.id}`;
    const proposal = await app.inject({ method: "POST", url: `${base}/memory`, payload: { operationId: randomUUID(), kind: "semantic", content: "Prefer concise reports." } });
    expect(proposal.statusCode).toBe(200); const value = proposal.json();
    let list = (await app.inject(`${base}/memory`)).json(); expect(list.items).toHaveLength(0); expect(list.candidates).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `${base}/memory/candidates/${value.id}/accept`, payload: { operationId: randomUUID(), expectedRevision: 1 } })).statusCode).toBe(200);
    list = (await app.inject(`${base}/memory`)).json(); expect(list.items).toHaveLength(1); expect(list.candidates).toHaveLength(0);
    await app.close();
  });
});
