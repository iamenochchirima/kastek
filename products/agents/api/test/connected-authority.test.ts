import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentConfigurationSchema, assertGrantAuthority, connectedToolAuthorityIds, defaultFaqConfiguration,
  executionGrantSchema, type AgentConfiguration } from "../src/platform/contracts";
import { AutomationService, operationsForConfiguration } from "../src/platform/automations";
import { PlatformStore } from "../src/platform/store";
import { setupPlatformSchema } from "../src/platform/setup";
import { ConnectionStore } from "../src/platform/connections";
import { ConnectionVault } from "../src/platform/vault";
import { ConnectedCatalogStore } from "../src/platform/connected-catalog-store";
import { createCatalog, digestToolSchema, ExecutableAdapterRegistry } from "../src/platform/capability-catalog";
import { loadExecution } from "../src/platform/execution";

function delegated(ids: string[], direct: string[] = []): AgentConfiguration {
  const config = defaultFaqConfiguration();
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
    expect(connectedToolAuthorityIds(defaultFaqConfiguration())).toEqual([]);
  });

  it("requires grants and connected.read for specialist-only tools", () => {
    const config = delegated([randomUUID(), randomUUID(), randomUUID(), randomUUID()]);
    const authority = { product: "agents" as const, organizationId: randomUUID(), resourceId: randomUUID(), callerClientId: "agents-execution",
      principal: { kind: "human" as const, issuer: "https://fixture.test", subject: "owner" } };
    const versionId = randomUUID();
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId,
      operations: operationsForConfiguration(config), connectedToolBindingIds: connectedToolAuthorityIds(config), sourceRevisionIds: [],
      maxInputBytes: config.model.maxInputBytes, maxOutputTokens: config.model.maxOutputTokens,
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
    transports: ["native_http"], protocolVersions: [], boundedSchemaValidation: true }, { fixture: true });
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
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.end(); }
  });

  async function fixture() {
    const account = await store.ensureAccount({ issuer: "https://fixture.test", subject: randomUUID(), email: "owner@fixture.test", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Research");
    const scope = { accountId: account.id, organizationId: org.id };
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
    const config = defaultFaqConfiguration(); config.tools = ["agents.delegate"];
    config.capabilities.delegation = { enabled: true, maxChildren: 2, maxDepth: 1, bindings: [] };
    for (let index = 0; index < 2; index++) {
      const ids = bindings.slice(index * 2, index * 2 + 2).map(binding => binding.id);
      const childConfig = defaultFaqConfiguration(); childConfig.connectedToolBindingIds = ids;
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
      maxOutputTokens: f.config.model.maxOutputTokens, expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null });
    await store.createGrant({ accountId: f.account.id, grant });
    const { task } = await store.admitTask({ authority, versionId: version.id, grantId: grant.id, requestKey: randomUUID(), input: "Delegate research and compare the evidence." });
    expect((await loadExecution(pool, task.id)).connectedBindings).toEqual([]);
    const service = new AutomationService(pool);
    const automation = await service.create(f.scope, randomUUID(), { name: "Research", versionId: version.id, input: "Research the approved repository",
      expiresAt: new Date(Date.now() + 86400_000).toISOString(), schedule: { kind: "interval", anchor: new Date().toISOString(), everySeconds: 60 } });
    const occurrence = await service.occur(automation.id, 1, randomUUID(), new Date());
    expect(occurrence.status).toBe("accepted");
    const saved = (await pool.query("SELECT g.connected_tool_binding_ids,g.operations FROM agents_platform.execution_grants g JOIN agents_platform.tasks t ON t.grant_id=g.id WHERE t.id=$1", [occurrence.task_id])).rows[0];
    expect([...saved.connected_tool_binding_ids].sort()).toEqual([...ids].sort());
    expect(saved.operations).toContain("connected.read");
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
});
