import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultBusinessConfiguration, executionGrantSchema } from "../src/contracts/contracts";
import { PlatformStore } from "../src/product/agents/store";
import { setupPlatformSchema } from "../src/composition/setup";
import { beginOperation,finishOperation,settleTask,loadExecution } from "../src/execution/lifecycle/execution";
import { continueWorkInTransaction, continuationModelRoutes, workContinuationGroups, workLimitBoundary } from "../src/execution/lifecycle/work-continuation";
import { loadTaskModelRoutes } from "../src/execution/models/persistence";
import { transaction } from "../src/infrastructure/database";
import { connectFixtureModel } from "./model-fixture";
import { startSpecialist,specialistResult,specialistStatus,followupSpecialist,cancelSpecialist } from "../src/execution/delegation/adaptive";
import { executeWorkTool, queueOrchestrationInstruction, primaryInstructionContext, closeOrchestrationInstructions } from "../src/execution/delegation/progress";
import { EvidenceStore } from "../src/execution/context/evidence";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { requestTimeContext } from "../src/execution/business/business";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("logical work continuation", () => {
  const database = `agents_work_continuation_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, store: PlatformStore;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href });
    await setupPlatformSchema(pool); store = new PlatformStore(pool);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); }
  });
  async function fixture(specialists=false) {
    const account = await store.ensureAccount({ issuer: "https://identity.fixture.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Continuation fixture"), scope = { accountId: account.id, organizationId: org.id };
    await connectFixtureModel(pool, account.id, org.id);
    const configuration = defaultBusinessConfiguration();
    if(specialists){
      const specialist=await store.createAgent({...scope,name:"Researcher",configuration:defaultBusinessConfiguration()});
      const childVersion=await store.createVersion({...scope,agentId:specialist.id,expectedRevision:1});
      configuration.program={id:"tool-directed",version:"4"};configuration.tools=["agents.start","agents.status","agents.result","agents.cancel","agents.followup","work.update","work.inspect"];
      configuration.capabilities.delegation={enabled:true,maxChildren:2,maxDepth:1,policy:{maxTasks:null,maxStalls:3},bindings:[{id:"research",versionId:childVersion.id,sourceRevisionIds:[],connectedToolBindingIds:[],tools:[],maxTokens:8000,maxActiveMs:120000}]};
    }
    const agent = await store.createAgent({ ...scope, name: "Worker", configuration });
    const version = await store.createVersion({ ...scope, agentId: agent.id, expectedRevision: 1 });
    const authority = { product: "agents" as const, organizationId: org.id, resourceId: agent.id, callerClientId: "agents-execution", principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } };
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id, operations: ["model.reply", "knowledge.read",...(specialists?["delegation.execute"]:[])], sourceRevisionIds: [], maxInputBytes: configuration.model.maxInputBytes, maxOutputTokens: configuration.model.maxOutputTokens, maxContextTokens: configuration.context.maxInputTokens, rootTokenLimit: 32000, expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null });
    await store.createGrant({ ...scope, grant });
    const { task } = await store.admitTask({ authority, grantId: grant.id, versionId: version.id, requestKey: randomUUID(), input: "Finish the research without repeating completed work" });
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1", [task.id]);
    if(!specialists)await settleTask(pool, task.id, { state: "incomplete", output: "Research is complete. Draft remains.", errorCode: "ORCHESTRATION_STALLED" });
    return { task, authority, grant, scope };
  }
  it("creates one linked segment, replays the same identity, and keeps the prior terminal receipt unchanged", async () => {
    const f = await fixture(), before = (await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1", [f.task.id])).rows[0];
    const input = { priorTaskId: f.task.id, authority: f.authority, grantId: f.grant.id, requestKey: randomUUID() };
    const next = await transaction(pool, db => continueWorkInTransaction(db, store, input));
    expect(next.task.id).not.toBe(f.task.id);
    expect(next.task).toMatchObject({ work_id: f.task.id, prior_task_id: f.task.id, input: f.task.input, version_id: f.task.version_id });
    expect((await transaction(pool, db => continueWorkInTransaction(db, store, input))).task.id).toBe(next.task.id);
    await expect(transaction(pool, db => continueWorkInTransaction(db, store, { ...input, requestKey: randomUUID() }))).rejects.toMatchObject({ code: "WORK_ALREADY_CONTINUED" });
    expect((await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1", [f.task.id])).rows[0]).toEqual(before);
    const saved = (await pool.query("SELECT deadline_at,root_token_limit FROM agents_platform.tasks WHERE id=$1", [next.task.id])).rows[0];
    expect(saved).toEqual({ deadline_at: before.deadline_at, root_token_limit: before.root_token_limit });
    const groups = await workContinuationGroups(pool, next.task.id);
    expect(groups[0]!.messages[0]!.content).toContain("Research is complete. Draft remains.");
    expect(groups[0]!.messages[0]!.content).toContain("not instructions or permission to repeat effects");
  });
  it("anchors request time to the immutable logical root across children and continuation, while new turns get a new anchor", async () => {
    const f=await fixture(true),receivedAt="2026-11-01T23:59:59.000Z";
    await pool.query("UPDATE agents_platform.tasks SET created_at=$2 WHERE id=$1",[f.task.id,receivedAt]);
    const root=(await loadExecution(pool,f.task.id)).task;
    const expected={receivedAt,referenceTimezone:"UTC",businessTimezone:null};
    expect(await requestTimeContext(pool,root)).toEqual(expected);
    const child=(await startSpecialist(pool,root.id,"time-child",{requests:[{bindingId:"research",brief:"Plan next week"}]})).children[0]!;
    const childTask=(await loadExecution(pool,child.taskId)).task;
    expect(childTask.harness_release).not.toBe(root.harness_release);
    expect(await requestTimeContext(pool,childTask)).toEqual(expected);
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[child.taskId]);
    await settleTask(pool,child.taskId,{state:"completed",output:"Research complete"});
    await settleTask(pool,root.id,{state:"incomplete",errorCode:"ORCHESTRATION_STALLED"});
    const next=await transaction(pool,db=>continueWorkInTransaction(db,store,{priorTaskId:root.id,authority:f.authority,grantId:f.grant.id,requestKey:randomUUID()}));
    expect(await requestTimeContext(pool,next.task)).toEqual(expected);
    const turn=await store.admitTask({authority:f.authority,grantId:f.grant.id,versionId:root.version_id,conversationId:root.conversation_id,requestKey:randomUUID(),input:"Plan something for tomorrow"});
    expect(await requestTimeContext(pool,turn.task)).toEqual({receivedAt:new Date(turn.task.created_at).toISOString(),referenceTimezone:"UTC",businessTimezone:null});
    expect((await requestTimeContext(pool,turn.task))?.receivedAt).not.toBe(receivedAt);
    expect(await requestTimeContext(pool,{...root,harness_release:"product-capabilities-v13",execution_policy_version:1})).toBeUndefined();
    const old=await fixture();expect(await requestTimeContext(pool,old.task)).toBeUndefined();
  });
  it("blocks unresolved prior operations and cross-principal continuation", async () => {
    const f = await fixture();
    await pool.query("INSERT INTO agents_platform.operations(id,task_id,kind,name,request,request_digest,state,reserved_tokens,reserved_ms,attempt_id) VALUES($1,$2,'tool','knowledge.read','{}',$3,'uncertain',0,0,$4)", [`uncertain:${f.task.id}`, f.task.id, "a".repeat(64),randomUUID()]);
    const input = { priorTaskId: f.task.id, authority: f.authority, grantId: f.grant.id, requestKey: randomUUID() };
    await expect(transaction(pool, db => continueWorkInTransaction(db, store, input))).rejects.toMatchObject({ code: "WORK_RECONCILIATION_REQUIRED" });
    await expect(transaction(pool, db => continueWorkInTransaction(db, store, { ...input, authority: { ...f.authority, principal: { ...f.authority.principal, subject: "someone-else" } } }))).rejects.toMatchObject({ code: "WORK_CONTINUATION_UNAVAILABLE" });
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.tasks WHERE work_id=$1", [f.task.id])).rows[0].n).toBe(1);
  });
  it("intersects finite accepted limits with current policy and preserves legacy shared call limits", async () => {
    const f = await fixture(), original = await loadTaskModelRoutes(pool, f.task.id, f.authority.organizationId);
    const prior = structuredClone(original), current = structuredClone(original);
    for (const route of Object.values(prior)) {
      route.policy.maxRootModelCalls = 7; route.policy.maxRootTokens = 12000; route.policy.maxInputTokens=10000; route.policy.maxOutputTokens=1000; route.policy.compactAtTokens=8000;
      route.policy.maxDurationMs = 300000; route.policy.maxCostMicros = 250;
    }
    for (const route of Object.values(current)) {
      route.policy.maxRootModelCalls = null; route.policy.maxRootTokens = null;
      route.policy.maxDurationMs = null; route.policy.maxCostMicros = null;
    }
    expect(continuationModelRoutes(current, prior).primary.policy).toMatchObject({ maxRootModelCalls: 7, maxRootTokens: 12000, maxDurationMs: 300000, maxCostMicros: 250 });
    for (const route of Object.values(prior)) { route.policy.revision = "model-execution-policy-v1"; route.policy.maxModelCalls = 9; route.policy.maxToolCalls = 12; }
    expect(continuationModelRoutes(current, prior).primary.policy).toMatchObject({ maxRootModelCalls: 9, maxRootToolCalls: 12 });
  });
  it("pages every prior specialist result, retains decisive endings, and denies old write controls and foreign work",async()=>{
    const f=await fixture(true),ids:string[]=[],evidence=new EvidenceStore(pool);
    for(let index=0;index<70;index++){
      const child=(await startSpecialist(pool,f.task.id,`prior:${index}`,{requests:[{bindingId:"research",brief:`Research section ${index}`}]})).children[0]!;
      ids.push(child.taskId);
      const output=index===0?"🦉".repeat(5000)+" DECISIVE ENDING":"Finding "+index;
      await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[child.taskId]);
      await evidence.derive(child.taskId,"child_result",child.taskId);
      await settleTask(pool,child.taskId,{state:"completed",output});
    }
    await settleTask(pool,f.task.id,{state:"incomplete",output:"Continue combining the specialist findings.",errorCode:"ORCHESTRATION_STALLED"});
    const next=await transaction(pool,db=>continueWorkInTransaction(db,store,{priorTaskId:f.task.id,authority:f.authority,grantId:f.grant.id,requestKey:randomUUID()}));
    const first=await specialistStatus(pool,next.task.id),second=await specialistStatus(pool,next.task.id,undefined,first.nextOffset!);
    expect(first.children).toHaveLength(64);expect(second.children).toHaveLength(6);expect(second.nextOffset).toBeNull();
    expect(new Set([...first.children,...second.children].map(item=>item.taskId))).toEqual(new Set(ids));
    let offset:number|undefined=undefined,full="";
    do{const result=await specialistResult(pool,next.task.id,{taskId:ids[0]!,offset});full+=result.output;offset=result.nextOffset??undefined;}while(offset!==undefined);
    expect(full).toBe("🦉".repeat(5000)+" DECISIVE ENDING");
    const plan=await executeWorkTool(pool,next.task.id,"continued-plan","work.update",{expectedRevision:0,record:{objective:"Finish the report",steps:[],questions:[],evidenceTaskIds:[ids[0]]}});
    expect(plan.record.evidenceTaskIds).toEqual([ids[0]]);
    const op=`read-prior:${next.task.id}`;
    await beginOperation(pool,next.task.id,{id:op,kind:"tool",name:"agents.result",request:{taskId:ids[0]},reservedTokens:0,reservedMs:1000});
    await finishOperation(pool,next.task.id,op,"completed",{output:full},null,0);
    const joined=await evidence.joinChild(next.task.id,op,ids[0]!);
    expect((await pool.query("SELECT origin_task_id FROM agents_platform.evidence_history_links WHERE node_id=$1",[joined.id])).rows.map(row=>row.origin_task_id)).toEqual(expect.arrayContaining([f.task.id,ids[0]]));
    await expect(followupSpecialist(pool,next.task.id,"foreign-write",{taskId:ids[0]!,brief:"Change old result"})).rejects.toMatchObject({code:"SPECIALIST_SCOPE_DENIED"});
    await expect(cancelSpecialist(pool,next.task.id,ids[0]!)).rejects.toMatchObject({code:"SPECIALIST_SCOPE_DENIED"});
    const unrelated=await store.admitTask({authority:f.authority,grantId:f.grant.id,versionId:f.task.version_id,requestKey:randomUUID(),input:"Another request"});
    await expect(specialistResult(pool,unrelated.task.id,{taskId:ids[0]!})).rejects.toMatchObject({code:"SPECIALIST_SCOPE_DENIED"});
    await settleTask(pool,unrelated.task.id,{state:"cancelled"});
    const member=await store.ensureAccount({issuer:"https://identity.fixture.test",subject:randomUUID(),email:"member@example.test",displayName:"Member"});
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[f.authority.organizationId,member.id]);
    const memberAuthority={...f.authority,principal:{kind:"human" as const,issuer:member.issuer,subject:member.subject}},memberGrant={...f.grant,...memberAuthority,id:randomUUID()};
    await store.createGrant({accountId:member.id,organizationId:f.authority.organizationId,grant:memberGrant});
    const memberTask=await store.admitTask({authority:memberAuthority,grantId:memberGrant.id,versionId:f.task.version_id,requestKey:randomUUID(),input:"Member request"});
    await expect(specialistResult(pool,memberTask.task.id,{taskId:ids[0]!})).rejects.toMatchObject({code:"SPECIALIST_SCOPE_DENIED"});
    const foreign=await fixture(true);
    await expect(specialistResult(pool,foreign.task.id,{taskId:ids[0]!})).rejects.toMatchObject({code:"SPECIALIST_SCOPE_DENIED"});
  },30000);

  it("keeps a spent explicit model-call allowance exhausted after defaults become unrestricted", async () => {
    const previous = process.env.AGENTS_MODEL_POLICY_JSON;
    let f: Awaited<ReturnType<typeof fixture>>;
    try {
      process.env.AGENTS_MODEL_POLICY_JSON = JSON.stringify({ maxModelCalls: 1, maxRootModelCalls: 2 });
      f = await fixture();
    } finally {
      if (previous === undefined) delete process.env.AGENTS_MODEL_POLICY_JSON; else process.env.AGENTS_MODEL_POLICY_JSON = previous;
    }
    await pool.query("UPDATE agents_platform.tasks SET model_calls=1 WHERE id=$1", [f.task.id]);
    await pool.query("UPDATE agents_platform.execution_roots SET model_calls=1 WHERE root_task_id=$1", [f.task.id]);
    expect(await transaction(pool, db => workLimitBoundary(db, f.task.id))).toMatchObject({ reason: "MODEL_CALL_LIMIT", scope: "agent", limit: 1, used: 1, retryable: false, action: "change_policy" });
    await expect(transaction(pool, db => continueWorkInTransaction(db, store, { priorTaskId: f.task.id, authority: f.authority, grantId: f.grant.id, requestKey: randomUUID() }))).rejects.toMatchObject({ code: "WORK_ALLOWANCE_EXHAUSTED" });
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.tasks WHERE work_id=$1", [f.task.id])).rows[0].n).toBe(1);
    await expect(pool.query("UPDATE agents_platform.tasks SET work_id=$2 WHERE id=$1", [f.task.id, randomUUID()])).rejects.toThrow("Task work lineage is immutable");
  });
  it("anchors a newly finite wall allowance to the original work creation",async()=>{
    const f=await fixture(),previous=process.env.AGENTS_MODEL_POLICY_JSON;
    const origin=(await pool.query("SELECT created_at FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0];
    try{
      process.env.AGENTS_MODEL_POLICY_JSON=JSON.stringify({maxWallDurationMs:120000});
      const next=await transaction(pool,db=>continueWorkInTransaction(db,store,{priorTaskId:f.task.id,authority:f.authority,grantId:f.grant.id,requestKey:randomUUID()}));
      const saved=(await pool.query("SELECT deadline_at FROM agents_platform.tasks WHERE id=$1",[next.task.id])).rows[0];
      expect(new Date(saved.deadline_at).getTime()).toBe(new Date(origin.created_at).getTime()+120000);
    }finally{if(previous===undefined)delete process.env.AGENTS_MODEL_POLICY_JSON;else process.env.AGENTS_MODEL_POLICY_JSON=previous;}
  });
  it("reads full Unicode instructions in bounded work-scoped pages and keeps pending delivery separate",async()=>{
    const f=await fixture(true),instruction=("\u0001".repeat(1200)+'"\\😀\n'.repeat(200)).trim();
    await queueOrchestrationInstruction(pool,f.task.id,{instruction,requestKey:randomUUID()});
    await executeWorkTool(pool,f.task.id,"large-progress","work.update",{expectedRevision:0,record:{objective:"o".repeat(1024),steps:Array.from({length:8},(_,index)=>({id:String(index),title:"s".repeat(256),state:"pending"})),questions:Array.from({length:8},()=>"q".repeat(450)),evidenceTaskIds:[]}});
    const context=await primaryInstructionContext(pool,f.task.id,[]);
    expect(context.pending).toHaveLength(1);
    expect((await primaryInstructionContext(pool,f.task.id,[context.pending[0]!.id])).pending).toEqual([]);
    expect(await executeWorkTool(pool,f.task.id,"default-inspect","work.inspect",{})).not.toHaveProperty("instructionPage");
    let cursor={sequence:"0",offset:0},text="",sequence="";
    for(;;){
      const result=await executeWorkTool(pool,f.task.id,"page-inspect","work.inspect",{instructionSequence:cursor.sequence,instructionOffset:cursor.offset});
      const page=(result as {instructionPage:{sequence:string;text:string;next:typeof cursor|null}}).instructionPage;
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(1024);expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16384);
      text+=page.text;sequence=page.sequence;if(!page.next)break;cursor=page.next;
    }
    expect(text).toBe(instruction);
    const foreign=await fixture(true);
    await expect(executeWorkTool(pool,foreign.task.id,"foreign-page","work.inspect",{instructionSequence:sequence,instructionOffset:0})).rejects.toMatchObject({code:"WORK_INSTRUCTION_SCOPE_DENIED"});
    const member=await store.ensureAccount({issuer:"https://identity.fixture.test",subject:randomUUID(),email:"page-member@example.test",displayName:"Member"});
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[f.authority.organizationId,member.id]);
    const authority={...f.authority,principal:{kind:"human" as const,issuer:member.issuer,subject:member.subject}},grant={...f.grant,...authority,id:randomUUID()};
    await store.createGrant({accountId:member.id,grant});
    const memberTask=await store.admitTask({authority,grantId:grant.id,versionId:f.task.version_id,requestKey:randomUUID(),input:"Another member's work"});
    await expect(executeWorkTool(pool,memberTask.task.id,"member-page","work.inspect",{instructionSequence:sequence,instructionOffset:0})).rejects.toMatchObject({code:"WORK_INSTRUCTION_SCOPE_DENIED"});
  });
  it("carries undelivered corrections into a new segment and never treats compaction as primary delivery",async()=>{
    const f=await fixture(true);
    for(const instruction of ["Already delivered", "Compaction only", "Still pending"])
      await queueOrchestrationInstruction(pool,f.task.id,{instruction,requestKey:randomUUID()});
    const rows=(await pool.query("SELECT sequence,instruction FROM agents_platform.orchestration_instructions WHERE task_id=$1 ORDER BY sequence",[f.task.id])).rows;
    const ids=rows.map(row=>`instruction:${f.task.id}:${row.sequence}`);
    for(const [step,kind,id]of [[0,"model",ids[0]],[1,"compaction",ids[1]]] as const){
      const operation=`${kind==="model"?"model":"compact"}:${f.task.id}:${step}`;
      await beginOperation(pool,f.task.id,{id:operation,kind,name:kind==="model"?"model.generate":"context.compact",request:{},reservedTokens:0,reservedMs:1000});
      await finishOperation(pool,f.task.id,operation,"completed",{},null,0);
      await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,$3,$4,$5,0)",
        [`receipt:${operation}`,f.task.id,kind==="model"?step:-step-1,"a".repeat(64),{primaryInstructionIds:[id],messages:[{role:"user",content:rows[step].instruction}]}]);
    }
    await settleTask(pool,f.task.id,{state:"incomplete",output:"Work remains",errorCode:"ORCHESTRATION_STALLED"});
    const next=await transaction(pool,db=>continueWorkInTransaction(db,store,{priorTaskId:f.task.id,authority:f.authority,grantId:f.grant.id,requestKey:randomUUID()}));
    const pending=await primaryInstructionContext(pool,next.task.id,[]);
    expect(pending.pending.map(group=>group.id)).toEqual([ids[1]]);
    expect(pending.latest?.content).toContain("Still pending");
    const outcome={state:"completed" as const,output:"Finished"};
    expect(await closeOrchestrationInstructions(pool,next.task.id,[],outcome)).toBe(false);
    expect(await closeOrchestrationInstructions(pool,next.task.id,[ids[1]!],outcome)).toBe(false);
    expect(await closeOrchestrationInstructions(pool,next.task.id,[ids[1]!,ids[2]!],outcome)).toBe(true);
  });
});
