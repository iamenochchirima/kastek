import assert from "node:assert/strict";
import test from "node:test";
import type { GrowthChannelAdminRequest, GrowthChannelAdminResponse } from "@kasitek-labs/contracts";
import { readConfig } from "../src/config.js";
import type { CoreContext } from "../src/context.js";
import { ApiError } from "../src/error.js";
import {
  linkAssistantChannel,
  listAssistantChannels,
  telegramChannelViews,
  unlinkAssistantChannel,
  whatsappChannelViews,
  type ChannelAdminClient,
} from "../src/agents/assistant-channels.js";

const actor = { issuer: "https://growth.example.test/identity", subject: "growth-user-1" };
const orgId = "growth-org-1";
const agentId = "9b8c7d6e-5f4a-4b3c-8d2e-1f0a9b8c7d6e";
const connectionId = "5a7a3f5c-9d0b-4f2e-8a6c-1b2c3d4e5f60";

function config() {
  return readConfig({ DATABASE_URL: "postgres://unused", GROWTH_IDENTITY_ISSUER: actor.issuer });
}

function whatsappRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "growth-whatsapp-1",
    displayName: "Growth WhatsApp",
    externalAccountId: "1074164405768729",
    provider: "WHATSAPP",
    sourceType: "WHATSAPP",
    metadata: {
      permissions: ["whatsapp_business_messaging"],
      permissionsInspected: true,
      capabilityChecks: { MESSAGING_INBOUND: true, MESSAGING_OUTBOUND: true },
    },
    ...overrides,
  };
}

async function listed(
  pool: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  admin: ChannelAdminClient,
) {
  return listAssistantChannels({ config: config(), pool } as unknown as CoreContext, actor, orgId, admin);
}

