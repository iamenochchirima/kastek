import {dropClosedTestDatabase} from "./support/database-cleanup";
import { connectFixtureModel } from "./model-fixture";
import { modelServiceDefaults } from "../src/execution/models/settings";
import type { AcceptedModelRoutes } from "../src/contracts/model-bindings";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultBusinessConfiguration, PlatformError, type AdmissionAuthority, type ExecutionGrant } from "../src/contracts/contracts";
import { exportExecutionHistory, exportModelCalls, emptyExportCoverage, type OperationRow } from "../src/product/evaluation/history-export";
import { PlatformStore } from "../src/product/agents/store";
import { beginOperation, finishOperation, settleTask } from "../src/execution/lifecycle/execution";
import { EvidenceStore } from "../src/execution/context/evidence";
import { setupPlatformSchema } from "../src/composition/setup";
import { EvaluationTrials } from "../src/product/evaluation/evaluation-trials";
import { publishFixtureSource } from "./knowledge-fixture";

const taskId = randomUUID();
const exportModels = { primary: { binding: { organizationId: randomUUID(), connectionId: randomUUID(), connectionRevision: 1, credentialRevision: 1,
 useGrantId: randomUUID(), useGrantRevision: 1, providerId: "openrouter", providerDefinitionDigest: "a".repeat(64), endpoint: "https://openrouter.ai/api/v1",
 protocol: "openai_chat_completions", modelId: "fixture", modelRevision: "fixture-1", adapterId: "pi-ai", adapterRevision: "1", role: "primary", policyDigest: "a".repeat(64) },
 policy: { ...modelServiceDefaults, revision: "fixture-1", digest: "a".repeat(64) } } } satisfies { primary: Pick<AcceptedModelRoutes["primary"], "binding" | "policy"> };
