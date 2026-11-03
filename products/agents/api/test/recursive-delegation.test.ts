import { contextGrantCeiling } from "../src/execution/models/settings";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultBusinessConfiguration, executionGrantSchema, requestDigest, type AgentConfiguration } from "../src/contracts/contracts";
import { orchestrationContracts, orchestrationTools } from "../src/contracts/orchestration";
import { delegatedConfiguration } from "../src/execution/delegation/scope";
import { activeSpecialistTaskIds, cancelSpecialist, followupSpecialist, specialistResult, specialistStatus, startSpecialist } from "../src/execution/delegation/adaptive";
import { beginOperation, finishOperation, loadExecution, settleTask } from "../src/execution/lifecycle/execution";
import { executeWorkTool, orchestrationInstructionGroups, queueOrchestrationInstruction } from "../src/execution/delegation/progress";
import { PlatformStore } from "../src/product/agents/store";
import { setupPlatformSchema } from "../src/composition/setup";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { publishFixtureSource } from "./knowledge-fixture";
import { EvidenceStore, assertCurrentEvidence, taskEvidenceManifest } from "../src/execution/context/evidence";
import { readTaskTiming } from "../src/execution/lifecycle/timing";

function coordinator(versionId: string, maxDepth: number | null = null, maxTokens: number | null = null): AgentConfiguration {
  const configuration = defaultBusinessConfiguration();
  configuration.program = { id: "tool-directed", version: "4" };
  configuration.tools = [...orchestrationTools];
  configuration.capabilities.delegation = { enabled: true, maxChildren: 2, maxDepth,
    policy: { maxTasks: null, maxStalls: 3 }, bindings: [{ id: "specialist", versionId, tools: [],
      sourceRevisionIds: [], connectedToolBindingIds: [], maxTokens, maxActiveMs: null }] };
  return configuration;
}