test("Telegram views link only an active deployment of the Growth assistant", () => {
  const connections = [
    { id: connectionId, name: "Growth bot", state: "active", revision: 3, metadata: { botUsername: "growth_bot" } },
    { id: "d4f6a2b1-0c9e-4d8f-8a7b-6c5d4e3f2a1b", name: "Other bot", state: "needs_attention", revision: 2, metadata: {} },
  ];
  const views = telegramChannelViews(
    connections,
    [
      { connectionId, agentId, state: "active" },
      { connectionId: connections[1]!.id, agentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", state: "active" },
    ],
    agentId,
  );
  assert.deepEqual(views[0], {
    provider: "telegram", connectionId, name: "Growth bot", identity: "@growth_bot",
    state: "active", expectedRevision: 3, linked: true, available: true,
  });
  assert.equal(views[1]!.linked, false);
  assert.equal(views[1]!.available, false);
});

test("WhatsApp views require both messaging grants and an unexpired grant", () => {
  const views = whatsappChannelViews(
    [
      whatsappRow(),
      whatsappRow({
        id: "growth-whatsapp-2",
        metadata: { permissionsInspected: true, capabilityChecks: { MESSAGING_INBOUND: true } },
      }),
    ],
    new Set(["growth-whatsapp-1"]),
  );
  assert.equal(views[0]!.state, "linked");
  assert.equal(views[0]!.linked, true);
  assert.equal(views[1]!.state, "permission_missing");
  assert.equal(views[1]!.available, false);
});

test("listing combines Agents Telegram state with Growth WhatsApp grants", async () => {
  const requests: GrowthChannelAdminRequest[] = [];
  const admin: ChannelAdminClient = async (_config, request) => {
    requests.push(request);
    if (request.operation === "assistant.target")
      return { version: "1", requestId: request.requestId, operation: request.operation, targetAgentId: agentId } as GrowthChannelAdminResponse;
    if (request.operation === "channel.list")
      return {
        version: "1", requestId: request.requestId, operation: request.operation,
        connections: [{ id: connectionId, organizationId: agentId, kind: "telegram", name: "Growth bot",
          assetId: "123456", mode: "bot", state: "active", revision: 2, credentialRevision: 1,
          metadata: { botUsername: "growth_bot" }, createdAt: "2026-11-15T10:00:00.000Z", updatedAt: "2026-11-15T10:00:01.000Z" }],
        deployments: [{ id: connectionId, organizationId: agentId, connectionId, agentId, versionId: connectionId,
          state: "active", revision: 1, createdAt: "2026-11-15T10:00:00.000Z", updatedAt: "2026-11-15T10:00:01.000Z" }],
      } as GrowthChannelAdminResponse;
    throw Error(`unexpected ${request.operation}`);
  };
  const pool = {
    async query(sql: string) {
      if (sql.includes('FROM "ExternalConnection"')) return { rows: [whatsappRow()] };
      if (sql.includes('FROM "GrowthAgentChannelGrant"')) return { rows: [{ connectionId: "growth-whatsapp-1" }] };
      return { rows: [] };
    },
    async connect() {
      return { async query() { return { rows: [] }; }, release() {} };
    },
  };
  const result = await listed(pool, admin);
  assert.equal(result.targetAgentId, agentId);
  assert.equal(result.channels.length, 2);
  assert.equal(result.channels.find((channel) => channel.provider === "whatsapp")?.linked, true);
  assert.equal(result.channels.find((channel) => channel.provider === "telegram")?.linked, true);
  assert.deepEqual(requests.map((request) => request.operation), ["assistant.target", "channel.list"]);
});

test("Telegram linking requires the channel revision and targets the Growth assistant", async () => {
  const requests: GrowthChannelAdminRequest[] = [];
  const admin: ChannelAdminClient = async (_config, request) => {
    requests.push(request);
    if (request.operation === "assistant.target")
      return { version: "1", requestId: request.requestId, operation: request.operation, targetAgentId: agentId } as GrowthChannelAdminResponse;
    if (request.operation === "channel.bind")
      return { version: "1", requestId: request.requestId, operation: request.operation,
        deployment: { id: connectionId, organizationId: agentId, connectionId, agentId, versionId: connectionId,
          state: "active", revision: 1, createdAt: "2026-11-15T10:00:00.000Z", updatedAt: "2026-11-15T10:00:01.000Z" } } as GrowthChannelAdminResponse;
    throw Error(`unexpected ${request.operation}`);
  };
  const core = { config: config(), pool: {} } as unknown as CoreContext;
  await assert.rejects(
    linkAssistantChannel(core, { actor, orgId, userId: "growth-user-1", provider: "telegram", connectionId }, admin),
    (error: unknown) => error instanceof ApiError && error.code === "expected_revision_required",
  );
  const result = await linkAssistantChannel(
    core,
    { actor, orgId, userId: "growth-user-1", provider: "telegram", connectionId, expectedRevision: 2 },
    admin,
  );
  assert.equal(result.targetAgentId, agentId);
  const bind = requests.find((request) => request.operation === "channel.bind");
  assert.deepEqual(bind && { connectionId: (bind as { connectionId: string }).connectionId,
    expectedRevision: (bind as { expectedRevision: number }).expectedRevision },
  { connectionId, expectedRevision: 2 });
  assert.equal(bind && "agentId" in bind, false);
});

test("WhatsApp linking requires eligible permissions and records the Growth grant", async () => {
  const requests: GrowthChannelAdminRequest[] = [];
  const admin: ChannelAdminClient = async (_config, request) => {
    requests.push(request);
    if (request.operation === "assistant.target")
      return { version: "1", requestId: request.requestId, operation: request.operation, targetAgentId: agentId } as GrowthChannelAdminResponse;
    if (request.operation === "growth.link")
      return { version: "1", requestId: request.requestId, operation: request.operation,
        connection: { id: connectionId, organizationId: agentId, kind: "whatsapp", name: "Growth WhatsApp",
          assetId: "1074164405768729", mode: "growth_managed", state: "active", revision: 2, credentialRevision: 0,
          metadata: {}, createdAt: "2026-11-15T10:00:00.000Z", updatedAt: "2026-11-15T10:00:01.000Z" },
        deployment: { id: connectionId, organizationId: agentId, connectionId, agentId, versionId: connectionId,
          state: "active", revision: 1, createdAt: "2026-11-15T10:00:00.000Z", updatedAt: "2026-11-15T10:00:01.000Z" } } as GrowthChannelAdminResponse;
    if (request.operation === "growth.unlink")
      return { version: "1", requestId: request.requestId, operation: request.operation, status: "revoked" } as GrowthChannelAdminResponse;
    throw Error(`unexpected ${request.operation}`);
  };
  const denied = {
    async query(sql: string) {
      if (sql.includes('FROM "ExternalConnection"'))
        return { rows: [whatsappRow({ metadata: { permissionsInspected: true, capabilityChecks: { MESSAGING_INBOUND: true } } })] };
      return { rows: [] };
    },
  };
  const core = { config: config(), pool: denied } as unknown as CoreContext;
  await assert.rejects(
    linkAssistantChannel(core, { actor, orgId, userId: "growth-user-1", provider: "whatsapp", connectionId: "growth-whatsapp-1" }, admin),
    (error: unknown) => error instanceof ApiError && error.code === "agent_channel_permission_missing",
  );
  assert.equal(requests.some((request) => request.operation === "growth.link"), false);

  const inserts: Array<{ sql: string; values: unknown[] }> = [];
  const connected = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes('FROM "ExternalConnection"')) return { rows: [whatsappRow()] };
      if (sql.includes('FROM "GrowthAgentChannelGrant"')) return { rows: [] };
      inserts.push({ sql, values: values ?? [] });
      if (sql.includes('INSERT INTO "GrowthAgentChannelGrant"')) return { rows: [] };
      return { rows: [] };
    },
  };
  const success = await linkAssistantChannel(
    { config: config(), pool: connected } as unknown as CoreContext,
    { actor, orgId, userId: "growth-user-1", provider: "whatsapp", connectionId: "growth-whatsapp-1" },
    admin,
  );
  assert.equal(success.targetAgentId, agentId);
  const link = requests.find((request) => request.operation === "growth.link") as Extract<GrowthChannelAdminRequest, { operation: "growth.link" }>;
  assert.equal(link.providerAssetId, "1074164405768729");
  assert.equal("agentId" in link, false);
  assert.equal(link.actor.subject, "growth-user-1");
  const insert = inserts.find((item) => item.sql.includes('INSERT INTO "GrowthAgentChannelGrant"'));
  assert.ok(insert);
  assert.equal(insert!.values[0], link.grantId);
  assert.equal(String(insert!.values[12]).length, 64);
});

