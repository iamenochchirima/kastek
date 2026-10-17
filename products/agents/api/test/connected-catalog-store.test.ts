import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlatformStore } from "../src/platform/store";
import { setupPlatformSchema } from "../src/platform/setup";
import { transaction } from "../src/platform/database";
import { ConnectionStore } from "../src/platform/connections";
import { ConnectionVault } from "../src/platform/vault";
import { ConnectedCatalogStore } from "../src/platform/connected-catalog-store";
import { createCatalog, digestToolSchema, ExecutableAdapterRegistry, type CapabilityCatalog } from "../src/platform/capability-catalog";

const dbUrl = process.env.AGENTS_TEST_DATABASE_URL;
(dbUrl ? describe : describe.skip)("connected profiles and immutable catalogs with actual PostgreSQL", () => {
  let admin: Pool, pool: Pool, platform: PlatformStore, connections: ConnectionStore, catalogs: ConnectedCatalogStore;
  const database = `agents_catalog_${randomUUID().replaceAll("-", "")}`;
  const vault = new ConnectionVault("v1", { v1: randomBytes(32).toString("base64") });
  const registry = new ExecutableAdapterRegistry<unknown>();
  const executor = { execute: "owned-native-and-mcp-executor" };
  const adapter = registry.register({ schemaVersion: 1, id: "github-read", release: "1.0.0", executableDigest: "a".repeat(64),
    transports: ["native_http", "mcp_http"], protocolVersions: ["2026-07-28", "2025-11-25"], boundedSchemaValidation: true }, executor);
  const selection = { owner: "approved", repository: "public-repo", ref: "main" }, key = "github_pat_fixture_public_read_only_token";
  const expiry = () => new Date(Date.now() + 86400000).toISOString();
  beforeAll(async () => {
    admin = new Pool({ connectionString: dbUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(dbUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href }); await setupPlatformSchema(pool);
    platform = new PlatformStore(pool); connections = new ConnectionStore(pool, vault, [{ id: "reports", label: "Reports", resource: "reports:test", url: "http://127.0.0.1:9082/deliveries" }]);
    catalogs = new ConnectedCatalogStore(pool, connections, registry);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.end(); } });
  async function fixture() {
    const account = await platform.ensureAccount({ issuer: "http://localhost/catalog", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const organization = await platform.createOrganization(account.id, "Connected research");
    const scope = { accountId: account.id, organizationId: organization.id };
    const connection = await connections.create(scope, { operationId: randomUUID(), profileId: "github-public-read-v1", targetId: "provider:github", name: "Public research", apiKey: key, expiresAt: expiry(), selections: [selection] });
    return { scope, connection };
  }
  function candidate(connection: Awaited<ReturnType<typeof fixture>>["connection"], organizationId: string, names = ["get_repository"], revision = 1, transport: "native_http" | "mcp_http" = "native_http") {
    const inputSchema = { type: "object", properties: {}, additionalProperties: false };
    return createCatalog({ schemaVersion: 1, id: randomUUID(), organizationId, connectionId: connection.id, revision, transport,
      protocolVersion: transport === "mcp_http" ? "2026-07-28" : null, adapter,
      tools: names.map(providerOperation => ({ providerOperation, description: "Trusted read", inputSchema, inputDigest: digestToolSchema(inputSchema), outputSchema: null, outputDigest: null })) });
  }
  async function save(f: Awaited<ReturnType<typeof fixture>>, catalog = candidate(f.connection, f.scope.organizationId)) {
    return catalogs.saveCandidate(f.scope, { operationId: randomUUID(), connectionId: f.connection.id, expectedRevision: f.connection.revision, catalog });
  }
  function selectionRequest(f: Awaited<ReturnType<typeof fixture>>, catalogId: string, providerOperation = "get_repository") {
    return { operationId: randomUUID(), connectionId: f.connection.id, expectedRevision: f.connection.revision, catalogId,
      selections: [{ providerOperation, resources: f.connection.resources }] };
  }

  it("keeps report creation compatible and provider credentials encrypted with explicit finite scope", async () => {
    const f = await fixture();
    const report = await connections.create(f.scope, { operationId: randomUUID(), name: "Reports", targetId: "reports", apiKey: "report-fixture-scoped-key" });
    expect(report.profileId).toBe("report-delivery-v1"); expect(report.resources).toEqual([{ kind: "report.destination", id: "reports:test" }]);
    expect(f.connection.profileId).toBe("github-public-read-v1"); expect(f.connection.resources).toEqual([{ kind: "github.repository", id: "approved/public-repo" }]);
    expect(JSON.stringify(await connections.list(f.scope))).not.toContain(key);
    const stored = (await pool.query("SELECT envelope FROM agents_platform.connection_credentials WHERE connection_id=$1", [f.connection.id])).rows[0].envelope;
    expect(JSON.stringify(stored)).not.toContain(key);
    const resolved = await transaction(pool, db => connections.resolveCredential(db, f.scope, f.connection.id, 1));
    expect(resolved.authorization).toBe(key);
    for (const changed of [{ expiresAt: undefined }, { apiKey: "ghp_classic_token_not_allowed" }, { selections: [] }, { targetId: "reports" }]) await expect(connections.create(f.scope,
      { operationId: randomUUID(), name: "Invalid", targetId: "provider:github", apiKey: key, profileId: "github-public-read-v1", expiresAt: expiry(), selections: [selection], ...changed })).rejects.toBeDefined();
  });

  it("stores immutable candidates, selects exact aliases and replays concurrent selection once", async () => {
    const f = await fixture(), catalog = await save(f), input = selectionRequest(f, catalog.id);
    const [a, b] = await Promise.all([catalogs.selectBindings(f.scope, input), catalogs.selectBindings(f.scope, input)]);
    expect(a).toEqual(b); expect(a[0]!.definition.providerOperation).toBe("get_repository");
    expect(a[0]!.connection?.policyRevision).toBe(1);
    expect(await catalogs.listBindings(f.scope)).toEqual(a);
    expect(await catalogs.getBindings(f.scope, [a[0]!.id])).toEqual(a);
    expect((await pool.query("SELECT count(*) FROM agents_platform.capability_bindings WHERE connection_id=$1", [f.connection.id])).rows[0].count).toBe("1");
    await expect(pool.query("UPDATE agents_platform.capability_catalogs SET revision=2 WHERE id=$1", [catalog.id])).rejects.toThrow("immutable");
    await expect(pool.query("DELETE FROM agents_platform.capability_bindings WHERE id=$1", [a[0]!.id])).rejects.toThrow("immutable");
    await expect(catalogs.selectBindings(f.scope, { ...input, selections: [{ ...input.selections[0]!, resources: [] }] })).rejects.toBeDefined();
  });

  it("rejects stale discovery after rotation while preserving a published unchanged policy binding", async () => {
    const f = await fixture(), oldCatalog = await save(f), selected = await catalogs.selectBindings(f.scope, selectionRequest(f, oldCatalog.id));
    const rotated = await connections.mutate(f.scope, f.connection.id, { operationId: randomUUID(), expectedRevision: 1, apiKey: "github_pat_rotated_public_read_only_key", expiresAt: expiry() }, "rotate");
    expect(rotated.revision).toBe(2); expect(rotated.policyRevision).toBe(1);
    await expect(catalogs.selectBindings(f.scope, { ...selectionRequest(f, oldCatalog.id), expectedRevision: 2 })).rejects.toMatchObject({ code: "CATALOG_CONNECTION_CHANGED" });
    const credential = await transaction(pool, db => connections.resolveCredential(db, f.scope, f.connection.id, selected[0]!.connection!.policyRevision));
    expect(credential.authorization).toContain("rotated");
    const fresh = candidate(rotated, f.scope.organizationId, ["get_repository"], 2);
    await catalogs.saveCandidate(f.scope, { operationId: randomUUID(), connectionId: rotated.id, expectedRevision: 2, catalog: fresh });
    expect((await catalogs.listCandidates(f.scope, rotated.id)).map(row => row.catalog.revision)).toEqual([2, 1]);
    const revoked = await connections.mutate(f.scope, rotated.id, { operationId: randomUUID(), expectedRevision: 2 }, "revoke");
    expect(revoked.policyRevision).toBe(2);
    await expect(transaction(pool, db => connections.resolveCredential(db, f.scope, rotated.id, 1))).rejects.toMatchObject({ code: "CONNECTION_INACTIVE" });
    await expect(catalogs.selectBindings(f.scope, { ...selectionRequest(f, fresh.id), expectedRevision: 3 })).rejects.toMatchObject({ code: "CONNECTION_INACTIVE" });
  });

  it("renews an expired provider credential only with explicit unchanged scopes and a fresh expiry", async () => {
    const f = await fixture(); await pool.query("UPDATE agents_platform.connections SET expires_at=now()-interval '1 second' WHERE id=$1", [f.connection.id]);
    await expect(connections.mutate(f.scope, f.connection.id, { operationId: randomUUID(), expectedRevision: 1, apiKey: key }, "rotate")).rejects.toMatchObject({ code: "CONNECTION_REVISION_CONFLICT" });
    const renewed = await connections.mutate(f.scope, f.connection.id, { operationId: randomUUID(), expectedRevision: 1, apiKey: key, expiresAt: expiry() }, "rotate");
    expect(renewed.policyRevision).toBe(1); expect(renewed.resources).toEqual(f.connection.resources);
  });

  it("denies foreign catalogs, wider resources, untrusted writes and missing executable releases", async () => {
    const f = await fixture(), other = await fixture(), catalog = await save(f);
    await expect(catalogs.getBindings(other.scope, [randomUUID()])).rejects.toMatchObject({ code: "ACTION_NOT_FOUND" });
    await expect(catalogs.saveCandidate(f.scope, { operationId: randomUUID(), connectionId: f.connection.id, expectedRevision: 1,
      catalog: candidate(other.connection, other.scope.organizationId) })).rejects.toMatchObject({ code: "CATALOG_SCOPE_DENIED" });
    await expect(catalogs.selectBindings(other.scope, { ...selectionRequest(f, catalog.id) })).rejects.toMatchObject({ code: "ACTION_NOT_FOUND" });
    await expect(catalogs.selectBindings(f.scope, { ...selectionRequest(f, catalog.id), selections: [{ providerOperation: "get_repository", resources: [{ kind: "github.repository", id: "unapproved/private" }] }] })).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_DENIED" });
    const mcp = await save(f, candidate(f.connection, f.scope.organizationId, ["delete_repository", "get_file_contents"], 2, "mcp_http"));
    await expect(catalogs.selectBindings(f.scope, selectionRequest(f, mcp.id, "delete_repository"))).rejects.toMatchObject({ code: "PROVIDER_OPERATION_DENIED" });
    expect((await catalogs.selectBindings(f.scope, selectionRequest(f, mcp.id, "get_file_contents")))[0]!.transport).toBe("mcp_http");
    const missing = new ConnectedCatalogStore(pool, connections, new ExecutableAdapterRegistry());
    await expect(missing.selectBindings(f.scope, selectionRequest(f, catalog.id))).rejects.toMatchObject({ code: "ADAPTER_RELEASE_UNAVAILABLE" });
  });
});
