import {dropClosedTestDatabase} from "./support/database-cleanup";
import { connectFixtureModel } from "./model-fixture";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentConfigurationSchema, assertGrantAuthority, connectedToolAuthorityIds, defaultBusinessConfiguration,
  executionGrantSchema, type AgentConfiguration } from "../src/contracts/contracts";
import { contextGrantCeiling } from "../src/execution/models/settings";
import { AutomationService } from "../src/product/automations/automations";
import { operationsForConfiguration } from "../src/platform/access/grant-operations";
import { PlatformStore } from "../src/product/agents/store";
import { setupPlatformSchema } from "../src/composition/setup";
import { ConnectionStore } from "../src/product/connections/connections";
import { ConnectionVault } from "../src/infrastructure/vault";
import { ConnectedCatalogStore } from "../src/capabilities/connected-tools/connected-catalog-store";
import { createCatalog, digestToolSchema, ExecutableAdapterRegistry } from "../src/contracts/capability-catalog";
import { loadExecution } from "../src/execution/lifecycle/execution";

function delegated(ids: string[], direct: string[] = []): AgentConfiguration {
  const config = defaultBusinessConfiguration();
  config.connectedToolBindingIds = direct;
  config.tools = ["agents.delegate"];
  config.capabilities.delegation = { enabled: true, maxChildren: 2, maxDepth: 1,
    bindings: [{ id: "research", versionId: randomUUID(), tools: [], sourceRevisionIds: [], connectedToolBindingIds: ids,
      maxTokens: 2048, maxActiveMs: 1000 }] };
  return config;
}

describe("direct tools and delegated authority", () => {
  it("collects a stable unique authority union without widening direct tools", () => {
    const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
    const config = delegated([second!, third!, first!], [first!, second!]);
    expect(connectedToolAuthorityIds(config)).toEqual([first, second, third]);
    expect(config.connectedToolBindingIds).toEqual([first, second]);
    expect(connectedToolAuthorityIds(defaultBusinessConfiguration())).toEqual([]);
  });

  it("requires grants and connected.read for specialist-only tools", () => {
    const config = delegated([randomUUID(), randomUUID(), randomUUID(), randomUUID()]);
    const authority = { product: "agents" as const, organizationId: randomUUID(), resourceId: randomUUID(), callerClientId: "agents-execution",
      principal: { kind: "human" as const, issuer: "https://fixture.test", subject: "owner" } };
    const versionId = randomUUID();
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId,
      operations: operationsForConfiguration(config), connectedToolBindingIds: connectedToolAuthorityIds(config), sourceRevisionIds: [],
      maxInputBytes: config.model.maxInputBytes, maxOutputTokens: config.model.maxOutputTokens, maxContextTokens: contextGrantCeiling(config),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null });
    expect(() => assertGrantAuthority(grant, authority, versionId, config)).not.toThrow();
    expect(grant.operations).toContain("connected.read");
    expect(() => assertGrantAuthority({ ...grant, connectedToolBindingIds: grant.connectedToolBindingIds.slice(1) }, authority, versionId, config))
      .toThrow("Execution exceeds");
    expect(() => assertGrantAuthority({ ...grant, operations: grant.operations.filter(operation => operation !== "connected.read") }, authority, versionId, config))
      .toThrow("Execution exceeds");
    expect(config.connectedToolBindingIds).toEqual([]);
  });

  it("limits aggregate authority to eight even across separately valid lists", () => {
    const direct = Array.from({ length: 5 }, () => randomUUID());
    const config = delegated(Array.from({ length: 4 }, () => randomUUID()), direct);
    expect(agentConfigurationSchema.safeParse(config).success).toBe(false);
    expect(() => connectedToolAuthorityIds(config)).toThrow("At most eight");
    const overlap = delegated(direct, direct);
    expect(agentConfigurationSchema.safeParse(overlap).success).toBe(true);
    expect(connectedToolAuthorityIds(overlap)).toEqual(direct);
  });
});

