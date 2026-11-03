import { contextGrantCeiling } from "../src/execution/models/settings";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlatformStore } from "../src/product/agents/store";
import { defaultBusinessConfiguration, executionGrantSchema, requestDigest } from "../src/contracts/contracts";
import { setupPlatformSchema } from "../src/composition/setup";
import { cancelSpecialist, followupSpecialist, specialistResult, specialistStatus, startSpecialist, specialistTokenBackpressure } from "../src/execution/delegation/adaptive";
import { closeOrchestrationInstructions, orchestrationInstructionGroups, queueOrchestrationInstruction } from "../src/execution/delegation/progress";
import { beginOperation, finishOperation, settleTask, transaction, queueChildContinuations, assertCurrentAuthority, loadExecution } from "../src/execution/lifecycle/execution";
import { executionReservationPressure } from "../src/execution/lifecycle/reservation-pressure";
import { dispatchTasksOnce } from "../src/execution/lifecycle/dispatcher";
import { SHARED_HARNESS_RELEASE as HARNESS_RELEASE, SHARED_WORKFLOW_NAME as WORKFLOW_NAME } from "../src/contracts/execution";
import { continueWorkInTransaction } from "../src/execution/lifecycle/work-continuation";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { assertProductReadCustody } from "../src/execution/products/product-read-custody";
import { createDependencyManifest } from "../src/contracts/source-contracts";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("durable adaptive specialist work", () => {
  let admin: Pool, pool: Pool, store: PlatformStore;
  const database = `agents_adaptive_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href });
    await setupPlatformSchema(pool); store = new PlatformStore(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  async function fixture(maxTasks: number | null = 8, maxChildren = 2, rolling = false, rootTokenLimit: number | null = rolling ? null : 32000) {
    const account = await store.ensureAccount({ issuer: "http://localhost:8080/realms/kasitek", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Adaptive fixture"), scope = { accountId: account.id, organizationId: org.id };
    await connectFixtureModel(pool, account.id, org.id);
    const specialist = await store.createAgent({ ...scope, name: "Specialist", configuration: defaultBusinessConfiguration() });
    const childVersion = await store.createVersion({ ...scope, agentId: specialist.id, expectedRevision: 1 });
    const configuration = defaultBusinessConfiguration();
    configuration.program = { id: "tool-directed", version: "4" };
    configuration.tools = ["agents.start", "agents.status", "agents.result", "agents.wait", "agents.followup", "agents.cancel"];
    configuration.capabilities.delegation = { enabled: true, maxChildren, maxDepth: 1, policy: { maxTasks, maxStalls: 3 }, bindings: [
      { id: "specialist", versionId: childVersion.id, sourceRevisionIds: [], connectedToolBindingIds: [], tools: [], maxTokens: rolling ? null : 8000, maxActiveMs: rolling ? null : 120000 },
    ] };
    const agent = await store.createAgent({ ...scope, name: "Coordinator", configuration });
    const version = await store.createVersion({ ...scope, agentId: agent.id, expectedRevision: 1 });
    const authority = { product: "agents" as const, organizationId: org.id, resourceId: agent.id, callerClientId: "agents-execution", principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } };
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id, operations: ["model.reply", "knowledge.read", "delegation.execute"], sourceRevisionIds: [], maxInputBytes: configuration.model.maxInputBytes, maxOutputTokens: configuration.model.maxOutputTokens, maxContextTokens: contextGrantCeiling(configuration), rootTokenLimit, expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null });
    await store.createGrant({ ...scope, grant });
    const { task } = await store.admitTask({ authority, grantId: grant.id, versionId: version.id, requestKey: randomUUID(), input: "Investigate and revise" });
    return { task, scope, grant };
  }
  async function complete(id: string, output: string) {
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1", [id]);
    await settleTask(pool,id,{state:"completed",output});
  }
  const request = { requests: [{ bindingId: "specialist", brief: "Produce a draft" }] };

  it("fences an untracked child read only after its result joins the parent",async()=>{
    const f=await fixture(),child=(await startSpecialist(pool,f.task.id,"custody:child",request)).children[0]!.taskId;
    const operationId=`tool:${child}:untracked`,bindingId=randomUUID();
    await pool.query(`INSERT INTO agents_platform.operations(id,task_id,kind,name,request_digest,request,state,output,reserved_ms,attempt_id)
      VALUES($1,$2,'tool','unknown_product_read',$3,$4,'completed',$5,1000,$6)`,
    [operationId,child,"a".repeat(64),{productBindingId:bindingId,bindingDigest:"b".repeat(64)},{value:{private:"child result"}},randomUUID()]);
    await expect(assertProductReadCustody(pool,f.task.id)).resolves.toBeUndefined();
    const childNode=randomUUID(),parentNode=randomUUID(),manifest=createDependencyManifest([]);
    const node=async(id:string,taskId:string,kind:string,ownerId:string,parents:string[])=>pool.query(`INSERT INTO agents_platform.evidence_nodes
      (id,organization_id,root_task_id,task_id,kind,owner_id,evidence_ids,parents,manifest,request_digest)
      VALUES($1,$2,$3,$4,$5,$6,'{}',$7,$8,$9)`,[id,f.task.organization_id,f.task.id,taskId,kind,ownerId,parents,manifest,requestDigest({ids:[],parentIds:parents,manifest})]);
    await node(childNode,child,"child_result",child,[]);
    await node(parentNode,f.task.id,"input","joined-child",[childNode]);
    await expect(assertProductReadCustody(pool,f.task.id)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  });

  it("keeps coordinator and specialist call limits local while atomically enforcing the shared ceiling",async()=>{
    const saved=process.env.AGENTS_MODEL_POLICY_JSON;
    let f:Awaited<ReturnType<typeof fixture>>;
    try {
      process.env.AGENTS_MODEL_POLICY_JSON=JSON.stringify({maxModelCalls:2,maxRootModelCalls:5});
      f=await fixture(null,2,true);
    } finally {if(saved===undefined)delete process.env.AGENTS_MODEL_POLICY_JSON;else process.env.AGENTS_MODEL_POLICY_JSON=saved;}
    const children=(await startSpecialist(pool,f!.task.id,"local:children",{requests:[request.requests[0]!,request.requests[0]!]})).children;
    const operation=(taskId:string,key:string)=>({id:`local:${taskId}:${key}`,kind:"model" as const,name:"model.generate",request:{key},reservedTokens:20,reservedMs:1000});
    async function run(taskId:string,key:string){
      const input=operation(taskId,key),admitted=await beginOperation(pool,taskId,input);
      if(admitted.waiting)throw Error("Unexpected capacity wait");
      await finishOperation(pool,taskId,input.id,"completed",{finding:key},null,3,admitted.operation.attempt_id);
    }
    await run(f!.task.id,"root-one");
    await run(children[0]!.taskId,"child-one");await run(children[0]!.taskId,"child-two");
    await expect(beginOperation(pool,children[0]!.taskId,operation(children[0]!.taskId,"child-local-denied"))).rejects.toMatchObject({code:"MODEL_CALL_LIMIT"});
    const attempts=await Promise.allSettled([0,1,2].map(index=>beginOperation(pool,children[1]!.taskId,operation(children[1]!.taskId,`shared-${index}`))));
    expect(attempts.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect(attempts.filter(result=>result.status==="rejected").map(result=>result.reason.code)).toEqual(["ROOT_MODEL_CALL_LIMIT","ROOT_MODEL_CALL_LIMIT"]);
    for(const result of attempts)if(result.status==="fulfilled"){
      if(result.value.waiting)throw Error("Unexpected capacity wait");
      await finishOperation(pool,children[1]!.taskId,result.value.operation.id,"completed",{finding:"shared"},null,3,result.value.operation.attempt_id);
    }
    await run(f!.task.id,"root-two");
    await expect(beginOperation(pool,f!.task.id,operation(f!.task.id,"root-local-denied"))).rejects.toMatchObject({code:"MODEL_CALL_LIMIT"});
    expect((await pool.query("SELECT model_calls FROM agents_platform.execution_roots WHERE root_task_id=$1",[f!.task.id])).rows[0].model_calls).toBe(5);
    expect((await pool.query("SELECT model_calls FROM agents_platform.tasks WHERE id=$1",[f!.task.id])).rows[0].model_calls).toBe(2);
    expect((await pool.query("SELECT model_calls FROM agents_platform.tasks WHERE id=$1",[children[1]!.taskId])).rows[0].model_calls).toBe(1);
    for(const child of children)await complete(child.taskId,"Confirmed finding");
    await complete(f!.task.id,"Completed within the explicit shared allowance");
  });

  it("does not admit specialists when an explicit shared call cap cannot cover their calls and a final response",async()=>{
    const saved=process.env.AGENTS_MODEL_POLICY_JSON;
    let f:Awaited<ReturnType<typeof fixture>>;
    try {
      process.env.AGENTS_MODEL_POLICY_JSON=JSON.stringify({...JSON.parse(saved??"{}"),maxRootModelCalls:2});
      f=await fixture(null,2,true);
    } finally {if(saved===undefined)delete process.env.AGENTS_MODEL_POLICY_JSON;else process.env.AGENTS_MODEL_POLICY_JSON=saved;}
    await expect(startSpecialist(pool,f!.task.id,"finite:headroom",{requests:[{bindingId:"specialist",brief:"Independent first result"},{bindingId:"specialist",brief:"Independent second result"}]})).rejects.toMatchObject({code:"ROOT_MODEL_CALL_LIMIT"});
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.tasks WHERE parent_task_id=$1",[f!.task.id])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT child_reserved_tokens FROM agents_platform.execution_roots WHERE root_task_id=$1",[f!.task.id])).rows[0].child_reserved_tokens).toBe(0);
    await startSpecialist(pool,f!.task.id,"finite:first-admitted",{requests:[{bindingId:"specialist",brief:"One permitted result"}]});
    await expect(startSpecialist(pool,f!.task.id,"finite:pending-stock",{requests:[{bindingId:"specialist",brief:"Another optional result"}]})).rejects.toMatchObject({code:"ROOT_MODEL_CALL_LIMIT"});
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.tasks WHERE parent_task_id=$1",[f!.task.id])).rows[0].n).toBe(1);
  });

  it("starts transactionally, replays identities, paginates complete results and revises a pinned specialist conversation", async () => {
    const f = await fixture();
    const first = await startSpecialist(pool, f.task.id, "start:one", request), id = first.children[0]!.taskId;
    expect((await startSpecialist(pool, f.task.id, "start:one", request)).children[0]!.taskId).toBe(id);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.task_outbox WHERE task_id=$1", [id])).rows[0].count).toBe(1);
    await expect(specialistResult(pool, f.task.id, { taskId: id })).rejects.toMatchObject({ code: "CHILD_OUTCOME_PENDING" });
    const output = "🦉".repeat(1500) + "complete draft";
    await complete(id, output);
    const page = await specialistResult(pool, f.task.id, { taskId: id });
    expect(Buffer.byteLength(page.output)).toBe(4096); expect(page.nextOffset).toBe(1024);
    const rest = await specialistResult(pool, f.task.id, { taskId: id, offset: page.nextOffset! });
    expect(page.output + rest.output).toBe(output); expect(rest.contentDigest).toBe(page.contentDigest);
    const next = await followupSpecialist(pool, f.task.id, "followup:one", { taskId: id, brief: "Shorten the draft" });
    expect(next.children[0]).toMatchObject({ priorTaskId: id, conversationId: first.children[0]!.conversationId, versionId: first.children[0]!.versionId });
    expect((await pool.query("SELECT turn_sequence FROM agents_platform.tasks WHERE id=$1", [next.children[0]!.taskId])).rows[0].turn_sequence).toBe("2");
    await expect(followupSpecialist(pool, f.task.id, "followup:busy", { taskId: id, brief: "Race" })).rejects.toMatchObject({ code: "SPECIALIST_BUSY" });
    await complete(next.children[0]!.taskId, "Short draft");
    await expect(followupSpecialist(pool, f.task.id, "followup:stale", { taskId: id, brief: "Old turn" })).rejects.toMatchObject({ code: "SPECIALIST_STALE_TURN" });
  });

  it.each(["tokens", "active time"] as const)("keeps finite specialist allocations within cumulative %s across continuation segments", async dimension => {
    const previous = process.env.AGENTS_MODEL_POLICY_JSON;
    let f: Awaited<ReturnType<typeof fixture>>;
    try {
      process.env.AGENTS_MODEL_POLICY_JSON = JSON.stringify({ maxDurationMs: 300000 });
      f = await fixture();
    } finally {
      if (previous === undefined) delete process.env.AGENTS_MODEL_POLICY_JSON; else process.env.AGENTS_MODEL_POLICY_JSON = previous;
    }
    const op = { id: `prior:${f.task.id}`, kind: "model" as const, name: "model.generate", request: { query: dimension },
      reservedTokens: dimension === "tokens" ? 24000 : 20, reservedMs: 120000 };
    const admission = await beginOperation(pool, f.task.id, op);
    if (admission.waiting) throw Error("Unexpected capacity wait");
    if (dimension === "active time") await pool.query("UPDATE agents_platform.operations SET started_at=now()-interval '120 seconds' WHERE id=$1", [op.id]);
    await finishOperation(pool, f.task.id, op.id, "completed", { finding: "Preserved finding" }, null, dimension === "tokens" ? 24000 : 3, admission.operation.attempt_id);
    await settleTask(pool, f.task.id, { state: "incomplete", errorCode: "ORCHESTRATION_STALLED", output: "Preserved finding" });
    const next = await transaction(pool, db => continueWorkInTransaction(db, store, {
      priorTaskId: f.task.id, authority: f.grant, grantId: f.grant.id, requestKey: randomUUID(),
    }));
    await expect(startSpecialist(pool, next.task.id, "continued:finite-allocation", request)).rejects.toMatchObject({
      code: dimension === "tokens" ? "ROOT_TOKEN_LIMIT" : "ROOT_DURATION_LIMIT",
    });
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.tasks WHERE parent_task_id=$1", [next.task.id])).rows[0].count).toBe(0);
  });

  it("waits for temporary child allocation pressure across continuation segments", async () => {
    const f = await fixture();
    const priorOp = { id: `prior-pressure:${f.task.id}`, kind: "model" as const, name: "model.generate", request: {}, reservedTokens: 19000, reservedMs: 1000 };
    const admitted = await beginOperation(pool, f.task.id, priorOp);
    if (admitted.waiting) throw Error("Unexpected capacity wait");
    await finishOperation(pool, f.task.id, priorOp.id, "completed", {}, null, 19000, admitted.operation.attempt_id);
    await settleTask(pool, f.task.id, { state: "incomplete", errorCode: "ORCHESTRATION_STALLED", output: "Prior finding" });
    const next = await transaction(pool, db => continueWorkInTransaction(db, store, {
      priorTaskId: f.task.id, authority: f.grant, grantId: f.grant.id, requestKey: randomUUID(),
    }));
    const child = (await startSpecialist(pool, next.task.id, "pressure:child", request)).children[0]!;
    const parentOp = { id: `parent-pressure:${next.task.id}`, kind: "model" as const, name: "model.generate", request: {}, reservedTokens: 12288, reservedMs: 1000 };
    await expect(beginOperation(pool, next.task.id, parentOp)).rejects.toMatchObject({ code: "ROOT_TOKEN_LIMIT" });
    expect(await specialistTokenBackpressure(pool, next.task.id, parentOp.reservedTokens, parentOp.reservedMs)).toBe(true);
    expect(await executionReservationPressure(pool, next.task.id, parentOp.reservedTokens, parentOp.reservedMs)).toBe(true);
    expect(await executionReservationPressure(pool, child.taskId, 1000, 1000)).toBe(false);
    const childOp = { ...parentOp, id: `child-pressure:${child.taskId}`, reservedTokens: 1000 };
    const childAdmission = await beginOperation(pool, child.taskId, childOp);
    if (childAdmission.waiting) throw Error("Unexpected capacity wait");
    await finishOperation(pool, child.taskId, childOp.id, "completed", {}, null, 500, childAdmission.operation.attempt_id);
    await settleTask(pool, child.taskId, { state: "completed", output: "Confirmed finding" });
    expect(await specialistTokenBackpressure(pool, next.task.id, parentOp.reservedTokens, parentOp.reservedMs)).toBe(false);
    expect((await beginOperation(pool, next.task.id, parentOp)).waiting).not.toBe(true);
  });

  it.each(["tokens", "active time"] as const)("waits for in-flight rolling specialist %s reservations without treating actual exhaustion as temporary", async dimension => {
    const previous = process.env.AGENTS_MODEL_POLICY_JSON;
    let f: Awaited<ReturnType<typeof fixture>>;
    try {
      process.env.AGENTS_MODEL_POLICY_JSON = JSON.stringify({ maxDurationMs: 300000 });
      f = await fixture(null, 2, true, 32000);
    } finally {
      if (previous === undefined) delete process.env.AGENTS_MODEL_POLICY_JSON; else process.env.AGENTS_MODEL_POLICY_JSON = previous;
    }
    const children = (await startSpecialist(pool, f.task.id, "rolling:parallel", {
      requests: [{ bindingId: "specialist", brief: "Research the audience" }, { bindingId: "specialist", brief: "Research the channels" }],
    })).children;
    const pending = [];
    for (const child of children) {
      const input = { id: `rolling:${child.taskId}`, kind: "model" as const, name: "model.generate", request: {},
        reservedTokens: dimension === "tokens" ? 10000 : 20, reservedMs: dimension === "active time" ? 120000 : 1000 };
      const admission = await beginOperation(pool, child.taskId, input);
      if (admission.waiting) throw Error("Unexpected capacity wait");
      pending.push({ child, input, attempt: admission.operation.attempt_id });
    }
    const retry = { id: `rolling:coordinator:${f.task.id}`, kind: "model" as const, name: "model.generate", request: {},
      reservedTokens: dimension === "tokens" ? 20000 : 20, reservedMs: dimension === "active time" ? 120000 : 1000 };
    const code = dimension === "tokens" ? "ROOT_TOKEN_LIMIT" : "ROOT_DURATION_LIMIT";
    await expect(beginOperation(pool, f.task.id, retry)).rejects.toMatchObject({ code });
    await expect(beginOperation(pool, children[0]!.taskId, { ...retry, id: `rolling:child-retry:${children[0]!.taskId}` })).rejects.toMatchObject({ code });
    expect(await executionReservationPressure(pool, f.task.id, retry.reservedTokens, retry.reservedMs)).toBe(true);
    expect(await executionReservationPressure(pool, children[0]!.taskId, retry.reservedTokens, retry.reservedMs)).toBe(true);
    if (dimension === "active time") {
      for (const item of pending) {
        await pool.query("UPDATE agents_platform.operations SET started_at=now()-interval '100 seconds' WHERE id=$1", [item.input.id]);
        await finishOperation(pool, item.child.taskId, item.input.id, "completed", {}, null, 3, item.attempt);
      }
    } else {
      const first = pending[0]!;
      await finishOperation(pool, first.child.taskId, first.input.id, "completed", {}, null, 100, first.attempt);
      expect(await executionReservationPressure(pool, f.task.id, retry.reservedTokens, retry.reservedMs)).toBe(false);
      const admitted = await beginOperation(pool, f.task.id, retry);
      if (admitted.waiting) throw Error("Unexpected capacity wait");
      await finishOperation(pool, f.task.id, retry.id, "completed", {}, null, 20000, admitted.operation.attempt_id);
      const second = pending[1]!;
      await finishOperation(pool, second.child.taskId, second.input.id, "completed", {}, null, 0, second.attempt);
    }
    expect(await executionReservationPressure(pool, f.task.id, retry.reservedTokens, retry.reservedMs)).toBe(false);
    expect(await executionReservationPressure(pool, children[0]!.taskId, retry.reservedTokens, retry.reservedMs)).toBe(false);
    await expect(beginOperation(pool, f.task.id, { ...retry, id: `rolling:exhausted:${f.task.id}` })).rejects.toMatchObject({ code });
  });

  it("keeps uncertain model usage charged instead of waiting for its reservation to disappear", async () => {
    const f = await fixture(null, 2, true, 32000);
    const child = (await startSpecialist(pool, f.task.id, "rolling:uncertain", request)).children[0]!;
    const input = { id: `rolling:uncertain:${child.taskId}`, kind: "model" as const, name: "model.generate", request: {}, reservedTokens: 20000, reservedMs: 1000 };
    const admission = await beginOperation(pool, child.taskId, input);
    if (admission.waiting) throw Error("Unexpected capacity wait");
    await finishOperation(pool, child.taskId, input.id, "uncertain", null, "MODEL_REQUEST_FAILED", input.reservedTokens, admission.operation.attempt_id);
    expect(await executionReservationPressure(pool, f.task.id, 20000, 1000)).toBe(false);
    expect(await executionReservationPressure(pool, child.taskId, 20000, 1000)).toBe(false);
    expect((await pool.query("SELECT tokens_used,tokens_reserved FROM agents_platform.execution_roots WHERE root_task_id=$1", [f.task.id])).rows[0]).toMatchObject({ tokens_used: 20000, tokens_reserved: 0 });
  });

  it.each([false, true])("renews expired derived child authority with rolling=%s without widening scope or resetting usage", async rolling => {
    const f = await fixture(null, 2, rolling);
    const first = (await startSpecialist(pool, f.task.id, "renewal:first", { requests: [
      { bindingId: "specialist", brief: "Keep investigating" }, { bindingId: "specialist", brief: "Completed finding" },
    ] })).children;
    const child = first[0]!, completed = first[1]!;
    await complete(completed.taskId, "Preserved result");
    const revoked = (await startSpecialist(pool, f.task.id, "renewal:revoked", request)).children[0]!;
    const op = { id: `renewal:before:${child.taskId}`, kind: "model" as const, name: "model.generate", request: {}, reservedTokens: 20, reservedMs: 1000 };
    const admitted = await beginOperation(pool, child.taskId, op);
    if (admitted.waiting) throw Error("Unexpected capacity wait");
    await finishOperation(pool, child.taskId, op.id, "completed", {}, null, 3, admitted.operation.attempt_id);
    await pool.query("UPDATE agents_platform.execution_grants SET expires_at=created_at+interval '1 millisecond' WHERE id IN (SELECT grant_id FROM agents_platform.tasks WHERE root_task_id=$1)", [f.task.id]);
    await pool.query("UPDATE agents_platform.tasks SET state='waiting_authority' WHERE id=ANY($1::uuid[])", [[child.taskId, revoked.taskId]]);
    await pool.query("UPDATE agents_platform.tasks SET state='waiting_children' WHERE id=$1", [f.task.id]);
    await pool.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=(SELECT grant_id FROM agents_platform.tasks WHERE id=$1)", [revoked.taskId]);
    const before = (await pool.query("SELECT t.*,r.routes,r.snapshot_digest FROM agents_platform.tasks t JOIN agents_platform.task_model_routes r ON r.task_id=t.id WHERE t.id=$1", [child.taskId])).rows[0];
    const revokedGrant = (await pool.query("SELECT grant_id FROM agents_platform.tasks WHERE id=$1", [revoked.taskId])).rows[0].grant_id;
    const completedGrant = (await pool.query("SELECT grant_id FROM agents_platform.tasks WHERE id=$1", [completed.taskId])).rows[0].grant_id;
    expect(before.deadline_at).toBeNull();
    const grant = { ...f.grant, id: randomUUID(), operations: ["model.reply", "delegation.execute"] as typeof f.grant.operations,
      expiresAt: new Date(Date.now() + 600000).toISOString() };
    await store.createGrant({ ...f.scope, grant });
    await pool.query("UPDATE agents_platform.tasks SET grant_id=$2 WHERE id=$1", [f.task.id, grant.id]);
    await expect(assertCurrentAuthority(pool, await loadExecution(pool, child.taskId))).rejects.toMatchObject({ code: "AUTHORITY_EXPIRED" });
    await queueChildContinuations(pool, f.task.id);
    const after = (await pool.query("SELECT t.*,r.routes,r.snapshot_digest FROM agents_platform.tasks t JOIN agents_platform.task_model_routes r ON r.task_id=t.id WHERE t.id=$1", [child.taskId])).rows[0];
    expect(after.grant_id).not.toBe(before.grant_id);
    expect(after).toMatchObject({ tokens_used: 3, model_calls: 1, root_token_limit: rolling ? null : 8000, allocation_active_ms: rolling ? null : 120000,
      version_id: before.version_id, effective_configuration: before.effective_configuration, routes: before.routes, snapshot_digest: before.snapshot_digest });
    const renewed = (await pool.query("SELECT * FROM agents_platform.execution_grants WHERE id=$1", [after.grant_id])).rows[0];
    expect(renewed.operations).toEqual(["model.reply", "knowledge.read"]);
    expect(renewed.expires_at.getTime()).toBeLessThanOrEqual(new Date(grant.expiresAt).getTime());
    expect(renewed).toMatchObject({ resource_id: before.resource_id, version_id: before.version_id, root_token_limit: before.root_token_limit, source_revision_ids: [], connected_tool_binding_ids: [] });
    await expect(assertCurrentAuthority(pool, await loadExecution(pool, child.taskId))).resolves.toBeUndefined();
    await queueChildContinuations(pool, f.task.id);
    expect((await pool.query("SELECT grant_id FROM agents_platform.tasks WHERE id=$1", [child.taskId])).rows[0].grant_id).toBe(after.grant_id);
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.task_controls WHERE task_id=$1", [child.taskId])).rows[0].count).toBe(1);
    expect((await pool.query("SELECT grant_id FROM agents_platform.tasks WHERE id=$1", [revoked.taskId])).rows[0].grant_id).toBe(revokedGrant);
    expect((await pool.query("SELECT grant_id FROM agents_platform.tasks WHERE id=$1", [completed.taskId])).rows[0].grant_id).toBe(completedGrant);
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.task_controls WHERE task_id=ANY($1::uuid[])", [[revoked.taskId, completed.taskId]])).rows[0].count).toBe(0);
    const next = { ...op, id: `renewal:after:${child.taskId}` };
    const resumed = await beginOperation(pool, child.taskId, next);
    if (resumed.waiting) throw Error("Unexpected capacity wait");
    await finishOperation(pool, child.taskId, next.id, "completed", {}, null, 3, resumed.operation.attempt_id);
    expect((await pool.query("SELECT tokens_used,model_calls FROM agents_platform.tasks WHERE id=$1", [child.taskId])).rows[0]).toMatchObject({ tokens_used: 6, model_calls: 2 });
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2", [f.scope.organizationId, f.scope.accountId]);
    await pool.query("UPDATE agents_platform.tasks SET state='waiting_authority' WHERE id=$1", [child.taskId]);
    await pool.query("UPDATE agents_platform.execution_grants SET expires_at=created_at+interval '1 millisecond' WHERE id=$1", [after.grant_id]);
    await expect(queueChildContinuations(pool, f.task.id)).rejects.toMatchObject({ code: "MEMBERSHIP_INACTIVE" });
    expect((await pool.query("SELECT grant_id FROM agents_platform.tasks WHERE id=$1", [child.taskId])).rows[0].grant_id).toBe(after.grant_id);
  });

  it("refreshes an expired queued child lease and bypasses a cached failed resume without changing the waiting generation", async () => {
    const f = await fixture(null, 2, true), child = (await startSpecialist(pool, f.task.id, "queued-lease", request)).children[0]!;
    await pool.query("UPDATE agents_platform.tasks SET state='waiting_authority' WHERE id=$1", [child.taskId]);
    await queueChildContinuations(pool, f.task.id);
    const first = (await pool.query("SELECT grant_id,control_generation FROM agents_platform.tasks WHERE id=$1", [child.taskId])).rows[0];
    await pool.query("UPDATE agents_platform.execution_grants SET expires_at=created_at+interval '1 millisecond' WHERE id=$1", [first.grant_id]);
    await pool.query("UPDATE agents_platform.task_outbox SET dispatched_at=now() WHERE task_id IN (SELECT id FROM agents_platform.tasks WHERE root_task_id=$1)", [f.task.id]);
    const attempts: { key: string; generation: number; status: number }[] = [], cached = new Map<string, number>();
    let wakes = 0;
    const dispatch = () => dispatchTasksOnce(pool, { ingressUrl: "http://runtime.fixture", adminUrl: "http://runtime.fixture",
      runtimeRoutes: { [HARNESS_RELEASE]: { ingressUrl: "http://runtime.fixture", adminUrl: "http://runtime.fixture", workflowName: WORKFLOW_NAME } },
      fetch: (async (url, init) => {
        if (!String(url).endsWith(`/${child.taskId}/resume`)) return Response.json({ accepted: true });
        const key = new Headers(init?.headers).get("idempotency-key")!;
        let status = cached.get(key);
        if (status === undefined) {
          const row = (await pool.query("SELECT g.expires_at FROM agents_platform.tasks t JOIN agents_platform.execution_grants g ON g.id=t.grant_id WHERE t.id=$1", [child.taskId])).rows[0];
          status = row.expires_at.getTime() <= Date.now() ? 403 : 200; cached.set(key, status);
          if (status === 200) wakes++;
        }
        attempts.push({ key, generation: JSON.parse(String(init?.body)).generation, status });
        return Response.json({ accepted: status === 200 }, { status });
      }) as typeof fetch,
    });
    await dispatch();
    expect(attempts).toHaveLength(1); expect(attempts[0]!.status).toBe(403);
    await queueChildContinuations(pool, f.task.id);
    const renewed = (await pool.query("SELECT grant_id,control_generation FROM agents_platform.tasks WHERE id=$1", [child.taskId])).rows[0];
    expect(renewed.grant_id).not.toBe(first.grant_id); expect(renewed.control_generation).toBe(first.control_generation);
    await dispatch();
    expect(attempts).toHaveLength(2); expect(attempts[1]!.status).toBe(200);
    expect(attempts[1]!.key).not.toBe(attempts[0]!.key); expect(attempts[1]!.generation).toBe(attempts[0]!.generation);
    await queueChildContinuations(pool, f.task.id); await dispatch();
    expect(wakes).toBe(1);
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.task_controls WHERE task_id=$1", [child.taskId])).rows[0].count).toBe(1);
  });

  it("separates concurrency from lifetime budget and keeps cancellation scoped to a child", async () => {
    const f = await fixture(2, 1), first = (await startSpecialist(pool, f.task.id, "start:one", request)).children[0]!;
    await expect(startSpecialist(pool, f.task.id, "start:busy", request)).rejects.toMatchObject({ code: "CHILD_LIMIT" });
    expect(await cancelSpecialist(pool, f.task.id, first.taskId)).toMatchObject({ state: "cancel_requested" });
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1", [f.task.id])).rows[0].state).toBe("accepted");
    await settleTask(pool, first.taskId, { state: "cancelled" });
    const second = (await startSpecialist(pool, f.task.id, "start:two", request)).children[0]!;
    await complete(second.taskId, "Replacement succeeded");
    await expect(startSpecialist(pool, f.task.id, "start:three", request)).rejects.toMatchObject({ code: "SPECIALIST_TASK_LIMIT" });
    await complete(f.task.id, "Recovered successfully");
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1", [f.task.id])).rows[0].state).toBe("completed");
  });

  it("lets one progressing work item exceed the former model, tool and specialist ceilings", async () => {
    const f = await fixture(null, 1, true);
    for (let index = 0; index < 50; index++) {
      for(const kind of ["model","tool"] as const) {
        const id=`unlimited:${f.task.id}:${kind}:${index}`;
        const admission=await beginOperation(pool,f.task.id,{id,kind,name:kind==="model"?"model.generate":"agents.status",request:{index},reservedTokens:kind==="model"?20:0,reservedMs:1000});
        if(admission.waiting)throw Error("Unexpected capacity wait");
        await finishOperation(pool,f.task.id,id,"completed",{finding:index},null,kind==="model"?3:0,admission.operation.attempt_id);
      }
      if(index<17) {
        const child = (await startSpecialist(pool, f.task.id, `unlimited:${index}`, request)).children[0]!;
        await complete(child.taskId, `Finding ${index}`);
      }
    }
    const status = await specialistStatus(pool, f.task.id);
    expect(status.children).toHaveLength(17);
    expect(status.children.every(child => child.state === "completed")).toBe(true);
    const usage=(await pool.query("SELECT t.model_calls,t.tool_calls,r.model_calls AS shared_model_calls,r.tool_calls AS shared_tool_calls FROM agents_platform.tasks t JOIN agents_platform.execution_roots r ON r.root_task_id=t.id WHERE t.id=$1",[f.task.id])).rows[0];
    expect(usage).toMatchObject({model_calls:50,shared_model_calls:50});
    expect(usage.tool_calls).toBeGreaterThanOrEqual(50);expect(usage.shared_tool_calls).toBeGreaterThanOrEqual(50);
    await complete(f.task.id,"All17 specialist findings retained after50 model and50 tool operations");
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0].state).toBe("completed");
  }, 30000);

  it("runs a specialist beyond the former cumulative token allocation using bounded operation reservations", async () => {
    const f = await fixture(null, 1, true);
    const child = (await startSpecialist(pool, f.task.id, "rolling:start", request)).children[0]!;
    for (let index = 0; index < 65; index++) {
      const id = `rolling:${child.taskId}:${index}`;
      const admission = await beginOperation(pool,child.taskId,{id,kind:"model",name:"model.generate",request:{index},reservedTokens:1000,reservedMs:1000});
      if (admission.waiting) throw Error("Unexpected capacity wait");
      await finishOperation(pool,child.taskId,id,"completed",{finding:index},null,800,admission.operation.attempt_id);
    }
    expect((await pool.query("SELECT root_token_limit,allocation_active_ms,tokens_used,model_calls FROM agents_platform.tasks WHERE id=$1",[child.taskId])).rows[0])
      .toMatchObject({root_token_limit:null,allocation_active_ms:null,tokens_used:52000,model_calls:65});
    expect((await pool.query("SELECT tokens_used,tokens_reserved,child_reserved_tokens,child_reserved_ms FROM agents_platform.execution_roots WHERE root_task_id=$1",[f.task.id])).rows[0])
      .toMatchObject({tokens_used:52000,tokens_reserved:0,child_reserved_tokens:0,child_reserved_ms:0});
    await complete(child.taskId,"All findings preserved");
    await complete(f.task.id,"Completed");
    expect((await pool.query("SELECT reserved_tokens,consumed_tokens FROM agents_platform.usage_accounts WHERE organization_id=$1",[f.scope.organizationId])).rows[0])
      .toMatchObject({reserved_tokens:0,consumed_tokens:52000});
  },30000);

  it("serializes member corrections against final input closure",async()=>{
    const f=await fixture(),outcome={state:"completed" as const,output:"Confirmed result"};
    const [closed,queued]=await Promise.allSettled([
      closeOrchestrationInstructions(pool,f.task.id,[],outcome),
      queueOrchestrationInstruction(pool,f.task.id,{instruction:"Use the updated requirement",requestKey:randomUUID()}),
    ]);
    expect(closed.status).toBe("fulfilled");
    if(closed.status!=="fulfilled")throw closed.reason;
    if(closed.value) {
      expect(queued.status).toBe("rejected");
      if(queued.status==="rejected")expect(queued.reason).toMatchObject({code:"TASK_TERMINAL"});
    } else {
      expect(queued.status).toBe("fulfilled");
      const groups=await orchestrationInstructionGroups(pool,f.task.id,[]);
      expect(groups).toHaveLength(1);
      expect(await closeOrchestrationInstructions(pool,f.task.id,groups.map(group=>group.id),outcome)).toBe(true);
    }
    expect(await closeOrchestrationInstructions(pool,f.task.id,[],outcome)).toBe(true);
    await expect(closeOrchestrationInstructions(pool,f.task.id,[],{state:"completed",output:"Changed intent"})).rejects.toMatchObject({code:"OPERATION_CONFLICT"});
  });

  it("rejects another root and revoked access, and never hides uncertain child effects", async () => {
    const f = await fixture(), other = await fixture(), child = (await startSpecialist(pool, f.task.id, "start:one", request)).children[0]!;
    await expect(specialistStatus(pool, other.task.id, [child.taskId])).rejects.toMatchObject({ code: "SPECIALIST_SCOPE_DENIED" });
    await expect(cancelSpecialist(pool, other.task.id, child.taskId)).rejects.toMatchObject({ code: "SPECIALIST_SCOPE_DENIED" });
    await settleTask(pool, child.taskId, { state: "uncertain", errorCode: "UNCONFIRMED_EFFECT" });
    await expect(startSpecialist(pool,f.task.id,"start:after-uncertain",request)).rejects.toMatchObject({code:"SPECIALIST_OUTCOME_UNCERTAIN"});
    await expect(followupSpecialist(pool,f.task.id,"followup:uncertain",{taskId:child.taskId,brief:"Retry"})).rejects.toMatchObject({code:"SPECIALIST_OUTCOME_UNCERTAIN"});
    await settleTask(pool, f.task.id, { state: "completed", output: "Must not assert success" });
    expect((await pool.query("SELECT state,output FROM agents_platform.tasks WHERE id=$1", [f.task.id])).rows[0]).toEqual({ state: "uncertain", output: null });
    await pool.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1", [other.grant.id]);
    await expect(specialistStatus(pool, other.task.id)).rejects.toMatchObject({ code: "GRANT_REVOKED" });
  });
});
