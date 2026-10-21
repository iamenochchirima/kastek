import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { ModelProviderStore } from "../src/product/model-providers/store";
import { ModelCredentialVault } from "../src/infrastructure/model-credential-vault";
import { ConnectionVault } from "../src/infrastructure/vault";
import { transaction } from "../src/infrastructure/database";
import { requestDigest } from "../src/contracts/contracts";
import { getProviderDefinition } from "../src/adapters/models/registry";
import type { ProviderConnection, ResolvedModelBinding } from "../src/contracts/model-providers";
import { registerModelProviderRoutes } from "../src/product/model-providers/routes";
import { builtinProviderRegistry } from "../src/adapters/models/registry";
import type { ModelDiscoveryRequest } from "../src/adapters/models/discovery";

const keyring = new ConnectionVault("test", { test: randomBytes(32).toString("base64") });
const vault = new ModelCredentialVault(keyring);
describe("model secret domain separation", () => {
  it("binds ciphertext to tenant, connection, endpoint, protocol and generation", () => {
    const context = { organizationId: randomUUID(), connectionId: randomUUID(), credentialRevision: 1,
      endpoint: "https://api.example.test/v1", protocol: "openai_responses" as const };
    const envelope = vault.seal(context, "x");
    expect(vault.open(context, envelope)).toBe("x");
    for (const change of [{ organizationId: randomUUID() }, { connectionId: randomUUID() }, { credentialRevision: 2 },
      { endpoint: "https://other.example.test/v1" }, { protocol: "anthropic_messages" as const }]) {
      expect(() => vault.open({ ...context, ...change }, envelope)).toThrow("Model credential is unavailable");
    }
    expect(() => keyring.open(context.organizationId, context.connectionId, 1, envelope)).toThrow();
    for (const key of ["", "bad\r\nheader", "bad key", "x".repeat(4097)]) expect(() => vault.seal(context, key)).toThrow();
  });
});

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("model provider lifecycle with real PostgreSQL", () => {
  const database = `agents_models_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, platform: PlatformStore, models: ModelProviderStore;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.href }); await setupPlatformSchema(pool);
    platform = new PlatformStore(pool); models = new ModelProviderStore(pool, vault);
  });
  afterAll(async () => {
    await pool?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.end(); }
  });
  async function fixture() {
    const account = await platform.ensureAccount({ issuer: "https://identity.example.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const organization = await platform.createOrganization(account.id, "Model accounts");
    const scope = { accountId: account.id, organizationId: organization.id };
    const connection = await models.create(scope, { providerId: "openrouter", name: "Work", apiKey: "fixture-key-one" });
    return { scope, connection };
  }
  async function binding(f: Awaited<ReturnType<typeof fixture>>, connection: ProviderConnection = f.connection) {
    const agent = await platform.createAgent({ ...f.scope, name: "Agent" });
    const consumer = { kind: "agent" as const, agentId: agent.id };
    const grant = await models.grant(f.scope, { connectionId: connection.id, consumer, modelIds: ["lab/model"], roles: ["primary"] });
    const definition = getProviderDefinition(connection.providerId)!;
    const route: ResolvedModelBinding = { organizationId: f.scope.organizationId, connectionId: connection.id,
      connectionRevision: connection.revision, credentialRevision: connection.credentialRevision,
      useGrantId: grant.id, useGrantRevision: grant.revision, providerId: definition.id,
      providerDefinitionDigest: requestDigest(definition), endpoint: connection.endpoint, protocol: connection.protocol,
      modelId: "lab/model", modelRevision: "fixture", adapterId: definition.adapter.id, adapterRevision: definition.adapter.revision,
      role: "primary", policyDigest: "a".repeat(64) };
    return { route, consumer };
  }
  it("stores encrypted keys and returns only public metadata for multiple accounts", async () => {
    const f = await fixture();
    await models.create(f.scope, { providerId: "anthropic", name: "Support", apiKey: "fixture-key-two" });
    const list = await models.list(f.scope);
    expect(list).toHaveLength(2); expect(JSON.stringify(list)).not.toContain("fixture-key");
    expect(list.every(item => item.verification === "saved")).toBe(true);
    const stored = await pool.query("SELECT envelope FROM agents_platform.model_provider_credentials WHERE organization_id=$1", [f.scope.organizationId]);
    expect(JSON.stringify(stored.rows)).not.toContain("fixture-key");
    expect(stored.rows[0].envelope.keyId).toBe("test");
  });
  it("denies foreign tenants and members who cannot administer keys", async () => {
    const f = await fixture(), other = await fixture();
    await expect(models.get(other.scope, f.connection.id)).rejects.toMatchObject({ code: "MODEL_CONNECTION_NOT_FOUND" });
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')", [f.scope.organizationId, other.scope.accountId]);
    const member = { accountId: other.scope.accountId, organizationId: f.scope.organizationId };
    expect((await models.list(member))[0]!.id).toBe(f.connection.id);
    await expect(models.update(member, f.connection.id, { expectedRevision: 1, apiKey: "foreign-key" })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(models.create(member, { providerId: "openai", name: "Other", apiKey: "foreign-key" })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it("requires endpoint key re-entry and rejects stale edits and old credential bindings", async () => {
    const f = await fixture(), accepted = await binding(f);
    expect(await transaction(pool, db => models.resolveCredential(db, accepted.route, accepted.consumer))).toBe("fixture-key-one");
    await expect(models.update(f.scope, f.connection.id, { expectedRevision: 1, endpoint: "https://relay.example.test/v1" })).rejects.toMatchObject({ code: "MODEL_KEY_REENTRY_REQUIRED" });
    const rotated = await models.update(f.scope, f.connection.id, { expectedRevision: 1, apiKey: "rotated-key", endpoint: "https://relay.example.test/v1" });
    expect(rotated.credentialRevision).toBe(2); expect(rotated.revision).toBe(2); expect(rotated.verification).toBe("saved");
    await expect(models.update(f.scope, f.connection.id, { expectedRevision: 1, name: "Stale" })).rejects.toMatchObject({ code: "MODEL_CONNECTION_CHANGED" });
    await expect(transaction(pool, db => models.resolveCredential(db, accepted.route, accepted.consumer))).rejects.toMatchObject({ code: "MODEL_CONNECTION_CHANGED" });
    const next = await binding(f, rotated);
    expect(await transaction(pool, db => models.resolveCredential(db, next.route, next.consumer))).toBe("rotated-key");
    const old = await pool.query("SELECT envelope,state FROM agents_platform.model_provider_credentials WHERE organization_id=$1 AND connection_id=$2 AND revision=1", [f.scope.organizationId, f.connection.id]);
    expect(old.rows[0]).toEqual({ envelope: null, state: "revoked" });
  });
  it("checks consumer, model, role, definition and use-grant revocation at dispatch", async () => {
    const f = await fixture(), accepted = await binding(f);
    for (const route of [{ ...accepted.route, modelId: "unapproved" }, { ...accepted.route, role: "compaction" as const },
      { ...accepted.route, providerDefinitionDigest: "b".repeat(64) }]) {
      await expect(transaction(pool, db => models.resolveCredential(db, route, accepted.consumer))).rejects.toThrow();
    }
    await expect(transaction(pool, db => models.resolveCredential(db, accepted.route, { kind: "agent", agentId: randomUUID() }))).rejects.toMatchObject({ code: "MODEL_USE_DENIED" });
    await pool.query("UPDATE agents_platform.model_provider_use_grants SET state='revoked' WHERE id=$1", [accepted.route.useGrantId]);
    await expect(transaction(pool, db => models.resolveCredential(db, accepted.route, accepted.consumer))).rejects.toMatchObject({ code: "MODEL_USE_DENIED" });
  });
  it("revokes credentials and grants without environmental fallback, then hides removal", async () => {
    const f = await fixture(), accepted = await binding(f);
    const revoked = await models.revoke(f.scope, f.connection.id, 1);
    expect(revoked.state).toBe("revoked");
    await expect(transaction(pool, db => models.resolveCredential(db, accepted.route, accepted.consumer))).rejects.toMatchObject({ code: "MODEL_CONNECTION_CHANGED" });
    expect((await pool.query("SELECT envelope FROM agents_platform.model_provider_credentials WHERE connection_id=$1", [f.connection.id])).rows.every(row => row.envelope === null)).toBe(true);
    await models.revoke(f.scope, f.connection.id, 2, true);
    expect(await models.list(f.scope)).toEqual([]);
    await expect(models.get(f.scope, f.connection.id)).rejects.toMatchObject({ code: "MODEL_CONNECTION_NOT_FOUND" });
  });
  it("allows one winner for concurrent revision-bound rotations", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([models.update(f.scope, f.connection.id, { expectedRevision: 1, apiKey: "new-key-a" }),
      models.update(f.scope, f.connection.id, { expectedRevision: 1, apiKey: "new-key-b" })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });
  it("reconnects with a new key without reviving previously revoked use grants", async () => {
    const f = await fixture(), accepted = await binding(f);
    await models.revoke(f.scope, f.connection.id, 1);
    await expect(models.update(f.scope, f.connection.id, { expectedRevision: 2, name: "No key" })).rejects.toMatchObject({ code: "MODEL_CONNECTION_CHANGED" });
    const reconnected = await models.update(f.scope, f.connection.id, { expectedRevision: 2, apiKey: "reconnected-key" });
    expect(reconnected.state).toBe("active"); expect(reconnected.credentialRevision).toBe(2);
    const oldRoute = { ...accepted.route, connectionRevision: reconnected.revision, credentialRevision: reconnected.credentialRevision };
    await expect(transaction(pool, db => models.resolveCredential(db, oldRoute, accepted.consumer))).rejects.toMatchObject({ code: "MODEL_USE_DENIED" });
  });
  it("caches discovered models by tenant, connection revision and credential generation", async () => {
    const f = await fixture(), other = await fixture();
    const requests: ModelDiscoveryRequest[] = [];
    const discover = new ModelProviderStore(pool, vault, builtinProviderRegistry, { discoveryFetch: async request => {
      requests.push(request);
      return { status: 200, body: JSON.stringify({ data: [{ id: "lab/private-model", name: "Private", context_length: 128000,
        top_provider: { max_completion_tokens: 8192 }, supported_parameters: ["tools"], architecture: { input_modalities: ["text"], output_modalities: ["text"] } }] }) };
    } });
    expect((await discover.cachedModels(f.scope, f.connection.id)).result).toBeNull();
    await discover.refreshModels(f.scope, f.connection.id, 1);
    expect(requests).toHaveLength(1); expect(new Headers(requests[0]!.headers).get("authorization")).toBe("Bearer fixture-key-one");
    const cache = await discover.cachedModels(f.scope, f.connection.id);
    expect(cache.result?.models[0]!.id).toBe("lab/private-model"); expect(cache.stale).toBe(false);
    expect((await discover.get(f.scope, f.connection.id)).verification).toBe("discovered");
    await expect(discover.cachedModels(other.scope, f.connection.id)).rejects.toMatchObject({ code: "MODEL_CONNECTION_NOT_FOUND" });
    await models.update(f.scope, f.connection.id, { expectedRevision: 1, apiKey: "new-key" });
    expect((await discover.cachedModels(f.scope, f.connection.id)).result).toBeNull();
  });
  it("rejects discovery receipts from a stale credential and preserves a saved key after discovery failure", async () => {
    const f = await fixture();
    const race = new ModelProviderStore(pool, vault, builtinProviderRegistry, { discoveryFetch: async () => {
      await models.update(f.scope, f.connection.id, { expectedRevision: 1, apiKey: "rotated-during-discovery" });
      return { status: 200, body: JSON.stringify({ data: [{ id: "stale-model" }] }) };
    } });
    await expect(race.refreshModels(f.scope, f.connection.id, 1)).rejects.toMatchObject({ code: "MODEL_CONNECTION_CHANGED" });
    expect((await race.cachedModels(f.scope, f.connection.id)).result).toBeNull();
    const failed = new ModelProviderStore(pool, vault, builtinProviderRegistry, { discoveryFetch: async () => ({ status: 401, body: "private-provider-error" }) });
    await expect(failed.refreshModels(f.scope, f.connection.id, 2)).rejects.toMatchObject({ code: "MODEL_DISCOVERY_AUTHENTICATION_REJECTED" });
    expect((await models.get(f.scope, f.connection.id)).state).toBe("active");
    expect((await models.get(f.scope, f.connection.id)).verification).toBe("saved");
  });
  it("exercises HTTP key creation, listing, rotation and revocation without returning or logging keys", async () => {
    const f = await fixture(), app = Fastify({ logger: false }), logs: unknown[] = [];
    const log = vi.spyOn(console, "info").mockImplementation(value => { logs.push(value); });
    registerModelProviderRoutes(app, { store: models, resolveScope: async () => f.scope });
    const base = `/api/organizations/${f.scope.organizationId}/model-providers`;
    try {
      const catalog = await app.inject({ url: `${base}/catalogue` });
      expect(catalog.json().providers).toHaveLength(12);
      const created = await app.inject({ method: "POST", url: base, payload: { providerId: "openai", name: "HTTP account", apiKey: "http-fixture-secret" } });
      expect(created.statusCode).toBe(200);
      const id = created.json().connection.id;
      const listed = await app.inject({ url: base });
      const rotated = await app.inject({ method: "PATCH", url: `${base}/${id}`, payload: { expectedRevision: 1, apiKey: "http-rotated-secret" } });
      expect(rotated.json().connection.credentialRevision).toBe(2);
      const revoked = await app.inject({ method: "POST", url: `${base}/${id}/revoke`, payload: { expectedRevision: 2 } });
      expect(revoked.json().connection.state).toBe("revoked");
      const evidence = JSON.stringify([created.json(), listed.json(), rotated.json(), revoked.json(), logs]);
      expect(evidence).not.toContain("http-fixture-secret"); expect(evidence).not.toContain("http-rotated-secret");
      expect(logs).toHaveLength(3);
      expect(logs.every(value => JSON.parse(String(value)).provider === "model_provider")).toBe(true);
    } finally { log.mockRestore(); await app.close(); }
  });
});
