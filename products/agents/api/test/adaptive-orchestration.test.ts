import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlatformStore } from "../src/product/agents/store";
import { defaultBusinessConfiguration, executionGrantSchema } from "../src/contracts/contracts";
import { setupPlatformSchema } from "../src/composition/setup";
import { cancelSpecialist, followupSpecialist, specialistResult, specialistStatus, startSpecialist } from "../src/execution/delegation/adaptive";
import { settleTask } from "../src/execution/lifecycle/execution";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

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
  async function fixture(maxTasks = 8, maxChildren = 2) {
    const account = await store.ensureAccount({ issuer: "http://localhost:8080/realms/kasitek", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Adaptive fixture"), scope = { accountId: account.id, organizationId: org.id };
    await connectFixtureModel(pool, account.id, org.id);
    const specialist = await store.createAgent({ ...scope, name: "Specialist", configuration: defaultBusinessConfiguration() });
    const childVersion = await store.createVersion({ ...scope, agentId: specialist.id, expectedRevision: 1 });
    const configuration = defaultBusinessConfiguration();
    configuration.program = { id: "tool-directed", version: "4" };
    configuration.tools = ["agents.start", "agents.status", "agents.result", "agents.wait", "agents.followup", "agents.cancel"];
    configuration.capabilities.delegation = { enabled: true, maxChildren, maxDepth: 1, policy: { maxTasks, maxStalls: 3 }, bindings: [
      { id: "specialist", versionId: childVersion.id, sourceRevisionIds: [], connectedToolBindingIds: [], tools: [], maxTokens: 8000, maxActiveMs: 120000 },
    ] };
    const agent = await store.createAgent({ ...scope, name: "Coordinator", configuration });
    const version = await store.createVersion({ ...scope, agentId: agent.id, expectedRevision: 1 });
    const authority = { product: "agents" as const, organizationId: org.id, resourceId: agent.id, callerClientId: "agents-execution", principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } };
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id, operations: ["model.reply", "knowledge.read", "delegation.execute"], sourceRevisionIds: [], maxInputBytes: configuration.model.maxInputBytes, maxOutputTokens: configuration.model.maxOutputTokens, maxContextTokens: configuration.context.maxInputTokens, expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null });
    await store.createGrant({ ...scope, grant });
    const { task } = await store.admitTask({ authority, grantId: grant.id, versionId: version.id, requestKey: randomUUID(), input: "Investigate and revise" });
    return { task, scope, grant };
  }
  async function complete(id: string, output: string) {
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1", [id]);
    await settleTask(pool,id,{state:"completed",output});
  }
  const request = { requests: [{ bindingId: "specialist", brief: "Produce a draft" }] };

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