const row = (id: string, changes: Partial<OperationRow> = {}): OperationRow => ({ id, task_id: taskId, kind: "model", name: "model.generate", state: "completed", request: { model: "fixture", messages: [{ role: "user", content: "question" }] }, output: { message: { role: "assistant", content: "answer" }, usage: { inputTokens: 3, outputTokens: 2 } }, error_code: null, accounted_tokens: 5, ...changes });
describe("native model history export identity", () => {
  it("keeps exact request snapshots, response and token usage without prompt reconstruction", () => {
    const coverage = emptyExportCoverage(), input = row(`model:${taskId}:3`);
    const [call] = exportModelCalls(taskId, [input], [], coverage, exportModels);
    expect(call).toMatchObject({ operationId: input.id, step: 3, inputMessages: input.request.messages, outputMessage: input.output.message, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
    expect(coverage.modelInputs.status).toBe("complete");
  });
  it("joins provider tools and child tasks only through the exact step/index native receipt", () => {
    const child = { id: randomUUID(), parent_task_id: taskId, delegation_operation_id: `tool:${taskId}:0:0` };
    const model = row(`model:${taskId}:0`, { output: { message: { role: "assistant", content: null, tool_calls: [{ id: "provider-id", type: "function", function: { name: "agents_delegate", arguments: "{}" } }] } } });
    const tool = row(child.delegation_operation_id, { kind: "delegation", name: "agents.delegate", request: { tool: "agents.delegate", arguments: "{}" }, output: { accepted: [child.id] } });
    const actualObservation = { children: [{ id: child.id, output: "child answer" }] };
    const next = row(`model:${taskId}:1`, { request: { model: "fixture", messages: [model.output.message, { role: "tool", tool_call_id: "provider-id", content: JSON.stringify(actualObservation) }] } });
    const coverage = emptyExportCoverage(), [call] = exportModelCalls(taskId, [model, tool, next], [child], coverage, exportModels);
    expect(call!.toolResults).toEqual([{ toolCallId: "provider-id", operationId: tool.id, name: "agents_delegate", state: "completed", content: JSON.stringify(actualObservation), observedByOperationId: next.id, nativeOutput: tool.output, errorCode: null, childTaskIds: [child.id] }]);
    expect(call!.usage).toBeNull();
    expect(coverage.toolResults.status).toBe("complete");
  });
  it("retains receipts separately when a result was never consumed by another model call", () => {
    const model = row(`model:${taskId}:0`, { output: { message: { role: "assistant", content: null, tool_calls: [{ id: "provider-id", type: "function", function: { name: "knowledge_search", arguments: "{}" } }] } } });
    const tool = row(`tool:${taskId}:0:0`, { kind: "tool", name: "knowledge.search", request: { tool: "knowledge.search", arguments: "{}" }, output: { text: "native receipt" } });
    const coverage = emptyExportCoverage(), [call] = exportModelCalls(taskId, [model, tool], [], coverage, exportModels);
    expect(call!.toolResults[0]).toMatchObject({ content: null, observedByOperationId: null, nativeOutput: tool.output });
    expect(coverage.toolResults.status).toBe("partial");
  });
  it("refuses guessed aliases or mismatched saved arguments even if an index exists", () => {
    const model = row(`model:${taskId}:0`, { output: { message: { role: "assistant", content: null, tool_calls: [{ id: "provider-id", type: "function", function: { name: "guessed_alias", arguments: "{}" } }] } } });
    const tool = row(`tool:${taskId}:0:0`, { kind: "tool", name: "knowledge.search", request: { tool: "knowledge.search", arguments: "{}" }, output: { text: "private" } });
    const coverage = emptyExportCoverage(), [call] = exportModelCalls(taskId, [model, tool], [], coverage, exportModels);
    expect(call!.toolResults).toEqual([]); expect(coverage.toolResults.status).toBe("partial");
  });
  it("preserves unknown split usage and missing response instead of inventing an assistant step", () => {
    const coverage = emptyExportCoverage(), [call] = exportModelCalls(taskId, [row(`model:${taskId}:0`, { state: "uncertain", output: null, accounted_tokens: 900 })], [], coverage, exportModels);
    expect(call!.outputMessage).toBeNull(); expect(call!.usage).toBeNull();
    expect(coverage.modelOutputs.status).toBe("partial"); expect(coverage.toolCalls.status).toBe("partial");
  });
});

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("authorized native export with real PostgreSQL persistence (no model calls)", () => {
  let pool: Pool, admin: Pool, store: PlatformStore;
  const databaseName = `agents_export_test_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.href }); await setupPlatformSchema(pool); store = new PlatformStore(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin,databaseName); await admin.end(); } });
  async function fixture() {
    const account = await store.ensureAccount({ issuer: "http://localhost/fixture", subject: randomUUID(), email: "fixture@example.com", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Export fixture");
    await connectFixtureModel(pool, account.id, org.id);
    const source = await publishFixtureSource(pool, { accountId: account.id, organizationId: org.id, title: "Private hours", content: "Secret opening hours are nine.", visibility: "private" });
    const config = defaultBusinessConfiguration(); config.sourceRevisionIds = [source.id];
    const agent = await store.createAgent({ accountId: account.id, organizationId: org.id, name: "Fixture", configuration: config });
    const version = await store.createVersion({ accountId: account.id, organizationId: org.id, agentId: agent.id, expectedRevision: 1 });
    const authority: AdmissionAuthority = { product: "agents", organizationId: org.id, resourceId: agent.id, callerClientId: "agents-execution", principal: { kind: "human", issuer: account.issuer, subject: account.subject } };
    const grant: ExecutionGrant = { ...authority, id: randomUUID(), versionId: version.id, operations: ["model.reply", "knowledge.read"], sourceRevisionIds: config.sourceRevisionIds,
      connectedToolBindingIds: [], maxContextTokens: config.context.maxInputTokens, rootTokenLimit: 32000, maxInputBytes: config.model.maxInputBytes, maxOutputTokens: config.model.maxOutputTokens, expiresAt: new Date(Date.now() + 300_000).toISOString(), revokedAt: null };
    await store.createGrant({ accountId: account.id, grant });
    const { task } = await store.admitTask({ authority, grantId: grant.id, versionId: version.id, requestKey: randomUUID(), input: "Opening hours?" });
    const knowledgeId = `knowledge:${task.id}:initial`;
    await beginOperation(pool, task.id, { id: knowledgeId, kind: "tool", name: "knowledge.search", request: { query: task.input }, reservedTokens: 0, reservedMs: 1000 });
    const evidence = new EvidenceStore(pool, source.storage);
    const chunk = (await pool.query("SELECT id FROM agents_platform.source_chunks WHERE revision_id=$1 LIMIT 1", [source.id])).rows[0];
    const passage = await evidence.recordChunk(task.id, knowledgeId, chunk.id);
    await finishOperation(pool, task.id, knowledgeId, "completed", { passages: [passage] }, null, 0);
    const request = { model: "fixture-only", messages: [{ role: "system", content: passage.text }, { role: "user", content: task.input }] };
    await beginOperation(pool, task.id, { id: `model:${task.id}:0`, kind: "model", name: "model.generate", request, reservedTokens: 100, reservedMs: 1000 });
    const output = { message: { role: "assistant", content: "Nine." }, usage: { inputTokens: 12, outputTokens: 2 } };
    await finishOperation(pool, task.id, `model:${task.id}:0`, "completed", output, null, 14);
    await settleTask(pool, task.id, { state: "completed", output: "Nine." });
    const authorize = async (db: PoolClient, id: string) => {
      if (!(await db.query(`SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.memberships m ON m.organization_id=t.organization_id AND m.account_id=$2 AND m.revoked_at IS NULL
        WHERE t.id=$1 AND t.organization_id=$3 AND t.principal->>'issuer'=$4 AND t.principal->>'subject'=$5 FOR SHARE OF m`, [id, account.id, org.id, account.issuer, account.subject])).rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Access denied");
    };
    return { account, org, task, source, authorize, output, request, grant };
  }
  it("exports immutable native requests, initial knowledge receipts and authoritative source evidence", async () => {
    const f = await fixture(), check = vi.fn(f.authorize);
    const result = await exportExecutionHistory(pool, f.task.id, check);
    expect(check).toHaveBeenCalledOnce();
    expect(result.tasks[0]!.modelCalls[0]).toMatchObject({ inputMessages: f.request.messages, outputMessage: f.output.message, usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 } });
    expect(result.tasks[0]!.initialOperations).toHaveLength(1); expect(result.tasks[0]!.evidenceReferences).toHaveLength(1);
    expect(result.coverage.modelInputs.status).toBe("complete"); expect(result.coverage.observations.status).toBe("complete"); expect(result.observations.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(f.grant.id);
  });
  it("withholds persisted context, model output and initial receipts after source withdrawal", async () => {
    const f = await fixture();
    await f.source.knowledge.setPolicy({ accountId: f.account.id, organizationId: f.org.id }, f.source.sourceId, { operationId: randomUUID(), expectedGeneration: 1, action: "withdraw" });
    const result = await exportExecutionHistory(pool, f.task.id, f.authorize);
    expect(result.tasks[0]).toMatchObject({ input: null, output: null, modelCalls: [], initialOperations: [], contextSnapshots: [], evidenceReferences: [] });
    expect(result.coverage.modelInputs.status).toBe("partial"); expect(JSON.stringify(result)).not.toContain("Secret opening");
  });
  it.each(["generation", "expiry", "deadline"])("withholds immutable snapshots and derived output on memory %s invalidation", async (kind) => {
    const f = await fixture(), scopeId = randomUUID();
    await pool.query(`INSERT INTO agents_platform.memory_scopes(id,organization_id,agent_id,account_id,generation,next_expiry_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [scopeId, f.org.id, f.task.resource_id, f.account.id, kind === "generation" ? 2 : 1, kind === "expiry" ? new Date(Date.now() - 1000) : null]);
    await pool.query(`INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,memory_scope_id,memory_generation,history_cutoff)
      VALUES($1,$2,0,$3,$4,$5,1,0)`, [`context:${f.task.id}:0`, f.task.id, "a".repeat(64), { messages: [{ role: "system", content: "Forgotten personal information" }], ...(kind === "deadline" ? { memoryExpiresAt: Date.now() - 1000 } : {}) }, scopeId]);
    const result = await exportExecutionHistory(pool, f.task.id, f.authorize);
    expect(result.tasks[0]!.modelCalls).toEqual([]); expect(result.tasks[0]!.output).toBeNull();
    expect(JSON.stringify(result)).not.toContain("Forgotten personal information");
    expect(result.coverage.modelInputs.status).toBe("partial");
  });
  it("marks legacy events without typed observations as partial rather than fabricating records", async () => {
    const f = await fixture();
    await pool.query("INSERT INTO agents_platform.task_events(task_id,event_key,kind,payload) VALUES($1,'legacy-fixture','task.fixture','{}')", [f.task.id]);
    const result = await exportExecutionHistory(pool, f.task.id, f.authorize);
    expect(result.coverage.observations.status).toBe("partial");
    expect(result.coverage.observations.omissions.join(" ")).toContain("no valid typed observation");
  });
  it("rejects another principal and revoked memberships inside the mandatory authorization transaction", async () => {
    const f = await fixture();
    await expect(exportExecutionHistory(pool, f.task.id, async () => { throw new PlatformError("ACCESS_DENIED", 403, "Denied"); })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE account_id=$1 AND organization_id=$2", [f.account.id, f.org.id]);
    await expect(exportExecutionHistory(pool, f.task.id, f.authorize)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it.each(["revoked", "expired"] as const)("requires explicit exact trial-operator ownership for server-bound visitor roots after trial %s", async (state) => {
    const account = await store.ensureAccount({ issuer: "http://localhost/export-visitor", subject: randomUUID(), email: "operator@example.test", displayName: "Operator" });
    const org = await store.createOrganization(account.id, "Visitor export fixture"), configuration = defaultBusinessConfiguration();
    await connectFixtureModel(pool, account.id, org.id);
    const agent = await store.createAgent({ accountId: account.id, organizationId: org.id, name: "Visitor fixture", configuration });
    const version = await store.createVersion({ accountId: account.id, organizationId: org.id, agentId: agent.id, expectedRevision: 1 });
    const deployment = await store.publishWebsite({ accountId: account.id, organizationId: org.id, agentId: agent.id, versionId: version.id, allowedOrigins: ["https://fixture.example"] });
    const trials = new EvaluationTrials(pool);
    const preview = await trials.preview(account.id, org.id, agent.id, { versionId: version.id, rootTokenLimit: 32000 });
    const prepared = await trials.prepare(account.id, org.id, { expectedModelRoutesDigest: preview.modelRoutesDigest, rootTokenLimit: 32000, trialId: randomUUID(), agentId: agent.id, versionId: version.id, expectedCompositionDigest: version.effective_composition.digest, maxTokens: 32000, expiresAt: new Date(Date.now() + 300000).toISOString() });
    await trials.channelSession(account.id, org.id, prepared.id, { deploymentId: deployment.id, origin: "https://fixture.example" }, "fixture-only-channel-signing-key");
    const binding = (await pool.query("SELECT session_id FROM agents_platform.evaluation_trial_channels WHERE trial_id=$1", [prepared.id])).rows[0];
    const grant = await store.createWebsiteGrant({ deploymentId: deployment.id, origin: "https://fixture.example", sessionId: binding.session_id });
    const authority: AdmissionAuthority = { product: grant.product, organizationId: grant.organizationId, resourceId: grant.resourceId, callerClientId: grant.callerClientId, principal: grant.principal };
    const { task } = await store.admitTask({ authority, grantId: grant.id, versionId: version.id, requestKey: randomUUID(), input: "Public evaluation question", evaluationTrialId: prepared.id });
    await expect(exportExecutionHistory(pool, task.id, async () => undefined)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(exportExecutionHistory(pool, task.id, async () => ({ evaluationTrialId: randomUUID(), accountId: account.id }))).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    const other = await store.ensureAccount({ issuer: account.issuer, subject: randomUUID(), email: "other@example.test", displayName: "Other" });
    await expect(exportExecutionHistory(pool, task.id, async () => ({ evaluationTrialId: prepared.id, accountId: other.id }))).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    const authorize = async () => ({ evaluationTrialId: prepared.id, accountId: account.id });
    const result = await exportExecutionHistory(pool, task.id, authorize);
    expect(result.tasks[0]!.input).toBe("Public evaluation question");
    if (state === "revoked") await trials.revoke(account.id, org.id, prepared.id);
    else await pool.query("UPDATE agents_platform.evaluation_trials SET expires_at=now()-interval '1 second' WHERE id=$1", [prepared.id]);
    const revoked = await exportExecutionHistory(pool, task.id, authorize);
    expect(revoked.rootTaskId).toBe(task.id); expect(revoked.tasks[0]!.input).toBeNull(); expect(revoked.coverage.modelInputs.status).toBe("partial");
  });

});
