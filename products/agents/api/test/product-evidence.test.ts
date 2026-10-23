import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformError, requestDigest } from "../src/contracts/contracts";
import { createDependencyManifest, type EvidenceDependency } from "../src/contracts/source-contracts";
import { EvidenceStore, assertCurrentEvidence } from "../src/execution/context/evidence";
import { beginOperation, finishOperation, settleTask } from "../src/execution/lifecycle/execution";
import { buildContinuation } from "../src/execution/context/continuation";
import { transaction } from "../src/infrastructure/database";
import { productPorts, registerProductPorts } from "../src/infrastructure/product-ports";
import { PlatformStore } from "../src/product/agents/store";
import { growthFeatureConfiguration } from "../src/product/integrations/growth-features";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

it("keeps product source identity and origin revision in canonical manifests", () => {
  const dependency: EvidenceDependency = { kind: "product", product: "growth", tenantId: "business-a", taskId: randomUUID(), contextRevision: "a".repeat(64), sourceId: "content:post-a" };
  expect(createDependencyManifest([dependency, dependency]).dependencies).toEqual([dependency]);
  expect(() => createDependencyManifest([dependency, { ...dependency, contextRevision: "b".repeat(64) }])).toThrow("policy changed");
  expect(createDependencyManifest([dependency, { ...dependency, taskId: randomUUID(), contextRevision: "b".repeat(64) }]).dependencies).toHaveLength(2);
  expect(() => productPorts({} as Pool)).toThrow("Product evidence authorization is unavailable");
});

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("product observations in the shared evidence graph", () => {
  const database = `agents_product_evidence_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, platform: PlatformStore, evidence: EvidenceStore;
  const authorization = new Map<string, { tenantId: string; revision: string; sourceId: string; allowed: boolean }>();
  let lastAuthorizationDb: Pool | PoolClient | undefined;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url }); await admin.query(`CREATE DATABASE "${database}"`);
    const scoped = new URL(url!); scoped.pathname = `/${database}`;
    pool = new Pool({ connectionString: scoped.href, max: 1 });
    await setupPlatformSchema(pool); platform = new PlatformStore(pool); evidence = new EvidenceStore(pool);
    registerProductPorts(pool, { async assertCurrentEvidence(db, { dependency }) {
      lastAuthorizationDb = db;
      // A destination authorization stand-in checks the current accepted revision, never provider bytes.
      await db.query("SELECT 1");
      const current = authorization.get(dependency.taskId);
      if (!current?.allowed || current.tenantId !== dependency.tenantId || current.revision !== dependency.contextRevision || current.sourceId !== dependency.sourceId)
        throw new PlatformError("PRODUCT_CONTEXT_CHANGED", 409, "Product context changed");
    } });
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  async function fixture() {
    const creator = await platform.ensureAccount({ issuer: "https://fixture.example.test", subject: randomUUID(), email: "owner@example.test", displayName: "Fixture creator" });
    const org = await platform.createOrganization(creator.id, "Product evidence"), scope = { accountId: creator.id, organizationId: org.id };
    const model = await connectFixtureModel(pool, creator.id, org.id);
    const configuration = growthFeatureConfiguration("research");
    configuration.model.selection = { kind: "connection", connectionId: model.connection.id, modelId: model.modelId };
    const agent = await platform.createAgent({ ...scope, name: "Research", configuration });
    await model.store.grant(scope, { connectionId: model.connection.id, consumer: { kind: "agent", agentId: agent.id }, roles: ["primary", "compaction", "delegated"], modelIds: [model.modelId] });
    const version = await platform.createVersion({ ...scope, agentId: agent.id, expectedRevision: 1 });
    const tenantId = randomUUID(), grantId = randomUUID();
    // This Growth human has no standalone Agents account or membership.
    const authority = { product: "growth" as const, organizationId: org.id, resourceId: "research", callerClientId: "growth-api", principal: { kind: "human" as const, issuer: "https://growth.example.test/identity", subject: randomUUID() } };
    await pool.query("INSERT INTO agents_platform.product_execution_tenants(product,tenant_id,organization_id,client_id,issuer) VALUES('growth',$1,$2,'growth-api',$3)", [tenantId, org.id, authority.principal.issuer]);
    async function grant(id: string) {
      await pool.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,max_input_bytes,max_output_tokens,max_context_tokens,root_token_limit,expires_at)
        VALUES($1,'growth',$2,'research','growth-api',$3,$4,$5,$6,$7,$8,32000,now()+interval '5 minutes')`,
      [id, org.id, authority.principal, version.id, JSON.stringify(["model.reply", "product.read"]), configuration.model.maxInputBytes, configuration.model.maxOutputTokens, configuration.context.maxInputTokens]);
      await pool.query("INSERT INTO agents_platform.product_execution_authorities(grant_id,product,organization_id,client_id,issuer,assertion_digest) VALUES($1,'growth',$2,'growth-api',$3,$4)", [id, org.id, authority.principal.issuer, "a".repeat(64)]);
    }
    await grant(grantId);
    const { task } = await platform.admitTask({ authority, grantId, versionId: version.id, requestKey: randomUUID(), input: "Read this business" });
    const operationId = `tool:${task.id}:0:0`, input = { product: "growth" as const, tenantId, contextRevision: "a".repeat(64), sources: [{ id: `workspace:${tenantId}` }], text: '{"business":"Approved business","facts":["Only this tenant"]}', title: "Growth business", acquiredAt: new Date().toISOString() };
    authorization.set(task.id, { tenantId, revision: input.contextRevision, sourceId: input.sources[0]!.id, allowed: true });
    await beginOperation(pool, task.id, { id: operationId, kind: "tool", name: "growth.context_read", request: {}, reservedTokens: 0, reservedMs: 1000, retrySafe: true });
    return { task, grantId, grant, authority, version, input, operationId };
  }
  async function supply(f: Awaited<ReturnType<typeof fixture>>, passage: Awaited<ReturnType<EvidenceStore["recordProduct"]>>) {
    const id = `context:${f.task.id}:0`, payload = { messages: [{ role: "tool", content: `[${passage.label}] ${passage.text}` }] };
    await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)", [id, f.task.id, requestDigest(payload), payload]);
    return evidence.supplyContext(f.task.id, id, [passage.reference.id]);
  }
  it("inherits the callback onto a locked client without acquiring another pool slot, then clears it", async () => {
    let client: PoolClient | undefined;
    await transaction(pool, async db => { client = db; expect(productPorts(db)).toBe(productPorts(pool)); });
    expect(() => productPorts(client!)).toThrow("Product evidence authorization is unavailable");
  });
  it("records exact private observations, operation evidence, summaries, checkpoints and artifact dependencies", async () => {
    const f = await fixture(), passage = await evidence.recordProduct(f.task.id, f.operationId, f.input);
    expect(lastAuthorizationDb).not.toBe(pool);
    expect(passage.reference.sourceId).toBeNull(); expect(passage.reference.manifest.dependencies).toEqual([{ kind: "product", product: "growth", tenantId: f.input.tenantId, taskId: f.task.id, contextRevision: f.input.contextRevision, sourceId: f.input.sources[0]!.id }]);
    expect((await evidence.recordProduct(f.task.id, f.operationId, f.input)).reference.id).toBe(passage.reference.id);
    expect((await evidence.recordProduct(f.task.id, f.operationId, { ...f.input, acquiredAt: new Date(Date.now() + 1000).toISOString() })).reference.id).toBe(passage.reference.id);
    await expect(evidence.recordProduct(f.task.id, f.operationId, { ...f.input, text: "Changed observation" })).rejects.toMatchObject({ code: "EVIDENCE_INTEGRITY" });
    expect(await evidence.operationEvidenceIds(f.task.id, f.operationId)).toEqual([passage.reference.id]);
    await supply(f, passage);
    expect((await evidence.derive(f.task.id, "summary", "compact:0")).manifest).toEqual(passage.reference.manifest);
    expect((await evidence.derive(f.task.id, "artifact", randomUUID())).manifest).toEqual(passage.reference.manifest);
    const index = await evidence.suppliedEvidence(f.task.id); expect(index.items[0]?.kind).toBe("product");
    const continuation = buildContinuation({ operations: [{ id: f.operationId, name: "growth.context_read", kind: "tool", state: "completed" }], delegations: [], handles: [], artifacts: [], results: [], evidence: index.items });
    const snapshotId = `context:${f.task.id}:1`, payload = { continuation, continuationEvidenceIds: index.items.map(item => item.id) };
    await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,1,$3,$4,0)", [snapshotId, f.task.id, requestDigest(payload), payload]);
    expect((await evidence.supplyContext(f.task.id, snapshotId, [], payload.continuationEvidenceIds)).manifest).toEqual(passage.reference.manifest);
    expect((await evidence.validateCitations(f.task.id, `Business fact [${passage.label}]`))[0]?.text).toBe(f.input.text);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.sources WHERE organization_id=$1", [f.task.organization_id])).rows[0].count).toBe(0);
  });
  it("blocks forged source identity, unrelated origins and all consumed dependencies after current authorization changes", async () => {
    const f = await fixture();
    await expect(evidence.recordProduct(f.task.id, f.operationId, { ...f.input, sources: [{ id: "forged-source" }] })).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
    const passage = await evidence.recordProduct(f.task.id, f.operationId, f.input); await supply(f, passage);
    const other = await fixture();
    await expect(assertCurrentEvidence(pool, other.task.id, passage.reference.manifest)).rejects.toMatchObject({ code: "EVIDENCE_SCOPE_DENIED" });
    authorization.get(f.task.id)!.allowed = false;
    await expect(evidence.recordProduct(f.task.id, f.operationId, f.input)).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
    await expect(evidence.readPassage(f.task.id, passage.reference.id)).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
    await expect(evidence.derive(f.task.id, "artifact", randomUUID())).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
  });
  it("keeps authorized history after its dispatch grant expires and omits stale product revisions", async () => {
    const f = await fixture(), passage = await evidence.recordProduct(f.task.id, f.operationId, f.input); await supply(f, passage);
    await finishOperation(pool, f.task.id, f.operationId, "completed", {}, null, 0);
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1", [f.task.id]);
    await settleTask(pool, f.task.id, { state: "completed", output: `Observed business [${passage.label}]` });
    await pool.query("UPDATE agents_platform.execution_grants SET expires_at=created_at+interval '1 millisecond' WHERE id=$1", [f.grantId]);
    const grantId = randomUUID(); await f.grant(grantId);
    const { task } = await platform.admitTask({ authority: f.authority, grantId, versionId: f.version.id, conversationId: f.task.conversation_id, requestKey: randomUUID(), input: "Continue" });
    expect((await evidence.checkHistory(task.id, [f.task.id]))[0]?.eligible).toBe(true);
    authorization.get(f.task.id)!.revision = "b".repeat(64);
    expect((await evidence.checkHistory(task.id, [f.task.id]))[0]).toMatchObject({ eligible: false, omissionCode: "EVIDENCE_UNAVAILABLE", evidenceIds: [] });
  });
});
