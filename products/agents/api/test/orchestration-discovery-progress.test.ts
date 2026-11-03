import { contextGrantCeiling } from "../src/execution/models/settings";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlatformStore } from "../src/product/agents/store";
import { defaultBusinessConfiguration, executionGrantSchema } from "../src/contracts/contracts";
import { orchestrationTools } from "../src/contracts/orchestration";
import { setupPlatformSchema } from "../src/composition/setup";
import { executeWorkTool, queueOrchestrationInstruction, readOrchestrationInstructions, orchestrationProgressObservation,orchestrationStalled,closeOrchestrationInstructions,orchestrationInstructionGroups,decideStallStop,readStallDecision } from "../src/execution/delegation/progress";
import { instructionHead } from "../src/execution/context/instruction-state";
import { discoverSpecialists } from "../src/execution/delegation/discovery";
import { startSpecialist } from "../src/execution/delegation/adaptive";
import { settleTask } from "../src/execution/lifecycle/execution";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("authorized discovery and durable adaptive work record", () => {
  let admin: Pool, pool: Pool, store: PlatformStore;
  const database = `agents_discovery_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(databaseUrl!); target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href }); await setupPlatformSchema(pool); store = new PlatformStore(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  async function fixture() {
    const account = await store.ensureAccount({ issuer: "http://localhost:8080/realms/kasitek", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Discovery fixture"), scope = { accountId: account.id, organizationId: org.id };
    await connectFixtureModel(pool, account.id, org.id);
    const specialist = await store.createAgent({ ...scope, name: "Specialist", configuration: defaultBusinessConfiguration() });
    const child = await store.createVersion({ ...scope, agentId: specialist.id, expectedRevision: 1 });
    const config = defaultBusinessConfiguration(); config.program = { id: "tool-directed", version: "4" }; config.tools = [...orchestrationTools];
    config.capabilities.delegation = { enabled: true, maxChildren: 2, maxDepth: 1, policy: { maxTasks: 16, maxStalls: 3 },
      bindings: Array.from({ length: 12 }, (_, i) => ({ id: `specialist_${i}`, versionId: child.id, label: `Role ${i}`, description: `Capability ${i}`, sourceRevisionIds: [], connectedToolBindingIds: [], tools: [], maxTokens: 8000, maxActiveMs: 120000 })) };
    const agent = await store.createAgent({ ...scope, name: "Coordinator", configuration: config });
    const version = await store.createVersion({ ...scope, agentId: agent.id, expectedRevision: 1 });
    const authority = { product: "agents" as const, organizationId: org.id, resourceId: agent.id, callerClientId: "agents-execution", principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } };
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id, operations: ["model.reply", "knowledge.read", "delegation.execute"], sourceRevisionIds: [], maxInputBytes: config.model.maxInputBytes, maxOutputTokens: config.model.maxOutputTokens, maxContextTokens: contextGrantCeiling(config), expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null });
    await store.createGrant({ ...scope, grant });
    const { task } = await store.admitTask({ authority, grantId: grant.id, versionId: version.id, requestKey: randomUUID(), input: "Investigate and revise" });
    return { task, scope, grant, specialist };
  }
  const record = { objective: "Check the available evidence", steps: [{ id: "inspect", title: "Inspect findings", state: "in_progress" as const }], questions: [], evidenceTaskIds: [] as string[] };

  it("discovers only the pinned roster, paginates and reports withdrawn specialist readiness", async () => {
    const f = await fixture(), first = await discoverSpecialists(pool, f.task.id, {});
    expect(first.specialists).toHaveLength(8); expect(first.nextOffset).toBe(8);
    expect((await discoverSpecialists(pool, f.task.id, { offset: first.nextOffset! })).specialists).toHaveLength(4);
    expect((await discoverSpecialists(pool, f.task.id, { bindingId: "specialist_11" })).specialists).toHaveLength(1);
    expect((await discoverSpecialists(pool, f.task.id, { bindingId: "foreign" })).specialists).toEqual([]);
    await pool.query("UPDATE agents_platform.agents SET deleted_at=now() WHERE id=$1", [f.specialist.id]);
    expect((await discoverSpecialists(pool, f.task.id, { bindingId: "specialist_0" })).specialists[0]).toMatchObject({ ready: false });
    await expect(startSpecialist(pool, f.task.id, "deleted:start", { requests: [{ bindingId: "specialist_0", brief: "Help" }] })).rejects.toMatchObject({ code: "DELEGATION_BINDING_DENIED" });
  });
  it("persists revision checked work idempotently and denies foreign evidence", async () => {
    const f = await fixture();
    expect(await executeWorkTool(pool, f.task.id, "work:read", "work.inspect", {})).toEqual({ revision: 0, record: null });
    const output = await executeWorkTool(pool, f.task.id, "work:one", "work.update", { expectedRevision: 0, record });
    expect(output).toEqual({ revision: 1, record });
    expect(await executeWorkTool(pool, f.task.id, "work:one", "work.update", { expectedRevision: 0, record })).toEqual(output);
    await expect(executeWorkTool(pool, f.task.id, "work:one", "work.update", { expectedRevision: 0, record: { ...record, objective: "Changed" } })).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    await expect(executeWorkTool(pool, f.task.id, "work:two", "work.update", { expectedRevision: 0, record })).rejects.toMatchObject({ code: "WORK_REVISION_CONFLICT" });
    await expect(executeWorkTool(pool, f.task.id, "work:foreign", "work.update", { expectedRevision: 1, record: { ...record, evidenceTaskIds: [randomUUID()] } })).rejects.toMatchObject({ code: "WORK_EVIDENCE_DENIED" });
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.task_events WHERE task_id=$1 AND kind='work.updated'", [f.task.id])).rows[0].count).toBe(1);
  });
  it("queues member instructions once, preserves current authority and refuses settled work", async () => {
    const f = await fixture(), input = { requestKey: randomUUID(), instruction: "Focus on the shorter version" };
    expect(await queueOrchestrationInstruction(pool, f.task.id, input)).toEqual({ accepted: true });
    expect(await queueOrchestrationInstruction(pool, f.task.id, input)).toEqual({ accepted: true });
    expect(await readOrchestrationInstructions(pool, f.task.id)).toEqual([{ role: "user", content: `Additional instructions for this request:\n${input.instruction}` }]);
    await expect(queueOrchestrationInstruction(pool, f.task.id, { ...input, instruction: "Changed" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await pool.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1", [f.grant.id]);
    await expect(queueOrchestrationInstruction(pool, f.task.id, { ...input, requestKey: randomUUID() })).rejects.toMatchObject({ code: "GRANT_REVOKED" });
    const other = await fixture(); await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[other.task.id]); await settleTask(pool, other.task.id, { state: "completed", output: "Done" });
    await expect(queueOrchestrationInstruction(pool, other.task.id, input)).rejects.toBeDefined();
  });
  it("pages pending corrections by stable identity, excludes incorporated groups and closes input atomically",async()=>{
    const f=await fixture();for(let index=0;index<6;index++)await queueOrchestrationInstruction(pool,f.task.id,{requestKey:randomUUID(),instruction:`Correction ${index}`});
    const first=await orchestrationInstructionGroups(pool,f.task.id,[]);expect(first).toHaveLength(4);expect(new Set(first.map(group=>group.id)).size).toBe(4);
    expect(first[0]!.messages[0]!.content).toContain("Correction 0");
    const next=await orchestrationInstructionGroups(pool,f.task.id,first.map(group=>group.id));expect(next).toHaveLength(2);expect(next[0]!.messages[0]!.content).toContain("Correction 4");
    const outcome={state:"completed" as const,output:"All corrections incorporated"};
    expect(await closeOrchestrationInstructions(pool,f.task.id,first.map(group=>group.id),outcome)).toBe(false);
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.orchestration_input_closures WHERE task_id=$1",[f.task.id])).rows[0].count).toBe(0);
    const incorporated=[...first,...next].map(group=>group.id);expect(await orchestrationInstructionGroups(pool,f.task.id,incorporated)).toEqual([]);
    expect(await closeOrchestrationInstructions(pool,f.task.id,incorporated,outcome)).toBe(true);
    expect(await closeOrchestrationInstructions(pool,f.task.id,incorporated,outcome)).toBe(true);
    await expect(closeOrchestrationInstructions(pool,f.task.id,incorporated,{...outcome,output:"Changed final intent"})).rejects.toMatchObject({code:"OPERATION_CONFLICT"});
    await expect(queueOrchestrationInstruction(pool,f.task.id,{requestKey:randomUUID(),instruction:"Too late"})).rejects.toMatchObject({code:"TASK_TERMINAL"});
    expect((await pool.query("SELECT state,pending_outcome FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0]).toMatchObject({pending_outcome:null});
  },15000);
  it("does not flag a fresh request or active specialist as stalled", async () => {
    const f = await fixture(); expect(await orchestrationStalled(pool, f.task.id)).toBe(false);
    await startSpecialist(pool, f.task.id, "start:active", { requests: [{ bindingId: "specialist_0", brief: "Investigate" }] });
    expect(await orchestrationStalled(pool, f.task.id)).toBe(false);
  });
  it("lets a replan inspect work and starts a new loop after an accepted correction", async () => {
    const f=await fixture();
    expect(f.task.harness_release).toBe("product-capabilities-v15");
    const record=async(name:string,head:string,output:unknown)=>{
      const request={tool:name,arguments:"{}",instructionHead:head};
      await pool.query(`INSERT INTO agents_platform.operations(id,task_id,kind,name,request_digest,request,state,output,reserved_ms,attempt_id)
        VALUES($1,$2,'tool',$3,$4,$5,'completed',$6,1000,$7)`,
      [randomUUID(),f.task.id,name,"a".repeat(64),request,output,randomUUID()]);
    };
    for(let index=0;index<3;index++)await record("agents.discover","0",{specialists:[]});
    const priorCycle=await orchestrationProgressObservation(pool,f.task.id);
    expect(priorCycle).toEqual(expect.any(String));
    await record("work.inspect","0",{revision:0,record:null});
    expect(await orchestrationProgressObservation(pool,f.task.id)).toBeNull();
    for(let index=0;index<3;index++)await record("agents.discover","0",{specialists:[]});
    expect(await orchestrationProgressObservation(pool,f.task.id)).toEqual(expect.any(String));
    await queueOrchestrationInstruction(pool,f.task.id,{requestKey:randomUUID(),instruction:"Use the revised direction"});
    const head=await instructionHead(pool,f.task.id);
    expect(head).not.toBe("0");
    expect(await orchestrationProgressObservation(pool,f.task.id)).toBeNull();
    for(let index=0;index<3;index++)await record("agents.discover",head,{specialists:[]});
    const revisedCycle=await orchestrationProgressObservation(pool,f.task.id);
    expect(revisedCycle).toEqual(expect.any(String));
    expect(revisedCycle).not.toBe(priorCycle);
    await record("agents.wait",head,{timedOut:true,children:[]});
    expect(await orchestrationProgressObservation(pool,f.task.id)).toBe(revisedCycle);
    for(let index=0;index<3;index++)await record("work.inspect",head,{revision:0,record:null});
    expect(await orchestrationProgressObservation(pool,f.task.id)).toEqual(expect.any(String));
    expect(await closeOrchestrationInstructions(pool,f.task.id,[],{state:"incomplete",errorCode:"ORCHESTRATION_STALLED"})).toBe(false);
  },15000);
  it("serializes a stalled stop with late instructions and replays the exact saved outcome",async()=>{
    async function stalled(){
      const f=await fixture();
      for(let index=0;index<3;index++)await pool.query(`INSERT INTO agents_platform.operations(id,task_id,kind,name,request_digest,request,state,output,reserved_ms,attempt_id)
        VALUES($1,$2,'tool','agents.discover',$3,$4,'completed',$5,1000,$6)`,[randomUUID(),f.task.id,"a".repeat(64),{tool:"agents.discover",arguments:"{}",instructionHead:"0"},{specialists:[]},randomUUID()]);
      const observation=await orchestrationProgressObservation(pool,f.task.id);expect(observation).toEqual(expect.any(String));return {...f,observation:observation!};
    }
    const outcome={state:"incomplete" as const,errorCode:"ORCHESTRATION_STALLED",output:"Preserved partial work."};
    const before=await stalled();await queueOrchestrationInstruction(pool,before.task.id,{requestKey:randomUUID(),instruction:"Use the revised requirement."});
    expect(await decideStallStop(pool,before.task.id,4,before.observation,[],outcome)).toEqual({kind:"resume"});
    expect((await pool.query("SELECT 1 FROM agents_platform.orchestration_input_closures WHERE task_id=$1",[before.task.id])).rowCount).toBe(0);
    const after=await stalled(),stop=await decideStallStop(pool,after.task.id,4,after.observation,[],outcome);
    expect(stop).toEqual({kind:"stop",observation:after.observation,outcome});
    await expect(queueOrchestrationInstruction(pool,after.task.id,{requestKey:randomUUID(),instruction:"A later correction."})).rejects.toMatchObject({code:"TASK_TERMINAL"});
    expect(await decideStallStop(pool,after.task.id,4,after.observation,[],{...outcome,output:"Different retry output"})).toEqual(stop);
    expect(await readStallDecision(pool,after.task.id,4)).toEqual(stop);
    const row=(await pool.query(`SELECT c.outcome_digest,d.outcome_digest AS decision_digest,t.pending_outcome
      FROM agents_platform.orchestration_input_closures c JOIN agents_platform.orchestration_stall_decisions d ON d.task_id=c.task_id
      JOIN agents_platform.tasks t ON t.id=c.task_id WHERE c.task_id=$1`,[after.task.id])).rows[0];
    expect(row.outcome_digest).toBe(row.decision_digest);expect(row.pending_outcome).toBeNull();
    await pool.query("UPDATE agents_platform.orchestration_input_closures SET outcome_digest=$2 WHERE task_id=$1",[after.task.id,"0".repeat(64)]);
    await expect(readStallDecision(pool,after.task.id,4)).rejects.toMatchObject({code:"OPERATION_CONFLICT"});
    await pool.query("UPDATE agents_platform.orchestration_input_closures SET outcome_digest=$2 WHERE task_id=$1",[after.task.id,row.outcome_digest]);
    const concurrent=await stalled(),raced=await Promise.allSettled([
      decideStallStop(pool,concurrent.task.id,4,concurrent.observation,[],outcome),
      queueOrchestrationInstruction(pool,concurrent.task.id,{requestKey:randomUUID(),instruction:"A correction during the stop."}),
    ]);
    expect(raced[0].status).toBe("fulfilled");
    if(raced[0].status==="fulfilled"&&raced[0].value.kind==="resume")expect(raced[1].status).toBe("fulfilled");
    else {expect(raced[1].status).toBe("rejected");if(raced[1].status==="rejected")expect(raced[1].reason.code).toBe("TASK_TERMINAL");}
  },15000);
});
