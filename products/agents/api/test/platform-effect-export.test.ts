import { contextGrantCeiling } from "../src/execution/models/settings";
import {dropClosedTestDatabase} from "./support/database-cleanup";
import { connectFixtureModel } from "./model-fixture";
import { randomUUID, randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { PlatformStore } from "../src/product/agents/store";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration, executionGrantSchema, PlatformError } from "../src/contracts/contracts";
import { beginOperation, finishOperation } from "../src/execution/lifecycle/execution";
import { TaskArtifactStore } from "../src/execution/artifacts/task-artifacts";
import { ConnectionVault } from "../src/infrastructure/vault";
import { ConnectionStore } from "../src/product/connections/connections";
import { ActionService } from "../src/workflows/report-delivery/actions";
import { EvidenceStore } from "../src/execution/context/evidence";
import { exportExecutionHistory } from "../src/product/evaluation/history-export";
import { initializeReportReceiver, createReportReceiver } from "../src/acceptance/report-receiver";
import { publishFixtureSource } from "./knowledge-fixture";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("native report export policy with real PG/HTTP receiver (fixture report; no model/sandbox calls)", () => {
  let admin: Pool, pool: Pool, platform: PlatformStore, artifacts: TaskArtifactStore, connections: ConnectionStore, actions: ActionService, receiver: ReturnType<typeof createReportReceiver>;
  const database = `agents_effect_export_${randomUUID().replaceAll("-", "")}`, key = randomUUID() + randomUUID(), bodies = new Map<string, Uint8Array>();
  const vault = new ConnectionVault("v1", { v1: randomBytes(32).toString("base64") });
  let target: { id: string; label: string; url: string; resource: string }, loseResponse = false;
  const oldTargets = process.env.AGENTS_REPORT_DELIVERY_TARGETS;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url }); await admin.query(`CREATE DATABASE "${database}"`);
    const isolated = new URL(url!); isolated.pathname = `/${database}`; pool = new Pool({ connectionString: isolated.href }); await setupPlatformSchema(pool); await initializeReportReceiver(pool);
    receiver = createReportReceiver({ pool, keys: [{ apiKey: key, resource: "reports:fixture" }], afterAccept: async () => { if (loseResponse) throw Error("Fixture lost acceptance response"); } });
    const address = await receiver.listen({ host: "127.0.0.1", port: 0 }); target = { id: "export-receiver", label: "Isolated receiver", url: `${address}/deliveries`, resource: "reports:fixture" };
    process.env.AGENTS_REPORT_DELIVERY_TARGETS = JSON.stringify([target]);
    platform = new PlatformStore(pool);
    artifacts = new TaskArtifactStore(pool, { async put(k, b) { bodies.set(k, Buffer.from(b)); }, async get(k) { const b = bodies.get(k); if (!b) throw Error("Missing fixture object"); return b; }, async delete(k) { bodies.delete(k); } });
    connections = new ConnectionStore(pool, vault, [target]); actions = new ActionService(pool, { vault, targets: [target], artifacts });
  });
  afterAll(async () => { if (oldTargets === undefined) delete process.env.AGENTS_REPORT_DELIVERY_TARGETS; else process.env.AGENTS_REPORT_DELIVERY_TARGETS = oldTargets;
    await receiver?.close(); await pool?.end(); if (admin) { await dropClosedTestDatabase(admin,database); await admin.end(); } });
  async function fixture() {
    const account = await platform.ensureAccount({ issuer: "http://localhost/export-actions", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await platform.createOrganization(account.id, "Isolated reports"), scope = { accountId: account.id, organizationId: org.id };
    await connectFixtureModel(pool, account.id, org.id);
    const connection = await connections.create(scope, { operationId: randomUUID(), name: "Reports", targetId: target.id, apiKey: key });
    const source = await publishFixtureSource(pool, { ...scope, title: "Fixture total", content: "The audited total is 42.", visibility: "private" }, artifacts.objects);
    const configuration = defaultBusinessConfiguration(); configuration.sourceRevisionIds = [source.id];
    configuration.capabilities.workflows = { enabled: true, profileId: "report-delivery-v1", connectionId: connection.id, reportArtifactName: "report.json", title: "Fixture report" };
    const agent = await platform.createAgent({ ...scope, name: "Reporter", configuration });
    const version = await platform.createVersion({ ...scope, agentId: agent.id, expectedRevision: 1 });
    const authority = { product: "agents" as const, organizationId: org.id, resourceId: agent.id, callerClientId: "agents-execution", principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } };
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id, sourceRevisionIds: [source.id], operations: ["model.reply", "knowledge.read", "artifact.read", "artifact.write", "effect.deliver"], maxInputBytes: configuration.model.maxInputBytes, maxOutputTokens: configuration.model.maxOutputTokens, maxContextTokens: contextGrantCeiling(configuration), expiresAt: new Date(Date.now() + 60000).toISOString(), revokedAt: null });
    await platform.createGrant({ accountId: account.id, grant });
    const { task } = await platform.admitTask({ authority, versionId: version.id, grantId: grant.id, requestKey: randomUUID(), input: "Prepare fixture report" });
    const evidence = new EvidenceStore(pool, artifacts.objects), knowledgeId = `knowledge:${task.id}:initial`;
    await beginOperation(pool, task.id, { id: knowledgeId, kind: "tool", name: "knowledge.search", request: { query: "audited total" }, reservedTokens: 0, reservedMs: 1000 });
    const chunk = (await pool.query("SELECT id FROM agents_platform.source_chunks WHERE revision_id=$1 LIMIT 1", [source.id])).rows[0];
    const passage = await evidence.recordChunk(task.id, knowledgeId, chunk.id); await finishOperation(pool, task.id, knowledgeId, "completed", { passages: [passage] }, null, 0);
    const snapshotId = `context:${task.id}:0`;
    await pool.query(`INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,source_references,history_cutoff) VALUES($1,$2,0,$3,$4,'[]',0)`, [snapshotId, task.id, "a".repeat(64), { messages: [{ role: "system", content: `${passage.text} [${passage.label}]` }] }]);
    await evidence.supplyContext(task.id, snapshotId, [passage.reference.id]);
    const operationId = `report:${task.id}:prepare`;
    await beginOperation(pool, task.id, { id: operationId, kind: "tool", name: "report.prepare", request: {}, reservedTokens: 0, reservedMs: 1000 });
    const artifact = await artifacts.put(task.id, operationId, { name: "report.json", contentType: "application/json", content: Buffer.from(JSON.stringify({ total: 42, source: `[${passage.label}]` })) });
    const action = await actions.prepare(task.id, `report:${task.id}:deliver`, { connectionId: connection.id, artifactId: artifact.id });
    const authorize = async (db: PoolClient, id: string) => { if (!(await db.query(`SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.memberships m ON m.organization_id=t.organization_id
      WHERE t.id=$1 AND m.account_id=$2 AND m.revoked_at IS NULL AND t.principal->>'subject'=$3 FOR SHARE OF m`, [id, account.id, account.subject])).rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Denied"); };
    return { account, org, scope, connection, source, task, artifact, action, authorize };
  }
  const approve = (f: Awaited<ReturnType<typeof fixture>>) => actions.decide(f.scope, f.task.id, f.action.id, { operationId: randomUUID(), decision: "approve", expectedDigest: f.action.reviewDigest });
  it("preserves pending/approved states without fabricating delivery or exposing report payloads/credentials", async () => {
    const f = await fixture();
    const pending = await exportExecutionHistory(pool, f.task.id, f.authorize);
    expect(pending.effectReceipts[0]).toMatchObject({ schemaVersion: "report-delivery-receipt.v1", state: "pending_review", receipt: null });
    await approve(f); const approved = await exportExecutionHistory(pool, f.task.id, f.authorize);
    expect(approved.coverage.effects.status).toBe("complete"); expect(approved.effectReceipts[0]).toMatchObject({ state: "approved", receipt: null, reviewRecords: [{ state: "approved" }] });
    expect(JSON.stringify(approved.effectReceipts)).not.toContain("contentBase64"); expect(JSON.stringify(approved)).not.toContain(key);
    expect((await pool.query("SELECT count(*)::int AS n FROM report_delivery_receiver.deliveries WHERE id=$1", [f.action.id])).rows[0].n).toBe(0);
  });
  it("joins a confirmed native receipt to independent receiver state and exact report digest", async () => {
    const f = await fixture(); await approve(f); expect((await actions.deliver(f.task.id, f.action.id)).state).toBe("delivered");
    const result = await exportExecutionHistory(pool, f.task.id, f.authorize), record: any = result.effectReceipts[0];
    expect(record.state).toBe("delivered"); expect(record.receipt.id).toBe(f.action.id); expect(result.coverage.effects.status).toBe("complete");
    const receipts = (await pool.query("SELECT * FROM report_delivery_receiver.deliveries WHERE id=$1", [f.action.id])).rows;
    expect(receipts).toHaveLength(1); expect(record.receipt.payloadDigest).toBe(receipts[0].payload_digest); expect(record.artifactDigest).toBe(receipts[0].payload.report.digest);
  });
  it("retains uncertainty after a lost write acknowledgement until native status reconciliation confirms acceptance", async () => {
    const f = await fixture(); await approve(f); loseResponse = true;
    try { expect((await actions.deliver(f.task.id, f.action.id)).state).toBe("uncertain"); } finally { loseResponse = false; }
    const uncertain = await exportExecutionHistory(pool, f.task.id, f.authorize); expect(uncertain.effectReceipts[0]).toMatchObject({ state: "uncertain", receipt: null });
    expect((await actions.reconcile(f.action.id)).state).toBe("delivered");
    const recovered = await exportExecutionHistory(pool, f.task.id, f.authorize); expect(recovered.effectReceipts[0]).toMatchObject({ state: "delivered", receipt: { id: f.action.id } });
    expect((await pool.query("SELECT count(*)::int AS n FROM report_delivery_receiver.deliveries WHERE id=$1", [f.action.id])).rows[0].n).toBe(1);
  });
  it("withholds artifact URLs and effects when a transitive personal-memory fence changes", async () => {
    const f = await fixture(), scopeId = randomUUID();
    await pool.query("INSERT INTO agents_platform.memory_scopes(id,organization_id,agent_id,account_id,generation) VALUES($1,$2,$3,$4,1)", [scopeId, f.org.id, f.task.resource_id, f.account.id]);
    const ancestor = await artifacts.put(f.task.id, `report:${f.task.id}:prepare`, { name: "ancestor.json", contentType: "application/json", content: Buffer.from('{"total":42}'), sourceReferences: [{ kind: "memory_scope", id: scopeId, generation: 1 }] });
    await pool.query("UPDATE agents_platform.artifacts SET source_references=$2 WHERE id=$1", [f.artifact.id, JSON.stringify([{ kind: "artifact", id: ancestor.id }])]);
    await approve(f); await pool.query("UPDATE agents_platform.memory_scopes SET generation=2 WHERE id=$1", [scopeId]);
    const result = await exportExecutionHistory(pool, f.task.id, f.authorize);
    expect(result.artifacts.find(item => item.id === f.artifact.id)?.downloadPath).toBeNull();
    expect(result.tasks[0]).toMatchObject({ input: null, output: null, contextSnapshots: [], initialOperations: [], evidenceReferences: [] });
    expect(result.effectReceipts).toEqual([]); expect(result.coverage.artifacts.status).toBe("partial"); expect(result.coverage.effects.status).toBe("partial");
  });
  it("rejects a stored receipt whose identity disagrees with the confirmed native action", async () => {
    const f = await fixture(); await approve(f); await actions.deliver(f.task.id, f.action.id);
    await pool.query("UPDATE agents_platform.actions SET receipt=jsonb_set(receipt,'{id}',to_jsonb($2::text)) WHERE id=$1", [f.action.id, randomUUID()]);
    const result = await exportExecutionHistory(pool, f.task.id, f.authorize);
    expect(result.effectReceipts).toEqual([]); expect(result.coverage.effects.status).toBe("partial");
  });
  it("withholds receipt evidence after the configured destination changes", async () => {
    const f = await fixture(); await approve(f);
    process.env.AGENTS_REPORT_DELIVERY_TARGETS = JSON.stringify([{ ...target, url: target.url.replace("/deliveries", "/changed/deliveries") }]);
    try { const result = await exportExecutionHistory(pool, f.task.id, f.authorize); expect(result.effectReceipts).toEqual([]); expect(result.coverage.effects.status).toBe("partial"); }
    finally { process.env.AGENTS_REPORT_DELIVERY_TARGETS = JSON.stringify([target]); }
  });
  it.each(["source", "connection", "expiry", "reviewer", "approval"])("withholds native effects under %s policy changes", async mode => {
    const f = await fixture(); await approve(f);
    if (mode === "source") await f.source.knowledge.setPolicy(f.scope, f.source.sourceId, { operationId: randomUUID(), expectedGeneration: 1, action: "withdraw" });
    if (mode === "connection") await pool.query("UPDATE agents_platform.connections SET revision=revision+1 WHERE id=$1", [f.connection.id]);
    if (mode === "expiry") await pool.query("UPDATE agents_platform.connections SET expires_at=now()-interval '1 second' WHERE id=$1", [f.connection.id]);
    if (mode === "reviewer") { const other = await platform.ensureAccount({ issuer: "http://localhost/export-actions", subject: randomUUID(), email: "other@example.test", displayName: "Other" }); await pool.query("UPDATE agents_platform.actions SET reviewer_account_id=$2 WHERE id=$1", [f.action.id, other.id]); }
    if (mode === "approval") await pool.query("UPDATE agents_platform.actions SET approved_at=NULL WHERE id=$1", [f.action.id]);
    const result = await exportExecutionHistory(pool, f.task.id, f.authorize); expect(result.effectReceipts).toEqual([]); expect(result.coverage.effects.status).toBe("partial");
  });
});
