import {dropClosedTestDatabase} from "./support/database-cleanup";
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
import { resolveAcceptedModelRoutes } from "../src/execution/models/resolution";
import type { ExecutionPolicyLayer } from "../src/execution/models/policy";

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
    await pool?.end(); if (admin) { await dropClosedTestDatabase(admin,database); await admin.end(); }
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
  it("lists only models granted to the selected agent or current organization default for ordinary members", async () => {
    const f = await fixture(), memberAccount = await fixture(), foreign = await fixture();
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')", [f.scope.organizationId, memberAccount.scope.accountId]);
    const member = { accountId: memberAccount.scope.accountId, organizationId: f.scope.organizationId };
    const agent = await platform.createAgent({ ...f.scope, name: "Allowed" });
    const different = await platform.createAgent({ ...f.scope, name: "Different" });
    for (const modelId of ["private/allowed", "private/other", "default-model"]) {
      await models.addManualModel(f.scope, f.connection.id, { expectedRevision: 1, modelId });
    }
    await models.grant(f.scope, { connectionId: f.connection.id, consumer: { kind: "agent", agentId: agent.id },
      roles: ["primary", "compaction", "delegated"], modelIds: ["private/allowed"] });
    await models.grant(f.scope, { connectionId: f.connection.id, consumer: { kind: "agent", agentId: different.id },
      roles: ["primary", "compaction", "delegated"], modelIds: ["private/other"] });
    await models.setDefault(f.scope, { connectionId: f.connection.id, modelId: "default-model", expectedRevision: 0 });
    expect((await models.cachedModels(member, f.connection.id, agent.id)).result?.models.map(model => model.id)).toEqual(["private/allowed", "default-model"]);
    expect((await models.cachedModels(member, f.connection.id)).result?.models.map(model => model.id)).toEqual(["default-model"]);
    const foreignAgent = await platform.createAgent({ ...foreign.scope, name: "Foreign" });
    await expect(models.cachedModels(member, f.connection.id, foreignAgent.id)).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2", [f.scope.organizationId, member.accountId]);
    await expect(models.cachedModels(member, f.connection.id, agent.id)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it("honors an operator-disabled provider profile before resolving an accepted credential", async () => {
    const f = await fixture(), accepted = await binding(f);
    const disabled = new ModelProviderStore(pool, vault, builtinProviderRegistry.map(profile => profile.id === f.connection.providerId
      ? { ...profile, adapter: { ...profile.adapter, readiness: "planned" as const } } : profile));
    await expect(transaction(pool, db => disabled.resolveCredential(db, accepted.route, accepted.consumer)))
      .rejects.toMatchObject({ code: "MODEL_ADAPTER_NOT_INSTALLED" });
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
  it("keeps default changes tenant-scoped, explicit and revision-bound without revoking admitted grants", async () => {
    const f = await fixture(), other = await fixture();
    expect(await models.getDefault(f.scope)).toEqual({ selection: null, revision: 0 });
    await expect(models.setDefault(other.scope, { connectionId: f.connection.id, modelId: "lab/one", expectedRevision: 0 }))
      .rejects.toMatchObject({ code: "MODEL_CONNECTION_NOT_FOUND" });
    const first = await models.setDefault(f.scope, { connectionId: f.connection.id, modelId: "lab/one", expectedRevision: null });
    expect(first.revision).toBe(1);
    const results = await Promise.allSettled(["lab/two", "lab/three"].map(modelId =>
      models.setDefault(f.scope, { connectionId: f.connection.id, modelId, expectedRevision: 1 })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await models.getDefault(f.scope)).revision).toBe(2);
    const grants = (await pool.query("SELECT state,consumer FROM agents_platform.model_provider_use_grants WHERE organization_id=$1", [f.scope.organizationId])).rows;
    expect(grants).toHaveLength(2);
    expect(grants.every(row => row.state === "active" && row.consumer.serviceId === "organization-default")).toBe(true);
    await models.revoke(f.scope, f.connection.id, 1);
    await expect(models.setDefault(f.scope, { connectionId: f.connection.id, modelId: "lab/new", expectedRevision: 2 })).rejects.toMatchObject({ code: "MODEL_CONNECTION_CHANGED" });
    expect((await models.getDefault(f.scope)).selection?.connectionId).toBe(f.connection.id);
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
  it("accepts owner-reviewed private model metadata without inventing limits, tools or account access", async () => {
    const f = await fixture(), other = await fixture();
    const unknown = await models.addManualModel(f.scope, f.connection.id, { expectedRevision: 1, modelId: "private/deployment" });
    expect(unknown.model.contextTokens.value).toBeNull(); expect(unknown.model.capabilities.tools.value).toBeNull();
    expect(unknown.model.inputModalities).toEqual([]); expect(unknown.model.pricing).toBeNull();
    await expect(models.addManualModel(f.scope, f.connection.id, { expectedRevision: 1, modelId: "private/deployment",
      metadata: { reference: "Reviewed deployment settings", contextTokens: 16000 } })).rejects.toThrow();
    const declared = await models.addManualModel(f.scope, f.connection.id, { expectedRevision: 1, modelId: "private/deployment", confirmMetadata: true,
      metadata: { reference: "Reviewed deployment settings", contextTokens: 16000, maxOutputTokens: 2048,
        tools: false, inputModalities: ["text"], outputModalities: ["text"] } });
    expect(declared.model.contextTokens).toMatchObject({ value: 16000, source: { kind: "operator" } });
    expect(declared.model.capabilities.tools).toMatchObject({ value: false, evidence: "declared", source: { kind: "operator" } });
    expect(declared.model.setupSource?.reference).toContain(f.scope.accountId);
    expect((await models.get(f.scope, f.connection.id)).verification).toBe("saved");
    expect((await models.cachedModels(f.scope, f.connection.id)).result?.models[0]?.revision).toBe(declared.model.revision);
    await expect(models.addManualModel(other.scope, f.connection.id, { expectedRevision: 1, modelId: "foreign" }))
      .rejects.toMatchObject({ code: "MODEL_CONNECTION_NOT_FOUND" });
    await models.update(f.scope, f.connection.id, { expectedRevision: 1, apiKey: "rotated" });
    expect((await models.cachedModels(f.scope, f.connection.id)).result).toBeNull();
  });
  it("preserves manual and unavailable saved IDs across refresh without choosing a replacement", async () => {
    const f = await fixture(); let ids = ["old-alias"];
    const discover = new ModelProviderStore(pool, vault, builtinProviderRegistry, { discoveryFetch: async () => ({ status: 200,
      body: JSON.stringify({ data: ids.map(id => ({ id, context_length: 16000 })) }) }) });
    await discover.refreshModels(f.scope, f.connection.id, 1);
    await models.setDefault(f.scope, { connectionId: f.connection.id, modelId: "old-alias", expectedRevision: 0 });
    await models.addManualModel(f.scope, f.connection.id, { expectedRevision: 1, modelId: "private/deployment" });
    await pool.query("UPDATE agents_platform.model_provider_catalogue_controls SET retry_at=NULL WHERE connection_id=$1", [f.connection.id]);
    ids = ["new-alias"];
    const result = await discover.refreshModels(f.scope, f.connection.id, 1);
    expect(result.models.map(model => model.id)).toEqual(["new-alias", "old-alias", "private/deployment"]);
    expect(result.kind === "discovered" && result.unavailableModelIds).toEqual(["old-alias"]);
    expect((await models.getDefault(f.scope)).selection?.modelId).toBe("old-alias");
    expect(result.models.find(model => model.id === "private/deployment")?.contextTokens.value).toBeNull();
  });
  it("keeps provider retirement authoritative over manual metadata", async () => {
    const f = await fixture();
    const discover = new ModelProviderStore(pool, vault, builtinProviderRegistry, { discoveryFetch: async () => ({ status: 200,
      body: JSON.stringify({ data: [{ id: "retired-model", lifecycle: "retired", context_length: 16000 }] }) }) });
    await discover.refreshModels(f.scope, f.connection.id, 1);
    const manual = await discover.addManualModel(f.scope, f.connection.id, { expectedRevision: 1, modelId: "retired-model", confirmMetadata: true,
      metadata: { reference: "Owner settings", contextTokens: 32000 } });
    expect(manual.model.lifecycle).toBe("retired");
    await pool.query("UPDATE agents_platform.model_provider_catalogue_controls SET retry_at=NULL WHERE connection_id=$1", [f.connection.id]);
    const refreshed = await discover.refreshModels(f.scope, f.connection.id, 1);
    expect(refreshed.models[0]?.lifecycle).toBe("retired");
  });
  it("adds a manual deployment through the authenticated HTTP route", async () => {
    const f = await fixture(), app = Fastify({ logger: false });
    registerModelProviderRoutes(app, { store: models, resolveScope: async () => f.scope });
    try {
      const response = await app.inject({ method: "POST",
        url: `/api/organizations/${f.scope.organizationId}/model-providers/${f.connection.id}/models/manual`,
        payload: { expectedRevision: 1, modelId: "private-http-deployment" } });
      expect(response.statusCode).toBe(200); expect(response.json().model.contextTokens.value).toBeNull();
      expect(response.json().model.id).toBe("private-http-deployment");
      expect(JSON.stringify(response.json())).not.toContain("fixture-key");
    } finally { await app.close(); }
  });
  it("serializes refreshes and backs off failures while retaining readable stale metadata", async () => {
    const f = await fixture(); let calls = 0, fail = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const discover = new ModelProviderStore(pool, vault, builtinProviderRegistry, { discoveryFetch: async () => {
      calls++; await gate;
      return fail ? { status: 429, body: "provider-private-error" } : { status: 200, body: JSON.stringify({ data: [{ id: "saved" }] }) };
    } });
    const pending = discover.refreshModels(f.scope, f.connection.id, 1);
    await vi.waitFor(async () => expect((await discover.cachedModels(f.scope, f.connection.id)).status).toBe("refreshing"));
    await expect(discover.refreshModels(f.scope, f.connection.id, 1)).rejects.toMatchObject({ code: "MODEL_DISCOVERY_BACKOFF" });
    release!(); await pending; expect(calls).toBe(1);
    await pool.query("UPDATE agents_platform.model_provider_catalogue_controls SET retry_at=NULL WHERE connection_id=$1", [f.connection.id]);
    await pool.query("UPDATE agents_platform.model_provider_catalogues SET fetched_at=now()-interval '1 hour' WHERE connection_id=$1", [f.connection.id]);
    fail = true;
    await expect(discover.refreshModels(f.scope, f.connection.id, 1)).rejects.toMatchObject({ code: "MODEL_DISCOVERY_RATE_LIMITED" });
    const cached = await discover.cachedModels(f.scope, f.connection.id);
    expect(cached).toMatchObject({ stale: true, status: "backoff", errorCode: "MODEL_DISCOVERY_RATE_LIMITED" });
    expect(cached.result?.models[0]?.id).toBe("saved"); expect(cached.retryAt).not.toBeNull();
    await expect(discover.refreshModels(f.scope, f.connection.id, 1)).rejects.toMatchObject({ code: "MODEL_DISCOVERY_BACKOFF" });
    expect(calls).toBe(2); expect(JSON.stringify(cached)).not.toContain("provider-private-error");
  });
  it("resolves pinned role bindings without secrets or network and honors later revocation", async () => {
    const f = await fixture(), agent = await platform.createAgent({ ...f.scope, name: "Pinned" });
    const discover = new ModelProviderStore(pool, vault, builtinProviderRegistry, { discoveryFetch: async () => ({ status: 200,
      body: JSON.stringify({ data: [{ id: "lab/pinned", context_length: 32000, top_provider: { max_completion_tokens: 4096 },
        supported_parameters: ["tools"], architecture: { input_modalities: ["text"], output_modalities: ["text"] } }] }) }) });
    await discover.refreshModels(f.scope, f.connection.id, 1);
    await models.setDefault(f.scope, { connectionId: f.connection.id, modelId: "lab/pinned", expectedRevision: 0 });
    const layers: ExecutionPolicyLayer[] = [{ kind: "platform", reference: "fixture-policy", limits: {
      contextTokens: 32000, maxInputTokens: 20000, maxOutputTokens: 4096, safetyTokens: 1000, compactAtTokens: 16000,
      maxModelCalls: 8, maxToolCalls: 8, maxCallDurationMs: 120000, maxDurationMs: 120000, maxInputBytes: 16384, maxRequestBytes: 2097152, maxMessages: 256, maxTools: 64, maxResponseBytes: 1048576,
      maxRootTokens: 50000, maxCostMicros: null } }];
    const input = { organizationId: f.scope.organizationId, agentId: agent.id, product: "agents" as const,
      selection: { kind: "organization_default" as const }, layers, requiresTools: true };
    const accepted = await transaction(pool, db => resolveAcceptedModelRoutes(db, input));
    expect(accepted.primary.binding.modelId).toBe("lab/pinned");
    expect(accepted.compaction.binding.role).toBe("compaction"); expect(accepted.delegated.binding.role).toBe("delegated");
    expect(JSON.stringify(accepted)).not.toContain("fixture-key");
    await models.setDefault(f.scope, { connectionId: f.connection.id, modelId: "lab/new", expectedRevision: 1 });
    expect(await transaction(pool, db => models.resolveCredential(db, accepted.primary.binding, accepted.primary.consumer))).toBe("fixture-key-one");
    await expect(transaction(pool, db => resolveAcceptedModelRoutes(db, input))).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    await expect(transaction(pool, db => resolveAcceptedModelRoutes(db, { ...input, product: "growth" }))).rejects.toMatchObject({ code: "MODEL_DEFAULT_REQUIRED" });
    await models.revoke(f.scope, f.connection.id, 1);
    await expect(transaction(pool, db => models.resolveCredential(db, accepted.primary.binding, accepted.primary.consumer))).rejects.toMatchObject({ code: "MODEL_CONNECTION_CHANGED" });
  });
  it("requires explicit paid tests and binds receipts to exact model and key generation", async () => {
    const f = await fixture(); let calls = 0;
    const testStore = new ModelProviderStore(pool, vault, builtinProviderRegistry, {
      discoveryFetch: async () => ({ status: 200, body: JSON.stringify({ data: [{ id: "lab/probe", context_length: 32000,
        top_provider: { max_completion_tokens: 4096 }, architecture: { input_modalities: ["text"], output_modalities: ["text"] } }] }) }),
      probe: async input => { calls++; await input.reauthorize(); return { modelId: input.model.id,
        verification: input.verifyTools ? "tools_verified" : "inference_verified", usage: { observed: false } }; },
    });
    await testStore.refreshModels(f.scope, f.connection.id, 1);
    const input = { expectedRevision: 1, modelId: "lab/probe", allowBillableRequest: true, verifyTools: true };
    expect(await testStore.cachedModels(f.scope, f.connection.id)).toMatchObject({ modelVerifications: {}, toolSupport: { "lab/probe": "needs_verification" } });
    await expect(testStore.probe(f.scope, f.connection.id, { ...input, allowBillableRequest: false })).rejects.toThrow();
    expect(calls).toBe(0);
    expect(await testStore.probe(f.scope, f.connection.id, input)).toEqual({ modelId: "lab/probe", verification: "tools_verified", usage: { observed: false } });
    const receipt = (await pool.query("SELECT * FROM agents_platform.model_provider_verifications WHERE organization_id=$1", [f.scope.organizationId])).rows[0];
    expect(receipt.model_id).toBe("lab/probe"); expect(receipt.credential_revision).toBe(1); expect(receipt.endpoint).toBe(f.connection.endpoint);
    expect(JSON.stringify(receipt)).not.toContain("fixture-key");
    expect(await testStore.cachedModels(f.scope, f.connection.id)).toMatchObject({ modelVerifications: { "lab/probe": "tools_verified" }, toolSupport: { "lab/probe": "supported" } });
    await testStore.addManualModel(f.scope, f.connection.id, { expectedRevision: 1, modelId: "lab/probe", confirmMetadata: true,
      metadata: { reference: "Updated controlled capacity", contextTokens: 64000, maxOutputTokens: 8192, tools: true, inputModalities: ["text"], outputModalities: ["text"] } });
    expect(await testStore.cachedModels(f.scope, f.connection.id)).toMatchObject({ modelVerifications: {}, toolSupport: { "lab/probe": "needs_verification" } });
    const race = new ModelProviderStore(pool, vault, builtinProviderRegistry, { probe: async request => {
      await models.update(f.scope, f.connection.id, { expectedRevision: 1, apiKey: "rotated-in-flight" });
      return { modelId: request.model.id, verification: "tools_verified", usage: { observed: false } };
    } });
    await expect(race.probe(f.scope, f.connection.id, input)).rejects.toMatchObject({ code: "MODEL_CONNECTION_CHANGED" });
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.model_provider_verifications WHERE organization_id=$1", [f.scope.organizationId])).rows[0].count).toBe(1);
    expect(await testStore.cachedModels(f.scope, f.connection.id)).toMatchObject({ modelVerifications: {}, toolSupport: {} });
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
