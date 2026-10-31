import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPlatformApp } from "../src/composition/app";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration, executionGrantSchema, requestDigest } from "../src/contracts/contracts";
import { orchestrationTools } from "../src/contracts/orchestration";
import { executeWorkTool } from "../src/execution/delegation/progress";
import { EvidenceStore } from "../src/execution/context/evidence";
import { beginOperation, finishOperation, settleTask } from "../src/execution/lifecycle/execution";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { PlatformStore } from "../src/product/agents/store";
import { connectFixtureModel } from "./model-fixture";
import { publishFixtureSource } from "./knowledge-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
const origin = "http://localhost:3100", issuer = "https://orchestration-route.fixture.test";
(databaseUrl ? describe : describe.skip)("adaptive orchestration authenticated HTTP routes", () => {
  let admin: Pool, pool: Pool, store: PlatformStore, app: Awaited<ReturnType<typeof buildPlatformApp>>;
  const database = `agents_orchestration_http_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.href }); await setupPlatformSchema(pool); store = new PlatformStore(pool);
    app = await buildPlatformApp({ pool, logging: false, config: loadPlatformConfig({ NODE_ENV: "test", AGENTS_DATABASE_URL: url.href, AGENTS_PUBLIC_URL: origin, AGENTS_OIDC_ISSUER_URL: issuer, AGENTS_OIDC_CLIENT_SECRET: "controlled-route-fixture-secret" }) });
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  async function actor() {
    const account = await store.ensureAccount({ issuer, subject: randomUUID(), email: "member@example.test", displayName: "Member" });
    const session = await store.createSession({ accountId: account.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 600000) });
    return { account, cookie: `agents_session=${session.token}` };
  }
  async function fixture(withSource = false) {
    const owner = await actor(), org = await store.createOrganization(owner.account.id, "Adaptive HTTP"), scope = { accountId: owner.account.id, organizationId: org.id };
    await connectFixtureModel(pool, scope.accountId, scope.organizationId);
    const source = withSource ? await publishFixtureSource(pool, { ...scope, title: "Private fact", content: "Confidential launch date is Tuesday.", visibility: "private" }) : undefined;
    const child = await store.createAgent({ ...scope, name: "Specialist", configuration: defaultBusinessConfiguration() });
    const childVersion = await store.createVersion({ ...scope, agentId: child.id, expectedRevision: 1 });
    const config = defaultBusinessConfiguration(); config.program = { id: "tool-directed", version: "4" }; config.tools = [...orchestrationTools, "knowledge.search", "knowledge.read"];
    config.sourceRevisionIds = source ? [source.id] : [];
    config.capabilities.delegation = { enabled: true, maxChildren: 2, maxDepth: 1, policy: { maxTasks: 16, maxStalls: 3 }, bindings: [{ id: "writer", versionId: childVersion.id, sourceRevisionIds: [], connectedToolBindingIds: [], tools: [], maxTokens: 8000, maxActiveMs: 120000 }] };
    const agent = await store.createAgent({ ...scope, name: "Coordinator", configuration: config }), version = await store.createVersion({ ...scope, agentId: agent.id, expectedRevision: 1 });
    const authority = { product: "agents" as const, organizationId: org.id, resourceId: agent.id, callerClientId: "agents-execution", principal: { kind: "human" as const, issuer, subject: owner.account.subject } };
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id, operations: ["model.reply", "knowledge.read", "delegation.execute"], sourceRevisionIds: config.sourceRevisionIds, maxInputBytes: config.model.maxInputBytes, maxOutputTokens: config.model.maxOutputTokens, maxContextTokens: config.context.maxInputTokens, expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null });
    await store.createGrant({ ...scope, grant });
    const { task } = await store.admitTask({ authority, grantId: grant.id, versionId: version.id, requestKey: randomUUID(), input: "Prepare the launch" });
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1", [task.id]);
    const record = { objective: source?.content ?? "Prepare launch", steps: [{ id: "draft", title: "Draft", state: "in_progress" as const }], questions: [], evidenceTaskIds: [] };
    await executeWorkTool(pool, task.id, `work:${task.id}`, "work.update", { expectedRevision: 0, record });
    return { owner, org, scope, source, task, grant, record, path: `/api/organizations/${org.id}/tasks/${task.id}` };
  }
  function instruction(path: string, cookie: string, payload = { requestKey: randomUUID(), instruction: "Focus on the deadline" }, includeOrigin = true) {
    return app.inject({ method: "POST", url: `${path}/instructions`, headers: { cookie, ...(includeOrigin ? { origin } : {}) }, payload });
  }
  it("returns durable progress to its owner and accepts an unchanged instruction retry once", async () => {
    const f = await fixture(), response = await app.inject({ url: f.path, headers: { cookie: f.owner.cookie } });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ canSteer: true, orchestration: { revision: 1, record: f.record } });
    const payload = { requestKey: randomUUID(), instruction: "Focus on the deadline" };
    for (let i = 0; i < 2; i++) expect((await instruction(f.path, f.owner.cookie, payload)).json()).toEqual({ accepted: true });
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.orchestration_instructions WHERE task_id=$1", [f.task.id])).rows[0].count).toBe(1);
    expect((await instruction(f.path, f.owner.cookie, { ...payload, instruction: "Changed" })).statusCode).toBe(409);
  });
  it("denies another organization member and invalid sessions without exposing progress", async () => {
    const f = await fixture(), other = await actor();
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')", [f.org.id, other.account.id]);
    const foreign = await app.inject({ url: f.path, headers: { cookie: other.cookie } });
    expect(foreign.statusCode).toBe(403); expect(foreign.body).not.toContain(f.record.objective);
    expect((await instruction(f.path, other.cookie)).statusCode).toBe(403);
    expect((await instruction(f.path, "agents_session=invalid")).statusCode).toBe(401);
    expect((await instruction(f.path, f.owner.cookie, undefined, false)).statusCode).toBe(403);
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.orchestration_instructions WHERE task_id=$1", [f.task.id])).rows[0].count).toBe(0);
  });
  it("refuses terminal tasks and excessive or malformed instructions", async () => {
    const f = await fixture();
    expect((await instruction(f.path, f.owner.cookie, { requestKey: randomUUID(), instruction: "x".repeat(4001) })).statusCode).toBe(400);
    expect((await instruction(f.path, f.owner.cookie, { requestKey: "bad", instruction: "Change" })).statusCode).toBe(400);
    await settleTask(pool, f.task.id, { state: "completed", output: "Done" });
    expect((await instruction(f.path, f.owner.cookie)).statusCode).toBe(409);
    expect((await app.inject({ url: f.path, headers: { cookie: f.owner.cookie } })).json().canSteer).toBe(false);
  });
  it("rejects queued instructions after grant or membership revocation", async () => {
    const f = await fixture(); await pool.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1", [f.grant.id]);
    expect((await instruction(f.path, f.owner.cookie)).statusCode).toBe(403);
    expect((await app.inject({ url: f.path, headers: { cookie: f.owner.cookie } })).json().canSteer).toBe(false);
    const other = await fixture(); await pool.query("DELETE FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2", [other.org.id, other.owner.account.id]);
    expect((await instruction(other.path, other.owner.cookie)).statusCode).toBe(403);
  });
  it("redacts model-authored progress after conversation deletion", async () => {
    const f = await fixture(); await pool.query("UPDATE agents_platform.conversations SET deleted_at=now() WHERE id=$1", [f.task.conversation_id]);
    const response = await app.inject({ url: f.path, headers: { cookie: f.owner.cookie } });
    expect(response.statusCode).toBe(200); expect(response.json().orchestration.record).toBeNull();
  });
  it("redacts derived progress after a source contributing evidence is withdrawn", async () => {
    const f = await fixture(true), evidence = new EvidenceStore(pool, f.source!.storage), operation = `source:${f.task.id}`;
    await beginOperation(pool, f.task.id, { id: operation, kind: "tool", name: "knowledge.search", request: { query: "launch" }, reservedTokens: 0, reservedMs: 1000, retrySafe: true });
    const chunk = (await pool.query("SELECT id FROM agents_platform.source_chunks WHERE revision_id=$1", [f.source!.id])).rows[0];
    const passage = await evidence.recordChunk(f.task.id, operation, chunk.id); await finishOperation(pool, f.task.id, operation, "completed", {}, null, 0);
    const snapshot = `context:${f.task.id}:0`, payload = { messages: [{ role: "user", content: `${passage.text} [${passage.label}]` }] };
    await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)", [snapshot, f.task.id, requestDigest(payload), payload]);
    await evidence.supplyContext(f.task.id, snapshot, [passage.reference.id]);
    expect((await app.inject({ url: f.path, headers: { cookie: f.owner.cookie } })).json().orchestration.record).toEqual(f.record);
    await f.source!.knowledge.setPolicy(f.scope, f.source!.sourceId, { operationId: randomUUID(), expectedGeneration: 1, action: "withdraw" });
    const response = await app.inject({ url: f.path, headers: { cookie: f.owner.cookie } });
    expect(response.statusCode).toBe(200); expect(response.json().orchestration.record).toBeNull();
    expect(response.body).not.toContain(f.source!.content);
  });
});