describe("recursive publication ceilings", () => {
  it("commissions child memory without exposing its tools directly to the parent", () => {
    const parent = coordinator(randomUUID()), child = defaultBusinessConfiguration();
    parent.memory.enabled = true; child.memory.enabled = true; child.tools = ["memory.search", "memory.propose"];
    if (!parent.capabilities.delegation.enabled) throw Error("Expected delegation");
    const role = parent.capabilities.delegation.bindings[0]!; role.tools = ["memory.search", "memory.propose"];
    const effective = delegatedConfiguration(parent, role, child);
    expect(parent.tools).not.toContain("memory.search"); expect(effective.memory.enabled).toBe(true);
    expect(effective.tools).toEqual(["memory.search", "memory.propose"]);
    expect(delegatedConfiguration(parent, { ...role, tools: [] }, child).memory.enabled).toBe(false);
    expect(delegatedConfiguration({ ...parent, memory: { enabled: false } }, role, child).memory.enabled).toBe(false);
  });
  it("keeps an explicitly finite depth and narrows an overpowered intermediate definition", () => {
    const parent = coordinator(randomUUID(), 1), child = coordinator(randomUUID());
    child.memory.enabled = true;
    const role = parent.capabilities.delegation;
    if (!role.enabled) throw Error("Expected delegation");
    const effective = delegatedConfiguration(parent, role.bindings[0]!, child);
    expect(effective.capabilities.delegation).toEqual({ enabled: false });
    expect(effective.tools).toEqual([]);
    expect(effective.memory.enabled).toBe(false);
  });

  it("retains commissioned descendant connections without making them direct tools", () => {
    const connection = randomUUID(), child = coordinator(randomUUID());
    if (!child.capabilities.delegation.enabled) throw Error("Expected delegation");
    child.capabilities.delegation.bindings[0]!.connectedToolBindingIds = [connection];
    const parent = coordinator(randomUUID(), 3);
    if (!parent.capabilities.delegation.enabled) throw Error("Expected delegation");
    const role = parent.capabilities.delegation.bindings[0]!;
    role.connectedToolBindingIds = [connection];
    const effective = delegatedConfiguration(parent, role, child);
    expect(effective.connectedToolBindingIds).toEqual([]);
    expect(effective.capabilities.delegation.enabled && effective.capabilities.delegation.maxDepth).toBe(2);
    expect(effective.capabilities.delegation.enabled && effective.capabilities.delegation.bindings[0]!.connectedToolBindingIds).toEqual([connection]);
    expect(() => delegatedConfiguration(parent, role, child, { connectedToolBindingIds: [randomUUID()] })).toThrow("published scope");
  });
});

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("recursive delegation with owned PostgreSQL", () => {
  let admin: Pool, pool: Pool, store: PlatformStore;
  const database = `agents_recursive_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href });
    await setupPlatformSchema(pool); store = new PlatformStore(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  async function fixture(depth: number | null = null, childTokens: number | null = null, withSource = false,subtreeTasks:number|null=1,childSource=false) {
    const account = await store.ensureAccount({ issuer: "https://recursive.fixture", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Recursive fixture"), scope = { accountId: account.id, organizationId: org.id };
    await connectFixtureModel(pool, account.id, org.id);
    async function publish(name: string, configuration: AgentConfiguration) {
      const agent = await store.createAgent({ ...scope, name, configuration });
      return store.createVersion({ ...scope, agentId: agent.id, expectedRevision: 1 });
    }
    const source = withSource ? await publishFixtureSource(pool, { ...scope, title: "Launch fact", content: "The confirmed launch is Tuesday.", visibility: "private" }) : undefined;
    const leafConfiguration=defaultBusinessConfiguration();
    if(childSource&&source){leafConfiguration.sourceRevisionIds=[source.id];leafConfiguration.tools=["knowledge.read"];}
    const leaf = await publish("Research", leafConfiguration);
    const middleConfiguration=coordinator(leaf.id);
    if(middleConfiguration.capabilities.delegation.enabled)middleConfiguration.capabilities.delegation.policy!.maxTasks=subtreeTasks;
    if(childSource&&source){middleConfiguration.sourceRevisionIds=[source.id];middleConfiguration.tools.push("knowledge.read");
      if(middleConfiguration.capabilities.delegation.enabled)middleConfiguration.capabilities.delegation.bindings[0]!.sourceRevisionIds=[source.id];}
    const middle = await publish("Content", middleConfiguration);
    const configuration = coordinator(middle.id, depth, childTokens);
    if(source) { configuration.sourceRevisionIds=[source.id]; configuration.tools.push("knowledge.search","knowledge.read"); }
    if(childSource&&source&&configuration.capabilities.delegation.enabled)configuration.capabilities.delegation.bindings[0]!.sourceRevisionIds=[source.id];
    const root = await publish("Assistant", configuration);
    const authority = { product: "agents" as const, organizationId: org.id, resourceId: root.agent_id, callerClientId: "agents-execution",
      principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } };
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: root.id,
      operations: ["model.reply", "knowledge.read", "delegation.execute"], sourceRevisionIds: configuration.sourceRevisionIds,
      maxInputBytes: configuration.model.maxInputBytes, maxOutputTokens: configuration.model.maxOutputTokens,
      maxContextTokens: contextGrantCeiling(configuration), rootTokenLimit: null,
      expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null });
    await store.createGrant({ accountId: account.id, grant });
    const { task } = await store.admitTask({ authority, grantId: grant.id, versionId: root.id, requestKey: randomUUID(), input: "Plan the launch" });
    return { task, scope, root, source, authority, grant };
  }
  const request = { requests: [{ bindingId: "specialist", brief: "Review the launch" }] };

  it("passes explicitly selected earlier material to a child and keeps its evidence current", async () => {
    const f=await fixture(null,null,true),evidence=new EvidenceStore(pool,f.source!.storage);
    const read={id:"handoff:source",kind:"tool" as const,name:"knowledge.read",request:{},reservedTokens:0,reservedMs:1000};
    const admitted=await beginOperation(pool,f.task.id,read);if(admitted.waiting)throw Error("Unexpected capacity wait");
    const chunk=(await pool.query("SELECT id FROM agents_platform.source_chunks WHERE revision_id=$1",[f.source!.id])).rows[0];
    const passage=await evidence.recordChunk(f.task.id,read.id,chunk.id);
    await finishOperation(pool,f.task.id,read.id,"completed",{},null,0,admitted.operation.attempt_id);
    const snapshot=`context:${f.task.id}:handoff`,payload={messages:[{role:"user",content:`${passage.text} [${passage.label}]`}]};
    await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[snapshot,f.task.id,requestDigest(payload),payload]);
    await evidence.supplyContext(f.task.id,snapshot,[passage.reference.id]);
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[f.task.id]);
    await settleTask(pool,f.task.id,{state:"completed",output:"The launch is Tuesday. 🚲"});
    const {task:next}=await store.admitTask({authority:f.authority,grantId:f.grant.id,versionId:f.root.id,conversationId:f.task.conversation_id,requestKey:randomUUID(),input:"Please review the plan."});
    const operation={id:"handoff:start",kind:"delegation" as const,name:"agents.start",request:{},reservedTokens:0,reservedMs:1000};
    const started=await beginOperation(pool,next.id,operation);if(started.waiting)throw Error("Unexpected capacity wait");
    const selected={requests:[{bindingId:"specialist",brief:"Review this material",historyReferences:[{taskId:f.task.id,part:"output" as const}]}]};
    const response=await startSpecialist(pool,next.id,operation.id,selected,evidence),child=response.children[0]!;
    await finishOperation(pool,next.id,operation.id,"completed",response,null,0,started.operation.attempt_id);
    expect((await loadExecution(pool,child.taskId)).task.input).toContain("The launch is Tuesday. 🚲");
    expect((await loadExecution(pool,child.taskId)).task.input).toContain('"complete":true');
    expect((await loadExecution(pool,child.taskId)).task.input).not.toContain("Plan the launch");
    expect((await startSpecialist(pool,next.id,operation.id,selected,evidence)).children[0]!.taskId).toBe(child.taskId);
    await assertCurrentEvidence(pool,child.taskId,await taskEvidenceManifest(pool,child.taskId),{requireActiveTask:false});
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[child.taskId]);
    await settleTask(pool,child.taskId,{state:"completed",output:"Initial review"});
    const followupOperation={...operation,id:"handoff:followup",name:"agents.followup"};
    const followupStarted=await beginOperation(pool,next.id,followupOperation);if(followupStarted.waiting)throw Error("Unexpected capacity wait");
    const continued=(await followupSpecialist(pool,next.id,followupOperation.id,{taskId:child.taskId,brief:"Review the exact wording",historyReferences:[{taskId:f.task.id,part:"output"}]},evidence)).children[0]!;
    const continuedTask=(await loadExecution(pool,continued.taskId)).task;
    expect(continuedTask.input).toContain("The launch is Tuesday. 🚲");expect(continuedTask.conversation_id).toBe(child.conversationId);
    await assertCurrentEvidence(pool,continued.taskId,await taskEvidenceManifest(pool,continued.taskId),{requireActiveTask:false});
    const other=await fixture();
    const denied={...selected,requests:[{...selected.requests[0]!,historyReferences:[{taskId:other.task.id,part:"output" as const}]}]};
    const rejected={...operation,id:"handoff:foreign"};await beginOperation(pool,next.id,rejected);
    await expect(startSpecialist(pool,next.id,rejected.id,denied,evidence)).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
    await f.source!.knowledge.setPolicy(f.scope,f.source!.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
    await expect(assertCurrentEvidence(pool,child.taskId,await taskEvidenceManifest(pool,child.taskId),{requireActiveTask:false})).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
    await expect(assertCurrentEvidence(pool,continued.taskId,await taskEvidenceManifest(pool,continued.taskId),{requireActiveTask:false})).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  },30000);

  it("admits the same protocol at three levels, keeps branch controls and private directions separate", async () => {
    const f = await fixture(null,null,true,1,true);
    const first = (await startSpecialist(pool, f.task.id, "recursive:child", request)).children[0]!;
    const second = (await startSpecialist(pool, first.taskId, "recursive:grandchild", request)).children[0]!;
    const child = await loadExecution(pool, first.taskId), grandchild = await loadExecution(pool, second.taskId);
    expect(child.task.depth).toBe(1); expect(grandchild.task.depth).toBe(2);
    expect(child.task.root_task_id).toBe(f.task.id); expect(grandchild.task.root_task_id).toBe(f.task.id);
    expect(grandchild.task.work_id).toBe(f.task.work_id);
    expect(grandchild.task.harness_release).toBe("product-capabilities-v15");
    expect(grandchild.task.conversation_id).not.toBe(child.task.conversation_id);
    await expect(startSpecialist(pool,first.taskId,"recursive:excess-subtree",request)).rejects.toMatchObject({code:"SPECIALIST_TASK_LIMIT"});
    await expect(specialistStatus(pool, f.task.id, [second.taskId])).rejects.toMatchObject({ code: "SPECIALIST_SCOPE_DENIED" });
    await queueOrchestrationInstruction(pool, f.task.id, { requestKey: randomUUID(), instruction: "The launch is Tuesday, not Monday." });
    const corrections = await orchestrationInstructionGroups(pool, first.taskId, []);
    expect(corrections).toEqual([]);
    await queueOrchestrationInstruction(pool,first.taskId,{requestKey:randomUUID(),instruction:"Check the supplied launch wording."});
    expect((await orchestrationInstructionGroups(pool,first.taskId,[]))[0]?.messages[0]?.content).toContain("Check the supplied launch wording");
    await expect(pool.query("UPDATE agents_platform.tasks SET depth=1 WHERE id=$1", [second.taskId])).rejects.toMatchObject({ code: "23514" });
    const evidence=new EvidenceStore(pool,f.source!.storage),operation={id:"result:source",kind:"tool" as const,name:"knowledge.read",request:{},reservedTokens:0,reservedMs:1000};
    const admitted=await beginOperation(pool,first.taskId,operation);if(admitted.waiting)throw Error("Unexpected capacity wait");
    const chunk=(await pool.query("SELECT id FROM agents_platform.source_chunks WHERE revision_id=$1",[f.source!.id])).rows[0];
    const passage=await evidence.recordChunk(first.taskId,operation.id,chunk.id);
    await finishOperation(pool,first.taskId,operation.id,"completed",{},null,0,admitted.operation.attempt_id);
    const snapshot=`context:${first.taskId}:0`,payload={messages:[{role:"user",content:`${passage.text} [${passage.label}]`}]};
    await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[snapshot,first.taskId,requestDigest(payload),payload]);
    await evidence.supplyContext(first.taskId,snapshot,[passage.reference.id]);
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[second.taskId]);
    await settleTask(pool,second.taskId,{state:"completed",output:"Reviewed"});
    await evidence.derive(first.taskId,"child_result",first.taskId);
    await settleTask(pool,first.taskId,{state:"completed",output:`The launch is Tuesday. [${passage.label}]`});
    expect((await specialistResult(pool,f.task.id,{taskId:first.taskId})).metadata?.sources.items)
      .toEqual([expect.objectContaining({evidenceId:passage.reference.id,citation:`[${passage.label}]`,taskId:first.taskId,kind:"source"})]);
  });

  it("recovers a prior grandchild through a recursive specialist follow-up without restoring control or withdrawn sources",async()=>{
    const f=await fixture(null,null,true,null),evidence=new EvidenceStore(pool,f.source!.storage);
    const read={id:"followup:source",kind:"tool" as const,name:"knowledge.read",request:{},reservedTokens:0,reservedMs:1000};
    const admitted=await beginOperation(pool,f.task.id,read);if(admitted.waiting)throw Error("Unexpected capacity wait");
    const chunk=(await pool.query("SELECT id FROM agents_platform.source_chunks WHERE revision_id=$1",[f.source!.id])).rows[0];
    const passage=await evidence.recordChunk(f.task.id,read.id,chunk.id);
    await finishOperation(pool,f.task.id,read.id,"completed",{},null,0,admitted.operation.attempt_id);
    const snapshot=`context:${f.task.id}:0`,payload={messages:[{role:"user",content:`${passage.text} [${passage.label}]`}]};
    await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[snapshot,f.task.id,requestDigest(payload),payload]);
    await evidence.supplyContext(f.task.id,snapshot,[passage.reference.id]);
    const first=(await startSpecialist(pool,f.task.id,"followup:child",request)).children[0]!;
    const grandchild=(await startSpecialist(pool,first.taskId,"followup:grandchild",request)).children[0]!;
    const workRecord={objective:"Review launch findings",steps:[{id:"facts",title:"Confirm launch wording",state:"blocked"}],questions:["What is the booking contact?"],evidenceTaskIds:[]};
    await executeWorkTool(pool,first.taskId,"result:work","work.update",{expectedRevision:0,record:workRecord});
    for(let index=0;index<10;index++){
      const reviewId=`review-${String(index).padStart(2,"0")}`,operationId=`result:effect:${index}`,state=index===9?"uncertain":"saved";
      await pool.query("INSERT INTO agents_platform.product_review_projections(review_id,task_id,payload_digest,state,projection,product) VALUES($1,$2,$3,$4,$5,'growth')",
        [reviewId,first.taskId,requestDigest(index),state,{operationId,privatePayload:"must remain private"}]);
    }
    for(const taskId of [grandchild.taskId,first.taskId]){
      await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[taskId]);
      await evidence.derive(taskId,"child_result",taskId);
      await settleTask(pool,taskId,{state:"completed",output:"The confirmed launch is Tuesday."});
    }
    const result=await specialistResult(pool,f.task.id,{taskId:first.taskId});
    expect(orchestrationContracts["agents.result"].output.safeParse(result).success).toBe(true);
    expect(result.metadata).toMatchObject({findings:{correctness:"not_assessed",origin:"agent_reported"},
      coverage:{assessment:"not_assessed",work:{revision:1,origin:"agent_reported",record:workRecord}},
      sources:{items:[]},effects:{nextOffset:8},artifacts:{items:[],nextOffset:null}});
    const nextMetadata=await specialistResult(pool,f.task.id,{taskId:first.taskId,effectOffset:result.metadata!.effects.nextOffset!,sourceOffset:1});
    expect(nextMetadata.output).toBe(result.output);
    expect(nextMetadata.metadata!.sources.items).toEqual([]);
    expect(nextMetadata.metadata!.effects).toMatchObject({nextOffset:null,items:[{id:"review-08",confirmation:"confirmed"},{id:"review-09",confirmation:"unknown"}]});
    expect(JSON.stringify(result.metadata)+JSON.stringify(nextMetadata.metadata)).not.toContain("must remain private");
    const next=(await followupSpecialist(pool,f.task.id,"followup:review",{taskId:first.taskId,brief:"Review the earlier findings."})).children[0]!;
    expect(next.conversationId).toBe(first.conversationId);
    expect((await specialistStatus(pool,next.taskId)).children.map(item=>item.taskId)).toContain(grandchild.taskId);
    expect((await specialistResult(pool,next.taskId,{taskId:grandchild.taskId})).output).toContain("Tuesday");
    await expect(cancelSpecialist(pool,next.taskId,grandchild.taskId)).rejects.toMatchObject({code:"SPECIALIST_SCOPE_DENIED"});
    const sibling=(await startSpecialist(pool,f.task.id,"followup:sibling",request)).children[0]!;
    await expect(specialistResult(pool,sibling.taskId,{taskId:grandchild.taskId})).rejects.toMatchObject({code:"SPECIALIST_SCOPE_DENIED"});
    const fresh=(await startSpecialist(pool,next.taskId,"followup:fresh-grandchild",request)).children[0]!;
    expect((await loadExecution(pool,fresh.taskId)).task).toMatchObject({parent_task_id:next.taskId,depth:2,root_task_id:f.task.id,work_id:f.task.work_id});
    const join={...read,id:"followup:join",name:"agents.result",request:{taskId:grandchild.taskId}};
    const joined=await beginOperation(pool,next.taskId,join);if(joined.waiting)throw Error("Unexpected capacity wait");
    await evidence.joinChild(next.taskId,join.id,grandchild.taskId);
    await finishOperation(pool,next.taskId,join.id,"completed",{},null,0,joined.operation.attempt_id);
    const manifest=await taskEvidenceManifest(pool,next.taskId);await assertCurrentEvidence(pool,next.taskId,manifest);
    await f.source!.knowledge.setPolicy(f.scope,f.source!.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
    await expect(specialistResult(pool,next.taskId,{taskId:grandchild.taskId})).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
    await expect(assertCurrentEvidence(pool,next.taskId,manifest)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  },15000);

  it("cancels only the selected subtree and keeps intermediate settlement pending until descendants settle", async () => {
    const f = await fixture();
    const first = (await startSpecialist(pool, f.task.id, "cancel:children", { requests: [request.requests[0]!, request.requests[0]!] })).children;
    const grandchild = (await startSpecialist(pool, first[0]!.taskId, "cancel:grandchild", request)).children[0]!;
    await cancelSpecialist(pool, f.task.id, first[0]!.taskId);
    expect((await loadExecution(pool, grandchild.taskId)).task.state).toBe("cancel_requested");
    expect((await loadExecution(pool, first[1]!.taskId)).task.state).toBe("accepted");
    await settleTask(pool, first[0]!.taskId, { state: "cancelled" });
    expect((await loadExecution(pool, first[0]!.taskId)).task.pending_outcome).toEqual({ state: "cancelled" });
    await settleTask(pool, grandchild.taskId, { state: "cancelled" });
    await settleTask(pool, first[0]!.taskId, { state: "cancelled" });
    expect((await loadExecution(pool, first[0]!.taskId)).task.state).toBe("cancelled");
  });

  it("enforces a finite intermediate token allowance across its own and grandchild operations", async () => {
    const f = await fixture(null, 8192);
    const child = (await startSpecialist(pool, f.task.id, "budget:child", request)).children[0]!;
    const grandchild = (await startSpecialist(pool, child.taskId, "budget:grandchild", request)).children[0]!;
    const operation = { id: "budget:parent-model", kind: "model" as const, name: "model.generate", request: { input: "draft" }, reservedTokens: 5000, reservedMs: 1000 };
    const admitted = await beginOperation(pool, child.taskId, operation);
    if (admitted.waiting) throw Error("Unexpected capacity wait");
    await expect(beginOperation(pool, grandchild.taskId, { ...operation, id: "budget:grandchild-model" }))
      .rejects.toMatchObject({ code: "TASK_TOKEN_LIMIT" });
    await finishOperation(pool, child.taskId, operation.id, "completed", { finding: "Done" }, null, 100, admitted.operation.attempt_id);
    const next = await beginOperation(pool, grandchild.taskId, { ...operation, id: "budget:grandchild-after-receipt" });
    expect(next.waiting).not.toBe(true);
    expect((await pool.query("SELECT child_reserved_tokens FROM agents_platform.execution_roots WHERE root_task_id=$1", [f.task.id])).rows[0].child_reserved_tokens).toBe(0);
  });

  it("lets a configured customer agent delegate without inheriting staff identity and fences deployment revocation", async () => {
    const f = await fixture();
    const origin = "https://customer.recursive.test";
    const deployment = await store.publishWebsite({ ...f.scope, agentId: f.root.agent_id, versionId: f.root.id, allowedOrigins: [origin] });
    const sessionId = randomUUID();
    await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)",
      [sessionId, deployment.id, randomUUID().replaceAll("-", "").repeat(2), origin]);
    const grant = await store.createWebsiteGrant({ deploymentId: deployment.id, sessionId, origin });
    const { task } = await store.admitTask({ authority: grant, grantId: grant.id, versionId: f.root.id, requestKey: randomUUID(), input: "Please check that answer" });
    const child = (await startSpecialist(pool, task.id, "customer:child", request)).children[0]!;
    const grandchild = (await startSpecialist(pool, child.taskId, "customer:grandchild", request)).children[0]!;
    const execution = await loadExecution(pool, grandchild.taskId);
    expect(execution.task.principal).toEqual(grant.principal);
    expect(execution.configuration.memory.enabled).toBe(false);
    await pool.query("UPDATE agents_platform.website_deployments SET revoked_at=now() WHERE id=$1", [deployment.id]);
    await expect(beginOperation(pool, grandchild.taskId, { id: "customer:revoked", kind: "model", name: "model.generate", request: {}, reservedTokens: 20, reservedMs: 1000 }))
      .rejects.toMatchObject({ code: "DEPLOYMENT_SCOPE_DENIED" });
  });

  it("withdraws inherited original evidence through a grandchild result and both joins", async () => {
    const f = await fixture(null, null, true), evidence = new EvidenceStore(pool, f.source!.storage);
    const read = { id: "source:read", kind: "tool" as const, name: "knowledge.read", request: {}, reservedTokens: 0, reservedMs: 1000 };
    const admitted = await beginOperation(pool, f.task.id, read);
    if(admitted.waiting)throw Error("Unexpected capacity wait");
    const chunk=(await pool.query("SELECT id FROM agents_platform.source_chunks WHERE revision_id=$1",[f.source!.id])).rows[0];
    const passage=await evidence.recordChunk(f.task.id,read.id,chunk.id);
    await finishOperation(pool,f.task.id,read.id,"completed",{},null,0,admitted.operation.attempt_id);
    const snapshot=`context:${f.task.id}:0`,payload={messages:[{role:"user",content:`${passage.text} [${passage.label}]`}]};
    await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[snapshot,f.task.id,requestDigest(payload),payload]);
    await evidence.supplyContext(f.task.id,snapshot,[passage.reference.id]);
    for(let index=0;index<65;index++)await evidence.derive(f.task.id,"summary",`retained:summary:${index}`);
    const child=(await startSpecialist(pool,f.task.id,"source:child",request)).children[0]!;
    const grandchild=(await startSpecialist(pool,child.taskId,"source:grandchild",request)).children[0]!;
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[grandchild.taskId]);
    await evidence.derive(grandchild.taskId,"child_result",grandchild.taskId);
    await settleTask(pool,grandchild.taskId,{state:"completed",output:"Tuesday launch confirmed"});
    async function join(parentId:string,childId:string) {
      const operation={...read,id:`join:${parentId}`,name:"agents.result",request:{taskId:childId}};
      const admitted=await beginOperation(pool,parentId,operation);if(admitted.waiting)throw Error("Unexpected capacity wait");
      await evidence.joinChild(parentId,operation.id,childId);
      await finishOperation(pool,parentId,operation.id,"completed",{},null,0,admitted.operation.attempt_id);
    }
    await join(child.taskId,grandchild.taskId);
    await evidence.derive(child.taskId,"child_result",child.taskId);
    await settleTask(pool,child.taskId,{state:"completed",output:"Tuesday launch confirmed by research"});
    await join(f.task.id,child.taskId);
    const manifest=await taskEvidenceManifest(pool,f.task.id);
    await assertCurrentEvidence(pool,f.task.id,manifest);
    await f.source!.knowledge.setPolicy(f.scope,f.source!.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
    await expect(assertCurrentEvidence(pool,f.task.id,manifest)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
    await expect(assertCurrentEvidence(pool,grandchild.taskId,await taskEvidenceManifest(pool,grandchild.taskId),{requireActiveTask:false}))
      .rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  },30000);

  it("freezes accepted-to-settled duration at the native receipt after later task metadata updates", async () => {
    const f=await fixture(),child=(await startSpecialist(pool,f.task.id,"timing:child",request)).children[0]!;
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[child.taskId]);
    const running=(await loadExecution(pool,child.taskId)).task;
    const live=await readTaskTiming(pool,running);
    expect(live.elapsedMs).toBeGreaterThanOrEqual(0);expect(live.workId).toBe(f.task.id);
    expect(live.workElapsedMs).toBeGreaterThanOrEqual(live.elapsedMs!);
    await settleTask(pool,child.taskId,{state:"completed",output:"Done"});
    const completed=await readTaskTiming(pool,(await loadExecution(pool,child.taskId)).task);
    await pool.query("UPDATE agents_platform.tasks SET updated_at=now()+interval '1 hour' WHERE id=$1",[child.taskId]);
    const later=await readTaskTiming(pool,(await loadExecution(pool,child.taskId)).task);
    expect(later.elapsedMs).toBe(completed.elapsedMs);
    expect(later.workElapsedMs).toBe(completed.workElapsedMs);
    expect(later.finishedAt).toBe(completed.finishedAt);
  });

  it("keeps active work visible after a full page of generated completed specialist history",async()=>{
    const f=await fixture(),archived=(await startSpecialist(pool,f.task.id,"status:original",request)).children[0]!;
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[archived.taskId]);
    await settleTask(pool,archived.taskId,{state:"completed",output:"Historical finding"});
    await pool.query(`WITH source AS(SELECT to_jsonb(t) AS value FROM agents_platform.tasks t WHERE id=$1),
      generated AS(SELECT jsonb_populate_record(NULL::agents_platform.tasks,value||jsonb_build_object(
        'id',gen_random_uuid(),'request_key','status_archive:'||n,'turn_sequence',n+1,
        'delegation_operation_id','status:archive:'||n,'runtime_invocation_id',NULL)) AS task
        FROM source CROSS JOIN generate_series(1,65)n)
      INSERT INTO agents_platform.tasks SELECT (task).* FROM generated`,[archived.taskId]);
    await pool.query(`INSERT INTO agents_platform.delegations(parent_task_id,operation_id,slot,child_task_id,binding_id,input_manifest,request_digest)
      SELECT t.parent_task_id,t.delegation_operation_id,0,t.id,d.binding_id,d.input_manifest,d.request_digest
      FROM agents_platform.tasks t JOIN agents_platform.delegations d ON d.child_task_id=$1
      WHERE t.parent_task_id=$2 AND t.request_key LIKE 'status_archive:%'`,[archived.taskId,f.task.id]);
    const active=(await startSpecialist(pool,f.task.id,"status:active",request)).children[0]!;
    const page=await specialistStatus(pool,f.task.id);
    expect(page.children[0]!.taskId).toBe(active.taskId);expect(page.nextOffset).toBe(64);
    expect(await activeSpecialistTaskIds(pool,f.task.id)).toEqual([active.taskId]);
  });
});