const dbUrl = process.env.AGENTS_TEST_DATABASE_URL;
(dbUrl ? describe : describe.skip)("delegated authority publication and admission with PostgreSQL", () => {
  let admin: Pool, pool: Pool, store: PlatformStore, connections: ConnectionStore, catalogs: ConnectedCatalogStore;
  const database = `agents_authority_${randomUUID().replaceAll("-", "")}`;
  const registry = new ExecutableAdapterRegistry<unknown>();
  const adapter = registry.register({ schemaVersion: 1, id: "github-read", release: "1.0.0", executableDigest: "a".repeat(64),
    transports: ["native_http", "mcp_http"], protocolVersions: ["2026-07-28"], boundedSchemaValidation: true }, { fixture: true });
  beforeAll(async () => {
    admin = new Pool({ connectionString: dbUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(dbUrl!); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.href }); await setupPlatformSchema(pool);
    store = new PlatformStore(pool);
    connections = new ConnectionStore(pool, new ConnectionVault("v1", { v1: randomBytes(32).toString("base64") }), []);
    catalogs = new ConnectedCatalogStore(pool, connections, registry);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await dropClosedTestDatabase(admin,database); await admin.end(); }
  });

  async function fixture() {
    const account = await store.ensureAccount({ issuer: "https://fixture.test", subject: randomUUID(), email: "owner@fixture.test", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Research");
    const scope = { accountId: account.id, organizationId: org.id };
    await connectFixtureModel(pool,account.id,org.id);
    const connection = await connections.create(scope, { operationId: randomUUID(), profileId: "github-public-read-v1", targetId: "provider:github",
      name: "Approved repository", apiKey: "github_pat_fixture_read_only_key", expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      selections: [{ owner: "approved", repository: "public-repo", ref: "main" }] });
    const inputSchema = { type: "object", properties: {}, additionalProperties: false };
    const names = ["get_repository", "resolve_ref", "list_tree", "read_file"];
    const catalog = createCatalog({ schemaVersion: 1, id: randomUUID(), organizationId: org.id, connectionId: connection.id, revision: 1,
      transport: "native_http", protocolVersion: null, adapter, tools: names.map(providerOperation => ({ providerOperation, description: "Fixture read",
        inputSchema, inputDigest: digestToolSchema(inputSchema), outputSchema: null, outputDigest: null })) });
    await catalogs.saveCandidate(scope, { operationId: randomUUID(), connectionId: connection.id, expectedRevision: 1, catalog });
    const bindings = await catalogs.selectBindings(scope, { operationId: randomUUID(), connectionId: connection.id, expectedRevision: 1,
      catalogId: catalog.id, selections: names.map(providerOperation => ({ providerOperation, resources: connection.resources })) });
    const config = defaultBusinessConfiguration(); config.tools = ["agents.delegate"];
    config.capabilities.delegation = { enabled: true, maxChildren: 2, maxDepth: 1, bindings: [] };
    for (let index = 0; index < 2; index++) {
      const ids = bindings.slice(index * 2, index * 2 + 2).map(binding => binding.id);
      const childConfig = defaultBusinessConfiguration(); childConfig.connectedToolBindingIds = ids;
      const child = await store.createAgent({ ...scope, name: `Specialist ${index}`, configuration: childConfig });
      const version = await store.createVersion({ ...scope, agentId: child.id, expectedRevision: 1 });
      config.capabilities.delegation.bindings.push({ id: `research_${index}`, versionId: version.id, sourceRevisionIds: [],
        connectedToolBindingIds: ids, tools: [], maxTokens: 2048, maxActiveMs: 1000 });
    }
    const root = await store.createAgent({ ...scope, name: "Coordinator", configuration: config });
    return { account, org, scope, root, config, connection, bindings };
  }

  it("pins four delegated tools while the coordinator exposes zero direct tools and its grant covers all four", async () => {
    const f = await fixture();
    const version = await store.createVersion({ ...f.scope, agentId: f.root.id, expectedRevision: 1 });
    expect(version.configuration.connectedToolBindingIds).toEqual([]);
    const ids = connectedToolAuthorityIds(version.configuration);
    expect(ids).toHaveLength(4);
    expect((await pool.query("SELECT binding_id FROM agents_platform.version_connected_tools WHERE version_id=$1", [version.id])).rows.map(row => row.binding_id).sort())
      .toEqual([...ids].sort());
    const authority = { product: "agents" as const, organizationId: f.org.id, resourceId: f.root.id, callerClientId: "agents-execution",
      principal: { kind: "human" as const, issuer: f.account.issuer, subject: f.account.subject } };
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id, operations: operationsForConfiguration(f.config),
      connectedToolBindingIds: ids, sourceRevisionIds: [], maxInputBytes: f.config.model.maxInputBytes,
      maxOutputTokens: f.config.model.maxOutputTokens, maxContextTokens: contextGrantCeiling(f.config), expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null });
    await store.createGrant({ accountId: f.account.id, grant });
    const { task } = await store.admitTask({ authority, versionId: version.id, grantId: grant.id, requestKey: randomUUID(), input: "Delegate research and compare the evidence." });
    expect((await loadExecution(pool, task.id)).connectedBindings).toEqual([]);
    const service = new AutomationService(pool);
    const automation = await service.create(f.scope, randomUUID(), { name: "Research", versionId: version.id, input: "Research the approved repository",
      expiresAt: new Date(Date.now() + 86400_000).toISOString(), schedule: { kind: "interval", anchor: new Date().toISOString(), everySeconds: 60 } });
    const occurrence = await service.occur(automation.id, 1, randomUUID(), new Date());
    expect(occurrence.status, occurrence.error_code??undefined).toBe("accepted");
    const saved = (await pool.query("SELECT g.connected_tool_binding_ids,g.operations FROM agents_platform.execution_grants g JOIN agents_platform.tasks t ON t.grant_id=g.id WHERE t.id=$1", [occurrence.task_id])).rows[0];
    expect([...saved.connected_tool_binding_ids].sort()).toEqual([...ids].sort());
    expect(saved.operations).toContain("connected.read");
  });

  it("revalidates fresh config, binding bodies and both saved compositions after warming pure compilation", async () => {
    const f=await fixture(),config=defaultBusinessConfiguration();config.connectedToolBindingIds=f.bindings.map(binding=>binding.id);
    await store.updateDraft({...f.scope,agentId:f.root.id,expectedRevision:1,configuration:config});
    const version=await store.createVersion({...f.scope,agentId:f.root.id,expectedRevision:2});
    const published=version.configuration;
    const authority={product:"agents" as const,organizationId:f.org.id,resourceId:f.root.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:f.account.issuer,subject:f.account.subject}};
    const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:operationsForConfiguration(config),connectedToolBindingIds:config.connectedToolBindingIds,
      sourceRevisionIds:[],maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:contextGrantCeiling(config),expiresAt:new Date(Date.now()+60000).toISOString(),revokedAt:null});
    await store.createGrant({accountId:f.account.id,grant});
    const {task}=await store.admitTask({authority,versionId:version.id,grantId:grant.id,requestKey:randomUUID(),input:"Read approved repository"});
    const warmed=await loadExecution(pool,task.id);expect((await loadExecution(pool,task.id)).connectedBindings).toEqual(warmed.connectedBindings);
    async function corrupt(table:'tasks'|'agent_versions'|'capability_bindings',trigger:string,sql:string,values:unknown[],code?:string){
      const db=await pool.connect();try{
        await db.query('BEGIN');await db.query(`ALTER TABLE agents_platform.${table} DISABLE TRIGGER ${trigger}`);await db.query(sql,values);
        if(code)await expect(loadExecution(db,task.id)).rejects.toMatchObject({code});else await expect(loadExecution(db,task.id)).rejects.toThrow();
      }finally{await db.query('ROLLBACK');db.release();}
      expect((await loadExecution(pool,task.id)).configuration).toEqual(published);
    }
    await corrupt('tasks','immutable_execution_composition',"UPDATE agents_platform.tasks SET effective_configuration=$2 WHERE id=$1",[task.id,{...published,instructions:'PRIVATE_changed_config_canary'}],'PROGRAM_RELEASE_UNAVAILABLE');
    await corrupt('agent_versions','immutable_agent_version',"UPDATE agents_platform.agent_versions SET configuration=$2 WHERE id=$1",[version.id,{...published,instructions:'PRIVATE_changed_version_canary'}],'PROGRAM_RELEASE_UNAVAILABLE');
    await corrupt('tasks','immutable_execution_composition',"UPDATE agents_platform.tasks SET effective_configuration=$2 WHERE id=$1",[task.id,{...published,model:{...published.model,provider:'untrusted'}}]);
    const binding=f.bindings[0]!;await corrupt('capability_bindings','immutable_capability_binding',"UPDATE agents_platform.capability_bindings SET binding=$2 WHERE id=$1",[binding.id,{...binding,limits:{...binding.limits,timeoutMs:29000}}]);
    await corrupt('tasks','immutable_execution_composition',"UPDATE agents_platform.tasks SET effective_composition=jsonb_set(effective_composition,'{digest}',to_jsonb(repeat('0',64))) WHERE id=$1",[task.id],'PROGRAM_RELEASE_UNAVAILABLE');
    await corrupt('agent_versions','immutable_agent_version',"UPDATE agents_platform.agent_versions SET effective_composition=jsonb_set(effective_composition,'{digest}',to_jsonb(repeat('0',64))) WHERE id=$1",[version.id],'PROGRAM_RELEASE_UNAVAILABLE');
    await corrupt('tasks','immutable_execution_composition',"UPDATE agents_platform.tasks SET harness_release='different-release' WHERE id=$1",[task.id],'HARNESS_RELEASE_UNAVAILABLE');
  });

  it("rejects a revoked delegated-only connection and tools not in the published specialist scope", async () => {
    const f = await fixture();
    const changed = structuredClone(f.config);
    if (changed.capabilities.delegation.enabled) changed.capabilities.delegation.bindings[0]!.connectedToolBindingIds.push(f.bindings[3]!.id);
    await store.updateDraft({ ...f.scope, agentId: f.root.id, expectedRevision: 1, configuration: changed });
    await expect(store.createVersion({ ...f.scope, agentId: f.root.id, expectedRevision: 2 })).rejects.toMatchObject({ code: "DELEGATION_BINDING_INVALID" });
    await store.updateDraft({ ...f.scope, agentId: f.root.id, expectedRevision: 2, configuration: f.config });
    await connections.mutate(f.scope, f.connection.id, { operationId: randomUUID(), expectedRevision: 1 }, "revoke");
    await expect(store.createVersion({ ...f.scope, agentId: f.root.id, expectedRevision: 3 })).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_DENIED" });
  });

  it("requires current account ownership and unexpired credentials for delegated-only authority", async () => {
    const f = await fixture();
    const other = await store.ensureAccount({ issuer: "https://fixture.test", subject: randomUUID(), email: "other@fixture.test", displayName: "Other" });
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')", [f.org.id, other.id]);
    const otherScope = { accountId: other.id, organizationId: f.org.id };
    const otherRoot = await store.createAgent({ ...otherScope, name: "Other coordinator", configuration: f.config });
    await expect(store.createVersion({ ...otherScope, agentId: otherRoot.id, expectedRevision: 1 })).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_DENIED" });
    await pool.query("UPDATE agents_platform.connections SET expires_at=now()-interval '1 second' WHERE id=$1", [f.connection.id]);
    await expect(store.createVersion({ ...f.scope, agentId: f.root.id, expectedRevision: 1 })).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_DENIED" });
  });

  it("requires a coordinator's direct MCP dependencies in its own scope while allowing a specialist's complete scope", async () => {
    const f = await fixture();
    const inputSchema = { type: "object", properties: {}, additionalProperties: false };
    const catalog = createCatalog({ schemaVersion: 1, id: randomUUID(), organizationId: f.org.id, connectionId: f.connection.id, revision: 2,
      transport: "mcp_http", protocolVersion: "2026-07-28", adapter, tools: [{ providerOperation: "get_file_contents", description: "Fixture read",
        inputSchema, inputDigest: digestToolSchema(inputSchema), outputSchema: null, outputDigest: null }] });
    await catalogs.saveCandidate(f.scope, { operationId: randomUUID(), connectionId: f.connection.id, expectedRevision: 1, catalog });
    const [mcp] = await catalogs.selectBindings(f.scope, { operationId: randomUUID(), connectionId: f.connection.id, expectedRevision: 1,
      catalogId: catalog.id, selections: [{ providerOperation: "get_file_contents", resources: f.connection.resources }] });
    const invalid = structuredClone(f.config); invalid.connectedToolBindingIds = [mcp!.id];
    await store.updateDraft({ ...f.scope, agentId: f.root.id, expectedRevision: 1, configuration: invalid });
    await expect(store.createVersion({ ...f.scope, agentId: f.root.id, expectedRevision: 2 })).rejects.toMatchObject({ code: "CONNECTED_HANDLE_DEPENDENCY" });
    expect((await store.listVersions(f.account.id, f.org.id, f.root.id))).toHaveLength(0);
    const childConfig = defaultBusinessConfiguration(); childConfig.connectedToolBindingIds = [...f.bindings.map(binding => binding.id), mcp!.id];
    const child = await store.createAgent({ ...f.scope, name: "Complete specialist", configuration: childConfig });
    const childVersion = await store.createVersion({ ...f.scope, agentId: child.id, expectedRevision: 1 });
    const valid = delegated(childConfig.connectedToolBindingIds);
    if (valid.capabilities.delegation.enabled) valid.capabilities.delegation.bindings[0]!.versionId = childVersion.id;
    await store.updateDraft({ ...f.scope, agentId: f.root.id, expectedRevision: 2, configuration: valid });
    const published = await store.createVersion({ ...f.scope, agentId: f.root.id, expectedRevision: 3 });
    expect(published.configuration.connectedToolBindingIds).toEqual([]);
    expect(connectedToolAuthorityIds(published.configuration)).toHaveLength(5);
  });
});