test("WhatsApp linking compensates Agents when the Growth grant cannot be recorded", async () => {
  const requests: GrowthChannelAdminRequest[] = [];
  const admin: ChannelAdminClient = async (_config, request) => {
    requests.push(request);
    if (request.operation === "assistant.target")
      return { version: "1", requestId: request.requestId, operation: request.operation, targetAgentId: agentId } as GrowthChannelAdminResponse;
    if (request.operation === "growth.link")
      return { version: "1", requestId: request.requestId, operation: request.operation,
        connection: { id: connectionId, organizationId: agentId, kind: "whatsapp", name: "Growth WhatsApp",
          assetId: "1074164405768729", mode: "growth_managed", state: "active", revision: 2, credentialRevision: 0,
          metadata: {}, createdAt: "2026-11-15T10:00:00.000Z", updatedAt: "2026-11-15T10:00:01.000Z" },
        deployment: { id: connectionId, organizationId: agentId, connectionId, agentId, versionId: connectionId,
          state: "active", revision: 1, createdAt: "2026-11-15T10:00:00.000Z", updatedAt: "2026-11-15T10:00:01.000Z" } } as GrowthChannelAdminResponse;
    if (request.operation === "growth.unlink")
      return { version: "1", requestId: request.requestId, operation: request.operation, status: "revoked" } as GrowthChannelAdminResponse;
    throw Error(`unexpected ${request.operation}`);
  };
  const pool = {
    async query(sql: string) {
      if (sql.includes('FROM "ExternalConnection"')) return { rows: [whatsappRow()] };
      if (sql.includes('FROM "GrowthAgentChannelGrant"')) return { rows: [] };
      if (sql.includes('INSERT INTO "GrowthAgentChannelGrant"')) throw Error("grant insert failed");
      return { rows: [] };
    },
  };
  await assert.rejects(
    linkAssistantChannel(
      { config: config(), pool } as unknown as CoreContext,
      { actor, orgId, userId: "growth-user-1", provider: "whatsapp", connectionId: "growth-whatsapp-1" },
      admin,
    ),
    /grant insert failed/,
  );
  assert.equal(requests.some((request) => request.operation === "growth.unlink"), true);
});

test("unlinking revokes the Agents deployment or the recorded WhatsApp grant", async () => {
  const requests: GrowthChannelAdminRequest[] = [];
  const admin: ChannelAdminClient = async (_config, request) => {
    requests.push(request);
    if (request.operation === "assistant.target")
      return { version: "1", requestId: request.requestId, operation: request.operation, targetAgentId: agentId } as GrowthChannelAdminResponse;
    if (request.operation === "channel.unbind")
      return { version: "1", requestId: request.requestId, operation: request.operation, status: "revoked" } as GrowthChannelAdminResponse;
    if (request.operation === "growth.unlink")
      return { version: "1", requestId: request.requestId, operation: request.operation, status: "revoked" } as GrowthChannelAdminResponse;
    throw Error(`unexpected ${request.operation}`);
  };
  const updates: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes('FROM "GrowthAgentChannelGrant"'))
        return { rows: [{ id: "grant-1", agentsConnectionId: connectionId }] };
      updates.push({ sql, values: values ?? [] });
      return { rows: [] };
    },
  };
  const core = { config: config(), pool } as unknown as CoreContext;
  assert.deepEqual(
    await unlinkAssistantChannel(core, { actor, orgId, provider: "telegram", connectionId }, admin),
    { status: "revoked" },
  );
  assert.equal(requests.at(-1)?.operation, "channel.unbind");
  assert.deepEqual(
    await unlinkAssistantChannel(core, { actor, orgId, provider: "whatsapp", connectionId: "growth-whatsapp-1" }, admin),
    { status: "revoked" },
  );
  assert.equal(requests.at(-1)?.operation, "growth.unlink");
  assert.match(updates.at(-1)!.sql, /UPDATE "GrowthAgentChannelGrant"/);
  assert.deepEqual(updates.at(-1)!.values, ["grant-1"]);
});
