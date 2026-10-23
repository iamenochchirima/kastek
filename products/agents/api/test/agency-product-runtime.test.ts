import { randomUUID } from "node:crypto";
import { generateKeyPair, exportPKCS8, exportSPKI } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agencyCapabilityManifest } from "../../../agency/api/src/capabilities/manifest.js";
import { buildApp } from "../../../agency/api/src/app.js";
import { readConfig } from "../../../agency/api/src/config.js";
import { runMigrations } from "../../../agency/api/src/migrate.js";
import { registerProductCapabilityRoutes } from "../../../agency/api/src/controllers/product-capabilities.js";
import { setupPlatformSchema } from "../src/composition/setup";
import { ProductRuntime } from "../src/execution/products/product-runtime";
import { registerAgencyProductCapabilities } from "../src/adapters/products/agency-capability-client";
import { createProductBindings } from "../src/capabilities/products/product-capabilities";
import { defaultBusinessConfiguration, requestDigest } from "../src/contracts/contracts";
import { PlatformStore } from "../src/product/agents/store";
import { beginOperation } from "../src/execution/lifecycle/execution";
import { productPorts } from "../src/infrastructure/product-ports";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const adminUrl = process.env.AGENTS_TEST_ADMIN_URL;
(adminUrl ? describe : describe.skip)("shared product runtime to authoritative Agency HTTP and database", () => {
  const agentsDatabase = "agents_agency_port_" + randomUUID().replaceAll("-", "");
  const agencyDatabase = "agents_agency_destination_" + randomUUID().replaceAll("-", "");
  const originTenantId = randomUUID(), workspaceId = "agency-workspace", mappedActor = { issuer: "https://growth.test/identity", subject: "growth-owner" };
  let admin: Pool, pool: Pool, agency: Pool, app: Awaited<ReturnType<typeof buildApp>>, runtime: ProductRuntime;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    const url = new URL(adminUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw Error("Agency acceptance requires a local disposable database administrator");
    url.pathname = "/postgres"; admin = new Pool({ connectionString: url.href });
    await admin.query(`CREATE DATABASE "${agentsDatabase}"`);
    await admin.query(`CREATE DATABASE "${agencyDatabase}"`);
    url.pathname = "/" + agentsDatabase; pool = new Pool({ connectionString: url.href });
    url.pathname = "/" + agencyDatabase; agency = new Pool({ connectionString: url.href });
    await setupPlatformSchema(pool); await runMigrations(agency);
    const keys = await generateKeyPair("RS256", { extractable: true });
    const config = readConfig({ TENANT_DATABASE_URL: url.href, LOG_LEVEL: "silent", AGENTS_PRODUCT_ACTION_ISSUER: "https://agents.test",
      AGENTS_PRODUCT_ACTION_PUBLIC_KEY: await exportSPKI(keys.publicKey) });
    app = await buildApp({ pool: agency, config }, [registerProductCapabilityRoutes]);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    env = { NODE_ENV: "test", AGENCY_PRODUCT_API_URL: origin, AGENTS_PRODUCT_ACTION_ISSUER: "https://agents.test",
      AGENTS_PRODUCT_ACTION_PRIVATE_KEY: await exportPKCS8(keys.privateKey) };
    runtime = new ProductRuntime(pool);
    expect(registerAgencyProductCapabilities(runtime, {})).toBe(false);
    expect(registerAgencyProductCapabilities(runtime, env)).toBe(true);
    expect(registerAgencyProductCapabilities(runtime, env)).toBe(true);
    await agency.query(`INSERT INTO workspaces(id,slug,display_name) VALUES('agency-workspace','agency','Agency'),('foreign-workspace','foreign','Foreign');
      INSERT INTO tenant_users(id,workspace_id,email,password_hash) VALUES('agency-user','agency-workspace','owner@example.test','unused');
      INSERT INTO tenant_user_roles(tenant_user_id,role) VALUES('agency-user','support');
      INSERT INTO workspace_agents(id,workspace_id,name,status,config) VALUES('agent-one','agency-workspace','Support','active','{"secret":"configuration-is-private"}'),
      ('agent-foreign','foreign-workspace','Foreign','active','{}')`);
    await agency.query(`INSERT INTO product_capability_mappings(id,origin_product,origin_tenant_id,actor_issuer,actor_subject,workspace_id,tenant_user_id,expires_at)
      VALUES('destination-map','growth',$1,$2,$3,'agency-workspace','agency-user',NOW()+INTERVAL '1 hour')`, [originTenantId, mappedActor.issuer, mappedActor.subject]);
  }, 30000);
  afterAll(async () => {
    await app?.close(); await pool?.end(); await agency?.end();
    if (admin) { await dropClosedTestDatabase(admin, agentsDatabase); await dropClosedTestDatabase(admin, agencyDatabase); await admin.end(); }
  });

  it("publishes an inline binding and invokes the generic port without inferred Agency membership", async () => {
    const store = new PlatformStore(pool);
    const creator = await store.ensureAccount({ issuer: "https://fixture.test", subject: randomUUID(), email: "builder@example.test", displayName: "Builder" });
    const org = await store.createOrganization(creator.id, "Explicit destination tools"), scope = { accountId: creator.id, organizationId: org.id };
    const model = await connectFixtureModel(pool, creator.id, org.id);
    const bindings = createProductBindings(agencyCapabilityManifest, org.id, { originProduct: "growth", originTenantId, tenantId: workspaceId,
      mappingRef: "destination-map", policyRevision: "metadata-policy-1" }, ["agency.workspace_agents.read"]);
    const binding = bindings[0]!;
    const configuration = defaultBusinessConfiguration();
    configuration.program = { id: "tool-directed", version: "3" };
    configuration.instructions = "Use the permitted Agency metadata tool when needed.";
    configuration.productBindings = bindings;
    configuration.model.selection = { kind: "connection", connectionId: model.connection.id, modelId: model.modelId };
    const agent = await store.createAgent({ ...scope, name: "Shared port", configuration });
    await model.store.grant(scope, { connectionId: model.connection.id, consumer: { kind: "agent", agentId: agent.id }, roles: ["primary", "compaction", "delegated"], modelIds: [model.modelId] });
    const version = await store.createVersion({ ...scope, agentId: agent.id, expectedRevision: 1 });
    await pool.query("INSERT INTO agents_platform.product_execution_tenants(product,tenant_id,organization_id,client_id,issuer) VALUES('growth',$1,$2,'growth-api',$3)", [originTenantId, org.id, mappedActor.issuer]);
    await pool.query("INSERT INTO agents_platform.product_execution_features(product,tenant_id,feature_id,organization_id,agent_id,version_id) VALUES('growth',$1,'assistant',$2,$3,$4)", [originTenantId, org.id, agent.id, version.id]);
    const grantId = randomUUID(), principal = { kind: "human" as const, ...mappedActor };
    await pool.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,max_input_bytes,max_output_tokens,max_context_tokens,root_token_limit,expires_at)
      VALUES($1,'growth',$2,'assistant','growth-api',$3,$4,$5,$6,$7,$8,32000,now()+interval '5 minutes')`,
    [grantId, org.id, principal, version.id, JSON.stringify(["model.reply", "product.read"]), configuration.model.maxInputBytes, configuration.model.maxOutputTokens, configuration.context.maxInputTokens]);
    await pool.query("INSERT INTO agents_platform.product_execution_authorities(grant_id,product,organization_id,client_id,issuer,assertion_digest) VALUES($1,'growth',$2,'growth-api',$3,$4)", [grantId, org.id, mappedActor.issuer, "a".repeat(64)]);
    const authority = { product: "growth" as const, organizationId: org.id, resourceId: "assistant", callerClientId: "growth-api", principal };
    const { task } = await store.admitTask({ authority, grantId, versionId: version.id, requestKey: randomUUID(), input: "Read Agency agent metadata" });
    await pool.query("INSERT INTO agents_platform.product_conversations(conversation_id,product,tenant_id,feature_id,title) VALUES($1,'growth',$2,'assistant','Metadata')", [task.conversation_id, originTenantId]);
    await pool.query("INSERT INTO agents_platform.product_task_contexts(task_id,product,tenant_id,feature_id,conversation_id,command_digest) VALUES($1,'growth',$2,'assistant',$3,$4)", [task.id, originTenantId, task.conversation_id, "a".repeat(64)]);
    await expect(runtime.authorizeTask(task.id)).rejects.toMatchObject({ statusCode: 403 });
    await agency.query(`INSERT INTO product_capability_grants(mapping_id,operation,manifest_digest,descriptor_digest,handler_ref,policy_revision,binding_id,binding_digest,agent_ids,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'["agent-one","agent-foreign"]',NOW()+INTERVAL '1 hour')`,
    [binding.authority!.mappingRef, binding.definition.providerOperation, binding.authority!.manifestDigest, binding.authority!.descriptorDigest,
      binding.authority!.handlerRef, binding.authority!.policyRevision, binding.id, binding.digest]);
    await runtime.authorizeTask(task.id);
    const otherPool = new Pool({ connectionString: pool.options.connectionString });
    try {
      const isolated = new ProductRuntime(otherPool);
      registerAgencyProductCapabilities(isolated, { ...env, AGENTS_PRODUCT_ACTION_ISSUER: "https://untrusted-agents.test" });
      await expect(isolated.authorizeTask(task.id)).rejects.toMatchObject({ statusCode: 401 });
      await runtime.authorizeTask(task.id);
    } finally { await otherPool.end(); }
    const operationId = `tool:${task.id}:0:0`;
    await beginOperation(pool, task.id, { id: operationId, kind: "tool", name: binding.alias, request: {}, reservedTokens: 0, reservedMs: 1000, retrySafe: true });
    const result = await runtime.invoke(task.id, operationId, binding, {});
    expect(JSON.stringify(result)).toContain("Support");
    expect(JSON.stringify(result)).not.toContain("configuration-is-private");
    expect(JSON.stringify(result)).not.toContain("agent-foreign");
    const evidence = (await runtime.evidence.operationEvidenceIds(task.id, operationId))[0]!;
    expect(evidence).toBeTruthy();
    const row = (await pool.query("SELECT manifest FROM agents_platform.evidence_references WHERE id=$1", [evidence])).rows[0];
    const dependency = row.manifest.dependencies[0];
    await productPorts(pool).assertCurrentEvidence(pool, { consumerTaskId: task.id, dependency });
    await agency.query("UPDATE workspace_agents SET updated_at=NOW()+INTERVAL '1 second' WHERE id='agent-one'");
    await expect(productPorts(pool).assertCurrentEvidence(pool, { consumerTaskId: task.id, dependency })).rejects.toMatchObject({ statusCode: 403 });
    await agency.query("DELETE FROM tenant_user_roles WHERE tenant_user_id='agency-user'");
    await expect(runtime.authorizeTask(task.id)).rejects.toMatchObject({ statusCode: 403 });
    expect((await pool.query("SELECT count(*) FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2", [mappedActor.issuer, mappedActor.subject])).rows[0].count).toBe("0");
  }, 30000);
});
