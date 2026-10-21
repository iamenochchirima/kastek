import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { ModelProviderStore } from "../src/product/model-providers/store";
import { ModelCredentialVault } from "../src/infrastructure/model-credential-vault";
import { ConnectionVault } from "../src/infrastructure/vault";
import { registerModelProviderDependencyRoutes } from "../src/product/model-providers/dependencies";
import { defaultBusinessConfiguration, requestDigest, PlatformError } from "../src/contracts/contracts";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("provider dependencies and explicit reuse with PostgreSQL", () => {
  const database = `model_dependencies_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, platform: PlatformStore, models: ModelProviderStore;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href });
    await setupPlatformSchema(pool); platform = new PlatformStore(pool);
    models = new ModelProviderStore(pool, new ModelCredentialVault(new ConnectionVault("test", { test: randomBytes(32).toString("base64") })));
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.end(); } });
  async function fixture() {
    const account = await platform.ensureAccount({ issuer: "https://identity.example.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const organization = await platform.createOrganization(account.id, "Models"); const scope = { accountId: account.id, organizationId: organization.id };
    const connection = await models.create(scope, { providerId: "openai", name: "Main", apiKey: "fixture-key" });
    const configuration = defaultBusinessConfiguration(); configuration.model.selection = { kind: "connection", connectionId: connection.id, modelId: "model-one" };
    const agent = await platform.createAgent({ ...scope, name: "Support", configuration });
    const app = Fastify(); registerModelProviderDependencyRoutes(app, { pool, resolveScope: async () => scope });
    app.setErrorHandler((error, _req, reply) => { const failure = error as PlatformError; reply.code(failure.statusCode ?? 500).send({ error: { code: failure.code, message: error.message } }); });
    return { scope, connection, agent, app, configuration };
  }
  it("lists actual agent/default/schedule dependencies and paginates without credential material", async () => {
    const f = await fixture(); await models.setDefault(f.scope, { connectionId: f.connection.id, modelId: "model-one", expectedRevision: null });
    const version = await platform.createVersion({ ...f.scope, agentId: f.agent.id, expectedRevision: 1 });
    const automation = randomUUID();
    await pool.query("INSERT INTO agents_platform.automations(id,organization_id,owner_account_id,name) VALUES($1,$2,$3,'Daily support')", [automation, f.scope.organizationId, f.scope.accountId]);
    await pool.query("INSERT INTO agents_platform.automation_revisions(automation_id,revision,version_id,configuration) VALUES($1,1,$2,'{}')", [automation, version.id]);
    const scheduledRoutes = { primary: { binding: { connectionId: f.connection.id } } };
    await pool.query("INSERT INTO agents_platform.automation_model_routes(automation_id,revision,organization_id,version_id,routes,snapshot_digest) VALUES($1,1,$2,$3,$4,$5)",
      [automation, f.scope.organizationId, version.id, scheduledRoutes, requestDigest(scheduledRoutes)]);
    const grant = randomUUID(), conversation = randomUUID(), principal = { kind: "human", issuer: "https://identity.example.test", subject: "fixture" };
    await pool.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,max_input_bytes,max_output_tokens,expires_at)
      VALUES($1,'agents',$2,$3,'agents-execution',$4,$5,'["model.reply"]',8192,1024,now()+interval '1 hour')`, [grant, f.scope.organizationId, f.agent.id, principal, version.id]);
    await pool.query("INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal) VALUES($1,$2,$3,$4)", [conversation, f.scope.organizationId, f.agent.id, principal]);
    for (const [index, state] of ["running", "uncertain", "completed"].entries()) {
      const task = randomUUID();
      await pool.query(`INSERT INTO agents_platform.tasks(id,product,organization_id,resource_id,caller_client_id,principal,version_id,grant_id,conversation_id,request_key,request_digest,input,state,effective_composition,turn_sequence)
        VALUES($1,'agents',$2,$3,'agents-execution',$4,$5,$6,$7,$8,$9,'hi',$8,(SELECT effective_composition FROM agents_platform.agent_versions WHERE id=$5),$10)`, [task, f.scope.organizationId, f.agent.id, principal, version.id, grant, conversation, state, "a".repeat(64), index + 1]);
      await pool.query("INSERT INTO agents_platform.task_model_routes(task_id,organization_id,routes,snapshot_digest) VALUES($1,$2,$3,$4)", [task, f.scope.organizationId, { primary: { binding: { connectionId: f.connection.id } } }, "a".repeat(64)]);
    }
    const first = await f.app.inject({ url: `/api/organizations/${f.scope.organizationId}/model-providers/${f.connection.id}/dependencies` });
    expect(first.statusCode, first.body).toBe(200); expect(first.json()).toMatchObject({ total: 2, defaultModel: { modelId: "model-one" }, activeTasks: 1, uncertainTasks: 1 });
    expect(first.json().entries.map((entry: { kind: string }) => entry.kind)).toEqual(["agent", "schedule"]); expect(first.body).not.toContain("fixture-key");
    for (let i = 0; i < 51; i++) await platform.createAgent({ ...f.scope, name: `Additional ${i}`, configuration: f.configuration });
    const page = (await f.app.inject({ url: `/api/organizations/${f.scope.organizationId}/model-providers/${f.connection.id}/dependencies` })).json();
    expect(page.entries).toHaveLength(50); expect(page.total).toBe(53); expect(page.nextCursor).toBeTruthy();
    const next = (await f.app.inject({ url: `/api/organizations/${f.scope.organizationId}/model-providers/${f.connection.id}/dependencies?cursor=${encodeURIComponent(page.nextCursor)}` })).json();
    expect(next.entries).toHaveLength(3); expect(next.nextCursor).toBeNull(); await f.app.close();
  });
  it("reconnect alone never restores use; explicit authorization binds current connection and agent revisions", async () => {
    const f = await fixture(); await platform.createVersion({ ...f.scope, agentId: f.agent.id, expectedRevision: 1 });
    const revoked = await models.revoke(f.scope, f.connection.id, 1); const connected = await models.update(f.scope, f.connection.id, { expectedRevision: revoked.revision, apiKey: "new-fixture-key" });
    const url = `/api/organizations/${f.scope.organizationId}/model-providers/${f.connection.id}/reauthorize`;
    expect((await pool.query("SELECT state FROM agents_platform.model_provider_use_grants WHERE connection_id=$1", [f.connection.id])).rows.every(row => row.state === "revoked")).toBe(true);
    const stale = await f.app.inject({ method: "POST", url, payload: { expectedRevision: 1, agentId: f.agent.id, agentRevision: 1 } }); expect(stale.statusCode).toBe(409);
    const response = await f.app.inject({ method: "POST", url, payload: { expectedRevision: connected.revision, agentId: f.agent.id, agentRevision: 1 } }); expect(response.statusCode).toBe(200);
    const grants = (await pool.query("SELECT consumer,roles,model_ids FROM agents_platform.model_provider_use_grants WHERE connection_id=$1 AND state='active'", [f.connection.id])).rows;
    expect(grants).toEqual([{ consumer: { kind: "agent", agentId: f.agent.id }, roles: ["primary", "compaction", "delegated"], model_ids: ["model-one"] }]); await f.app.close();
  });
  it("denies members, foreign tenants and unrelated agent reuse", async () => {
    const f = await fixture(), other = await fixture();
    const unrelated = await platform.createAgent({ ...f.scope, name: "Unrelated" });
    const url = `/api/organizations/${f.scope.organizationId}/model-providers/${f.connection.id}/reauthorize`;
    expect((await f.app.inject({ method: "POST", url, payload: { expectedRevision: 1, agentId: unrelated.id, agentRevision: 1 } })).statusCode).toBe(409);
    expect((await other.app.inject({ url: `/api/organizations/${other.scope.organizationId}/model-providers/${f.connection.id}/dependencies` })).statusCode).toBe(404);
    await pool.query("UPDATE agents_platform.memberships SET role='member' WHERE organization_id=$1 AND account_id=$2", [f.scope.organizationId, f.scope.accountId]);
    expect((await f.app.inject({ url: `/api/organizations/${f.scope.organizationId}/model-providers/${f.connection.id}/dependencies` })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "POST", url, payload: { expectedRevision: 1, agentId: f.agent.id, agentRevision: 1 } })).statusCode).toBe(403);
    await f.app.close(); await other.app.close();
  });
});
