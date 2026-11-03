import { contextGrantCeiling } from "../src/execution/models/settings";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlatformStore } from "../src/product/agents/store";
import { AdmissionStore } from "../src/execution/admission/admission-store";
import { defaultBusinessConfiguration, executionGrantSchema } from "../src/contracts/contracts";
import { beginOperation, finishOperation, settleTask, transaction } from "../src/execution/lifecycle/execution";
import { executionAllowanceObservation } from "../src/execution/lifecycle/work-policy";
import { loadExecution } from "../src/execution/lifecycle/state";
import { continueWorkInTransaction } from "../src/execution/lifecycle/work-continuation";
import { setupPlatformSchema } from "../src/composition/setup";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("optional execution allowances and actual-operation accounting", () => {
  let admin: Pool, pool: Pool, store: PlatformStore;
  const database = `agents_optional_limits_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url }); await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href }); await setupPlatformSchema(pool); store = new PlatformStore(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  async function fixture(limits: Record<string, number | null> = {}, grantRootTokenLimit: number | null = null) {
    const account = await store.ensureAccount({ issuer: "http://localhost:8080/realms/kasitek", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Optional limits fixture"), scope = { accountId: account.id, organizationId: org.id };
    await connectFixtureModel(pool, account.id, org.id);
    const configuration = defaultBusinessConfiguration();
    const agent = await store.createAgent({ ...scope, name: "Research", configuration });
    const version = await store.createVersion({ ...scope, agentId: agent.id, expectedRevision: 1 });
    const authority = { product: "agents" as const, organizationId: org.id, resourceId: agent.id, callerClientId: "agents-execution", principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } };
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id, operations: ["model.reply", "knowledge.read"], sourceRevisionIds: [], maxInputBytes: configuration.model.maxInputBytes, maxOutputTokens: configuration.model.maxOutputTokens, maxContextTokens: contextGrantCeiling(configuration), rootTokenLimit: grantRootTokenLimit, expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null });
    await store.createGrant({ ...scope, grant });
    const prior = process.env.AGENTS_MODEL_POLICY_JSON;
    try {
      process.env.AGENTS_MODEL_POLICY_JSON = JSON.stringify(limits);
      const { task } = await store.admitTask({ authority, grantId: grant.id, versionId: version.id, requestKey: randomUUID(), input: "Investigate" });
      return { task, authority, grant };
    } finally { if (prior === undefined) delete process.env.AGENTS_MODEL_POLICY_JSON; else process.env.AGENTS_MODEL_POLICY_JSON = prior; }
  }
  function request(taskId: string, key: string, kind: "model" | "tool" = "model", reservedTokens = 20) {
    return { id: `${kind}:${taskId}:${key}`, kind, name: kind === "model" ? "model.generate" : "knowledge.search", request: { query: key }, reservedTokens, reservedMs: 1000 };
  }
  async function execute(taskId: string, key: string, kind: "model" | "tool" = "model", tokens = 3) {
    const input = request(taskId,key,kind), admission = await beginOperation(pool,taskId,input);
    expect(admission.waiting).not.toBe(true);
    if (admission.waiting) throw Error("Unexpected capacity wait");
    await finishOperation(pool,taskId,input.id,"completed",{ value: key },null,tokens,admission.operation.attempt_id);
    return input;
  }

  it("runs beyond both former call ceilings with no default count cap", async () => {
    const { task } = await fixture();
    for (let index = 0; index < 50; index++) await execute(task.id,`model-${index}`);
    for (let index = 0; index < 50; index++) await execute(task.id,`tool-${index}`,"tool");
    const row = (await pool.query("SELECT model_calls,tool_calls,tokens_used,tokens_reserved FROM agents_platform.tasks WHERE id=$1",[task.id])).rows[0];
    expect(row).toMatchObject({ model_calls:50,tool_calls:50,tokens_used:300,tokens_reserved:0 });
  },30000);

  it("enforces independently configured local and shared ceilings with exact reasons", async () => {
    for (const [field,kind,code] of [["maxModelCalls","model","MODEL_CALL_LIMIT"],["maxRootModelCalls","model","ROOT_MODEL_CALL_LIMIT"],["maxToolCalls","tool","TOOL_CALL_LIMIT"],["maxRootToolCalls","tool","ROOT_TOOL_CALL_LIMIT"]] as const) {
      const { task } = await fixture({[field]:1});
      await execute(task.id,"one",kind);
      await expect(beginOperation(pool,task.id,request(task.id,"two",kind))).rejects.toMatchObject({code});
      const opposite = kind === "model" ? "tool" : "model";
      await execute(task.id,"independent",opposite);
    }
  },30000);

  it("reserves null-root operations against quota, settles actual usage and replays without double charge", async () => {
    const { task, authority } = await fixture();
    const quota = async () => (await pool.query("SELECT reserved_tokens,consumed_tokens FROM agents_platform.usage_accounts WHERE organization_id=$1",[authority.organizationId])).rows[0];
    expect(await quota()).toMatchObject({reserved_tokens:0,consumed_tokens:0});
    const input = request(task.id,"quota","model",100);
    await pool.query("UPDATE agents_platform.usage_accounts SET token_allowance=99 WHERE organization_id=$1",[authority.organizationId]);
    await expect(beginOperation(pool,task.id,input)).rejects.toMatchObject({code:"QUOTA_EXCEEDED"});
    expect(await quota()).toMatchObject({reserved_tokens:0,consumed_tokens:0});
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.operations WHERE id=$1",[input.id])).rows[0].count).toBe(0);
    await pool.query("UPDATE agents_platform.usage_accounts SET token_allowance=100 WHERE organization_id=$1",[authority.organizationId]);
    const admission = await beginOperation(pool,task.id,input);
    expect(await quota()).toMatchObject({reserved_tokens:100,consumed_tokens:0});
    if(admission.waiting) throw Error("Unexpected capacity wait");
    await finishOperation(pool,task.id,input.id,"completed",{value:"receipt"},null,7,admission.operation.attempt_id);
    expect(await quota()).toMatchObject({reserved_tokens:7,consumed_tokens:0});
    expect(await beginOperation(pool,task.id,input)).toMatchObject({replayed:true});
    await finishOperation(pool,task.id,input.id,"completed",{value:"receipt"},null,7,admission.operation.attempt_id);
    expect(await quota()).toMatchObject({reserved_tokens:7,consumed_tokens:0});
    await settleTask(pool,task.id,{state:"completed",output:"Done"});
    await settleTask(pool,task.id,{state:"completed",output:"Done"});
    expect(await quota()).toMatchObject({reserved_tokens:0,consumed_tokens:7});
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.operation_usage WHERE operation_id=$1",[input.id])).rows[0].count).toBe(1);
  });

  it.each([
    { kinds: ["model"], alreadyUncertain: false, code: "MODEL_OUTCOME_UNCERTAIN" },
    { kinds: ["compaction"], alreadyUncertain: false, code: "MODEL_OUTCOME_UNCERTAIN" },
    { kinds: ["model"], alreadyUncertain: true, code: "MODEL_OUTCOME_UNCERTAIN" },
    { kinds: ["model", "tool"], alreadyUncertain: false, code: "OPERATION_OUTCOME_UNCERTAIN" },
    { kinds: ["tool"], alreadyUncertain: false, code: "OPERATION_OUTCOME_UNCERTAIN" },
  ] as const)("classifies stopped $kinds uncertainty precisely (previously uncertain: $alreadyUncertain)", async ({ kinds, alreadyUncertain, code }) => {
    const { task, authority, grant } = await fixture();
    await execute(task.id,"completed-read","tool");
    for (const [index,kind] of kinds.entries()) {
      const input = { ...request(task.id,`interrupted-${index}`,kind==="tool"?"tool":"model"),kind };
      const admitted = await beginOperation(pool,task.id,input);
      if(admitted.waiting) throw Error("Unexpected capacity wait");
      if(alreadyUncertain) await finishOperation(pool,task.id,input.id,"uncertain",null,"MODEL_OUTCOME_UNCERTAIN",input.reservedTokens,admitted.operation.attempt_id);
    }
    await settleTask(pool,task.id,{state:"cancelled"});
    expect((await pool.query("SELECT state,error_code,tokens_used,tokens_reserved FROM agents_platform.tasks WHERE id=$1",[task.id])).rows[0])
      .toMatchObject({state:"uncertain",error_code:code,tokens_used:3+20*kinds.length,tokens_reserved:0});
    const interrupted = (await pool.query("SELECT o.state,u.accounted_tokens FROM agents_platform.operations o JOIN agents_platform.operation_usage u ON u.operation_id=o.id WHERE o.task_id=$1 AND o.state='uncertain'",[task.id])).rows;
    expect(interrupted).toHaveLength(kinds.length);
    expect(interrupted.every(op=>op.state==="uncertain" && op.accounted_tokens===20)).toBe(true);
    expect((await pool.query("SELECT reserved_tokens,consumed_tokens FROM agents_platform.usage_accounts WHERE organization_id=$1",[authority.organizationId])).rows[0])
      .toMatchObject({reserved_tokens:0,consumed_tokens:3+20*kinds.length});
    await expect(transaction(pool,db=>continueWorkInTransaction(db,new AdmissionStore(pool),{priorTaskId:task.id,authority,grantId:grant.id,requestKey:randomUUID()})))
      .rejects.toMatchObject({code:"WORK_CONTINUATION_UNAVAILABLE"});
  });

  it("preserves cumulative call allowances across a linked continuation", async () => {
    for (const [field,code] of [["maxRootModelCalls","ROOT_MODEL_CALL_LIMIT"],["maxModelCalls","MODEL_CALL_LIMIT"]] as const) {
      const f = await fixture({[field]:2});
      await execute(f.task.id,"prior");
      await settleTask(pool,f.task.id,{state:"incomplete",errorCode:"ORCHESTRATION_STALLED",output:"Known finding"});
      const next = await transaction(pool,db => continueWorkInTransaction(db,new AdmissionStore(pool),{priorTaskId:f.task.id,authority:f.authority,grantId:f.grant.id,requestKey:randomUUID()}));
      expect(next.task.work_id).toBe(f.task.work_id);
      await execute(next.task.id,"continued");
      await expect(beginOperation(pool,next.task.id,request(next.task.id,"beyond"))).rejects.toMatchObject({code});
    }
  });

  it("does not deadlock null-root operation reservations with another admission on the same conversation", async () => {
    const f = await fixture();
    let releaseOperation!: () => void, signalConversation!: () => void;
    const conversationLocked = new Promise<void>(resolve => { signalConversation = resolve; });
    const operationGate = new Promise<void>(resolve => { releaseOperation = resolve; });
    const operationPool = new Proxy(pool, { get(target, property) {
      if (property !== "connect") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
      return async () => {
        const client = await pool.connect();
        return new Proxy(client, { get(connection, key) {
          if (key !== "query") { const value = Reflect.get(connection, key); return typeof value === "function" ? value.bind(connection) : value; }
          return async (...args: any[]) => {
            const result = await (client.query as any)(...args);
            if (String(args[0]).startsWith("SELECT deleted_at FROM agents_platform.conversations")) { signalConversation(); await operationGate; }
            return result;
          };
        } });
      };
    } });
    let admissionPid: number | undefined;
    const admissionPool = new Proxy(pool, { get(target, property) {
      if (property !== "connect") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
      return async () => { const client = await pool.connect(); admissionPid = (client as any).processID; return client; };
    } });
    const operation = beginOperation(operationPool, f.task.id, request(f.task.id, "admission-race"));
    await conversationLocked;
    const admitted = new AdmissionStore(admissionPool).admitTask({ authority: f.authority, grantId: f.grant.id,
      versionId: f.task.version_id, conversationId: f.task.conversation_id, input: "Another request", requestKey: randomUUID() });
    // Register rejection immediately; PostgreSQL may choose either participant as a deadlock victim.
    const outcomes = Promise.allSettled([operation, admitted]);
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 80 && !waiting; attempt++) {
        if (admissionPid) waiting = Boolean((await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [admissionPid])).rowCount);
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
    } finally { releaseOperation(); }
    const results = await outcomes;
    expect(results[0]!.status).toBe("fulfilled");
    for (const result of results) if (result.status === "rejected") expect(result.reason.code).not.toBe("40P01");
  }, 10000);

  it("has no implicit work wall deadline while preserving an explicit deadline through continuation", async () => {
    const unlimited = await fixture();
    expect((await pool.query("SELECT deadline_at FROM agents_platform.tasks WHERE id=$1",[unlimited.task.id])).rows[0].deadline_at).toBeNull();
    await execute(unlimited.task.id,"bounded-physical-call");
    const finite = await fixture({maxWallDurationMs:600000});
    const original = (await pool.query("SELECT deadline_at,created_at FROM agents_platform.tasks WHERE id=$1",[finite.task.id])).rows[0];
    expect(original.deadline_at.getTime()-original.created_at.getTime()).toBe(600000);
    await execute(finite.task.id,"prior-wall");
    await settleTask(pool,finite.task.id,{state:"incomplete",errorCode:"ORCHESTRATION_STALLED"});
    const next = await transaction(pool,db => continueWorkInTransaction(db,new AdmissionStore(pool),{priorTaskId:finite.task.id,authority:finite.authority,grantId:finite.grant.id,requestKey:randomUUID()}));
    expect((await pool.query("SELECT deadline_at FROM agents_platform.tasks WHERE id=$1",[next.task.id])).rows[0].deadline_at).toEqual(original.deadline_at);
    await pool.query("UPDATE agents_platform.tasks SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",[next.task.id]);
    await expect(beginOperation(pool,next.task.id,request(next.task.id,"expired-wall"))).rejects.toMatchObject({code:"TASK_DEADLINE"});
  });

  it.each([64000, null])("continues a broader %s-token grant while retaining its narrower accepted platform allowance", async grantLimit => {
    const f = await fixture({ maxRootTokens: 32000, maxInputTokens: 8192, maxOutputTokens: 4096, compactAtTokens: 6144, maxRootModelCalls: 4 }, grantLimit);
    expect(f.task.root_token_limit).toBe(32000);
    await execute(f.task.id, "before-continuation");
    await settleTask(pool, f.task.id, { state: "incomplete", errorCode: "ORCHESTRATION_STALLED", output: "Confirmed finding" });
    const next = await transaction(pool, db => continueWorkInTransaction(db, new AdmissionStore(pool), {
      priorTaskId: f.task.id, authority: f.authority, grantId: f.grant.id, requestKey: randomUUID(),
    }));
    const execution = await loadExecution(pool, next.task.id);
    expect(execution.task.root_token_limit).toBe(32000);
    expect(execution.models.primary.policy).toMatchObject({ maxRootTokens: 32000, maxRootModelCalls: 4 });
    expect(await executionAllowanceObservation(pool, execution)).toMatchObject({ workTokens: 31997, workModelCalls: 3 });
    await expect(beginOperation(pool, next.task.id, request(next.task.id, "over-remaining-tokens", "model", 31998))).rejects.toMatchObject({ code: "ROOT_TOKEN_LIMIT" });
    for (let index = 0; index < 3; index++) await execute(next.task.id, `continued-${index}`);
    await expect(beginOperation(pool, next.task.id, request(next.task.id, "over-remaining-calls"))).rejects.toMatchObject({ code: "ROOT_MODEL_CALL_LIMIT" });
  });

  it("serializes simultaneous claims against the shared finite allowance", async () => {
    const {task} = await fixture({maxRootModelCalls:1});
    const results = await Promise.allSettled([beginOperation(pool,task.id,request(task.id,"race-a")),beginOperation(pool,task.id,request(task.id,"race-b"))]);
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    const rejected=results.find(result=>result.status==="rejected");
    expect(rejected && rejected.status==="rejected" && rejected.reason).toMatchObject({code:"ROOT_MODEL_CALL_LIMIT"});
    expect((await pool.query("SELECT model_calls,tokens_reserved FROM agents_platform.execution_roots WHERE root_task_id=$1",[task.id])).rows[0]).toMatchObject({model_calls:1,tokens_reserved:20});
  });
});
