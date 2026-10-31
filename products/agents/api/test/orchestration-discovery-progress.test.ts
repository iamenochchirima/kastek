import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlatformStore } from "../src/product/agents/store";
import { defaultBusinessConfiguration, executionGrantSchema } from "../src/contracts/contracts";
import { orchestrationTools } from "../src/contracts/orchestration";
import { setupPlatformSchema } from "../src/composition/setup";
import { executeWorkTool, queueOrchestrationInstruction, readOrchestrationInstructions, orchestrationStalled } from "../src/execution/delegation/progress";
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
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id, operations: ["model.reply", "knowledge.read", "delegation.execute"], sourceRevisionIds: [], maxInputBytes: config.model.maxInputBytes, maxOutputTokens: config.model.maxOutputTokens, maxContextTokens: config.context.maxInputTokens, expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null });
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
  it("does not flag a fresh request or active specialist as stalled", async () => {
    const f = await fixture(); expect(await orchestrationStalled(pool, f.task.id)).toBe(false);
    await startSpecialist(pool, f.task.id, "start:active", { requests: [{ bindingId: "specialist_0", brief: "Investigate" }] });
    expect(await orchestrationStalled(pool, f.task.id)).toBe(false);
  });
});
