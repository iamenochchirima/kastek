import { contextGrantCeiling } from "../src/execution/models/settings";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration, type AgentConfiguration } from "../src/contracts/contracts";
import { PlatformStore } from "../src/product/agents/store";
import { operationsForConfiguration } from "../src/platform/access/grant-operations";
import { executeTool, publishedToolBindings, toolsFor } from "../src/capabilities/tools";
import { visibleTaskControlTools } from "../src/capabilities/task-control";
import { validateBuiltinArguments, validateBuiltinResult } from "../src/capabilities/tool-contracts";
import { assertCurrentAuthority, loadExecution, settleTask } from "../src/execution/lifecycle/execution";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("bounded prior task controls", () => {
  let admin: Pool, pool: Pool, store: PlatformStore;
  const databaseName = `agents_task_control_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.href, max: 10 }); await setupPlatformSchema(pool); store = new PlatformStore(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, databaseName); await admin.end(); } });
  async function fixture() {
    const account = await store.ensureAccount({ issuer: "https://task-control.fixture.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Task controls");
    await connectFixtureModel(pool, account.id, org.id);
    const configuration: AgentConfiguration = { ...defaultBusinessConfiguration(), program: { id: "tool-directed", version: "2" }, tools: ["tasks.inspect", "tasks.cancel"] };
    // An ordinary agent has exactly the same authority as the provisioned Assistant.
    const agent = await store.createAgent({ accountId: account.id, organizationId: org.id, name: "Ordinary task controller", configuration });
    const version = await store.createVersion({ accountId: account.id, organizationId: org.id, agentId: agent.id, expectedRevision: 1 });
    const admit = async (identity = account, selectedAgent = agent, selectedVersion = version) => {
      const authority = { product: "agents" as const, organizationId: org.id, resourceId: selectedAgent.id, callerClientId: "agents-execution", principal: { kind: "human" as const, issuer: identity.issuer, subject: identity.subject } };
      const grant = await store.createGrant({ accountId: identity.id, grant: { ...authority, id: randomUUID(), versionId: selectedVersion.id,
        operations: operationsForConfiguration(configuration, true), maxInputBytes: configuration.model.maxInputBytes,
        maxOutputTokens: configuration.model.maxOutputTokens, maxContextTokens: contextGrantCeiling(configuration),
        expiresAt: new Date(Date.now() + 300_000).toISOString(), revokedAt: null } });
      return (await store.admitTask({ authority, versionId: selectedVersion.id, grantId: grant.id, requestKey: randomUUID(), input: "PRIVATE_TASK_INPUT" })).task;
    };
    return { account, org, agent, version, configuration, admit };
  }
  const call = (taskId: string, name: "tasks.inspect" | "tasks.cancel", args: object, operationId = randomUUID()) => executeTool(pool, {} as never, taskId, operationId, name, JSON.stringify(args));
  it("publishes bounded contracts, aliases and grant operations", () => {
    const configuration: AgentConfiguration = { ...defaultBusinessConfiguration(), program: { id: "tool-directed", version: "2" }, tools: ["tasks.inspect", "tasks.cancel"] };
    expect(toolsFor(configuration).map(tool => tool.function.name)).toEqual(["tasks_inspect", "tasks_cancel"]);
    expect(publishedToolBindings(configuration)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "tasks.inspect", version: "1", digest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ name: "tasks.cancel", version: "1", digest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]));
    expect(operationsForConfiguration(configuration, true)).toEqual(expect.arrayContaining(["tasks.read", "tasks.cancel"]));
    expect(operationsForConfiguration(configuration)).not.toEqual(expect.arrayContaining(["tasks.read", "tasks.cancel"]));
    expect(() => validateBuiltinArguments("tasks.inspect", { limit: 11 })).toThrow();
    expect(() => validateBuiltinArguments("tasks.cancel", {})).toThrow();
    expect(() => validateBuiltinArguments("tasks.inspect", { principal: "someone else" })).toThrow();
    expect(() => validateBuiltinResult("tasks.inspect", { tasks: [], output: "private" })).toThrow();
  });
  it("keeps accepted version-one work pinned when optional version-two task tools are added", async () => {
    const f=await fixture(),configuration=defaultBusinessConfiguration();
    const agent=await store.createAgent({accountId:f.account.id,organizationId:f.org.id,name:"Existing business agent",configuration});
    const version=await store.createVersion({accountId:f.account.id,organizationId:f.org.id,agentId:agent.id,expectedRevision:1});
    const task=await f.admit(f.account,agent,version);
    await store.saveConfiguration({accountId:f.account.id,organizationId:f.org.id,agentId:agent.id,expectedRevision:1,
      configuration:{...configuration,program:{id:"tool-directed",version:"2"},tools:["tasks.inspect"]},confirmImpact:true});
    expect((await pool.query("SELECT revoked_at FROM agents_platform.execution_grants WHERE id=$1",[task.grant_id])).rows[0].revoked_at).toBeNull();
    const execution=await loadExecution(pool,task.id);
    expect(execution.configuration.program).toEqual({id:"tool-directed",version:"1"});
    await expect(assertCurrentAuthority(pool,execution)).resolves.toBeUndefined();
  });
  it("lists only bounded earlier roots without transcripts or outputs", async () => {
    const f = await fixture(), earlier = [];
    for (let index = 0; index < 12; index++) { const task = await f.admit(); earlier.push(task); await settleTask(pool, task.id, { state: "cancelled" }); }
    const current = await f.admit(), later = await f.admit();
    const result = await call(current.id, "tasks.inspect", {}) as { tasks: { id: string }[] };
    expect(result.tasks).toHaveLength(10);
    expect(result.tasks.map(task => task.id)).not.toContain(current.id);
    expect(result.tasks.map(task => task.id)).not.toContain(later.id);
    expect(Object.keys(result.tasks[0]!).sort()).toEqual(["createdAt", "id", "state", "updatedAt"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_TASK_INPUT");
    expect(await call(current.id, "tasks.inspect", { limit: 1 })).toMatchObject({ tasks: [{ id: earlier.at(-1)!.id }] });
    expect(await call(current.id, "tasks.inspect", { taskId: earlier[0]!.id })).toMatchObject({ tasks: [{ id: earlier[0]!.id }] });
    expect(await call(current.id, "tasks.inspect", { taskId: current.id })).toEqual({ tasks: [] });
    expect(await call(current.id, "tasks.inspect", { taskId: later.id })).toEqual({ tasks: [] });
  });
  it("requests prior-root cancellation once and truthfully reports settled work", async () => {
    const f = await fixture(), prior = await f.admit(), current = await f.admit(), operation = randomUUID();
    expect(await call(current.id, "tasks.cancel", { taskId: prior.id }, operation)).toEqual({ taskId: prior.id, state: "cancel_requested",taskState:"cancel_requested" });
    expect(await call(current.id, "tasks.cancel", { taskId: prior.id }, operation)).toEqual({ taskId: prior.id, state: "cancel_requested",taskState:"cancel_requested" });
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1", [prior.id])).rows[0].state).toBe("cancel_requested");
    expect((await pool.query("SELECT sequence FROM agents_platform.task_events WHERE task_id=$1 AND kind='cancel_requested'", [prior.id])).rows).toHaveLength(1);
    await settleTask(pool, prior.id, { state: "cancelled" });
    expect(await call(current.id, "tasks.cancel", { taskId: prior.id })).toEqual({ taskId: prior.id, state: "already_terminal",taskState:"cancelled" });
    await expect(call(current.id, "tasks.cancel", { taskId: current.id })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
  it("retains an uncertain outcome rather than claiming that earlier work settled", async () => {
    const f=await fixture(),prior=await f.admit();
    await settleTask(pool,prior.id,{state:"uncertain",errorCode:"FIXTURE_UNKNOWN"});
    const current=await f.admit();
    expect(await call(current.id,"tasks.cancel",{taskId:prior.id})).toEqual({taskId:prior.id,state:"already_terminal",taskState:"uncertain"});
  });
  it("denies another member, organization and agent without disclosing a task", async () => {
    const f = await fixture(), other = await fixture(), foreign = await other.admit();
    const member = await store.ensureAccount({ issuer: f.account.issuer, subject: randomUUID(), email: "member@example.test", displayName: "Member" });
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')", [f.org.id, member.id]);
    const memberTask = await f.admit(member); await settleTask(pool, memberTask.id, { state: "cancelled" });
    const otherAgent = await store.createAgent({ accountId: f.account.id, organizationId: f.org.id, name: "Different agent", configuration: f.configuration });
    const otherVersion = await store.createVersion({ accountId: f.account.id, organizationId: f.org.id, agentId: otherAgent.id, expectedRevision: 1 });
    const otherAgentTask = await f.admit(f.account, otherAgent, otherVersion); await settleTask(pool, otherAgentTask.id, { state: "cancelled" });
    const current = await f.admit();
    for (const target of [foreign, memberTask, otherAgentTask]) {
      expect(await call(current.id, "tasks.inspect", { taskId: target.id })).toEqual({ tasks: [] });
      await expect(call(current.id, "tasks.cancel", { taskId: target.id })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    }
  });
  it.each(["visitor", "automation", "child", "trial", "foreign_product"])("hides tools for %s execution context", async kind => {
    const f = await fixture(), current = await f.admit();
    const execution = await loadExecution(pool, current.id);
    if (kind === "visitor") execution.task.principal = { kind: "visitor", deploymentId: randomUUID(), sessionId: randomUUID() };
    if (kind === "automation") execution.task.principal = { kind: "automation", id: randomUUID(), ownerAccountId: f.account.id };
    if (kind === "child") execution.task.parent_task_id = randomUUID();
    if (kind === "trial") execution.task.evaluation_trial_id = randomUUID();
    if (kind === "foreign_product") execution.task.product = "growth";
    expect(await visibleTaskControlTools(pool, execution, toolsFor(f.configuration))).toEqual([]);
  });
  it("rechecks current membership, grant operations and latest saved configuration", async () => {
    const f = await fixture(), prior = await f.admit(), current = await f.admit();
    await pool.query("UPDATE agents_platform.execution_grants SET operations='[\"model.reply\",\"knowledge.read\"]'::jsonb WHERE id=$1", [current.grant_id]);
    await expect(call(current.id, "tasks.inspect", {})).rejects.toMatchObject({ code: "GRANT_CAPABILITY_DENIED" });
    await pool.query("UPDATE agents_platform.execution_grants SET operations=$2 WHERE id=$1", [current.grant_id, JSON.stringify(operationsForConfiguration(f.configuration, true))]);
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2", [f.org.id, f.account.id]);
    await expect(call(current.id, "tasks.cancel", { taskId: prior.id })).rejects.toMatchObject({ code: "MEMBERSHIP_INACTIVE" });
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=NULL WHERE organization_id=$1 AND account_id=$2", [f.org.id, f.account.id]);
    await store.saveConfiguration({ accountId: f.account.id, organizationId: f.org.id, agentId: f.agent.id, configuration: { ...f.configuration, tools: [] }, expectedRevision: 1, confirmImpact: true });
    await expect(call(current.id, "tasks.inspect", {})).rejects.toMatchObject({ code: "GRANT_REVOKED" });
  });
});
