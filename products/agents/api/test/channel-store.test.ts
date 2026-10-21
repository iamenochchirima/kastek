import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { ChannelStore } from "../src/product/channels/channel-store";
import { ConnectionVault } from "../src/infrastructure/vault";
import { builtinChannelCatalogue, parseChannelCatalogue } from "../src/adapters/channels/catalogue";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("tenant channel connection foundation", () => {
  const database = `agents_channel_store_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, platform: PlatformStore, channels: ChannelStore;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href });
    await setupPlatformSchema(pool); platform = new PlatformStore(pool);
    channels = new ChannelStore(pool, new ConnectionVault("test", { test: randomBytes(32).toString("base64") }));
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  async function workspace() {
    const account = await platform.ensureAccount({ issuer: "https://channel.fixture.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const organization = await platform.createOrganization(account.id, "Channels");
    const scope = { accountId: account.id, organizationId: organization.id };
    const agent = await platform.createConfiguredAgent({ ...scope, name: "Support", offering: "faq" });
    return { scope, agent };
  }
  it("enforces tenant/asset ownership, encrypted revisioned credentials and explicit customer bindings", async () => {
    const a = await workspace(), b = await workspace();
    expect(builtinChannelCatalogue.map(item => item.kind).sort()).toEqual(["facebook", "instagram", "telegram", "website", "whatsapp"]);
    expect(() => parseChannelCatalogue([{ ...builtinChannelCatalogue[0], handler: "tenant-script" }])).toThrow();
    const connection = await channels.create(a.scope, { kind: "telegram", name: "Help bot", mode: "bot", assetId: "bot:123", state: "active", credentials: { botToken: "fixture-bot-token", webhookSecret: "fixture-webhook-secret" }, metadata: { username: "help_fixture_bot" } });
    expect(JSON.stringify(connection)).not.toContain("fixture-bot-token");
    const secretRow = (await pool.query("SELECT envelope FROM agents_platform.channel_credentials WHERE connection_id=$1", [connection.id])).rows[0];
    expect(JSON.stringify(secretRow)).not.toContain("fixture-bot-token");
    await expect(channels.get(b.scope, connection.id)).rejects.toMatchObject({ code: "CHANNEL_CONNECTION_NOT_FOUND" });
    await expect(channels.create(b.scope, { kind: "telegram", mode: "bot", name: "Other", assetId: "bot:123", state: "active", credentials: { botToken: "other-key" } })).rejects.toMatchObject({ code: "CHANNEL_ASSET_CONFLICT" });
    await expect(channels.bind(a.scope, connection.id, { expectedRevision: 1, agentId: b.agent.agent.id })).rejects.toMatchObject({ code: "CHANNEL_AGENT_UNAVAILABLE" });
    const binding = await channels.bind(a.scope, connection.id, { expectedRevision: 1, agentId: a.agent.agent.id });
    expect((await channels.resolveDeployment("telegram", "bot:123"))?.deployment.id).toBe(binding.id);
    const another = await platform.createConfiguredAgent({ ...a.scope, name: "Other support", offering: "customer-service" });
    await expect(channels.bind(a.scope, connection.id, { expectedRevision: 1, agentId: another.agent.id })).rejects.toMatchObject({ code: "CHANNEL_REASSIGNMENT_REQUIRED" });
    const rotated = await channels.update(a.scope, connection.id, { expectedRevision: 1, credentials: { botToken: "fixture-rotated-token", webhookSecret: "fixture-new-secret" } });
    await expect(channels.resolveCredential({ organizationId: a.scope.organizationId, connectionId: connection.id, expectedRevision: 1, credentialRevision: 1 })).rejects.toMatchObject({ code: "CHANNEL_AUTHORITY_CHANGED" });
    expect((await channels.resolveCredential({ organizationId: a.scope.organizationId, connectionId: connection.id, expectedRevision: 2, credentialRevision: 2 })).botToken).toBe("fixture-rotated-token");
    await expect(channels.update(a.scope, connection.id, { expectedRevision: 1, name: "Stale" })).rejects.toMatchObject({ code: "CHANNEL_CONNECTION_CHANGED" });
    const disconnected = await channels.disconnect(a.scope, connection.id, rotated.revision);
    expect(await channels.resolveDeployment("telegram", "bot:123")).toBeNull();
    await expect(channels.resolveCredential({ organizationId: a.scope.organizationId, connectionId: connection.id })).rejects.toMatchObject({ code: "CHANNEL_AUTHORITY_CHANGED" });
    const reconnect = await channels.update(a.scope, connection.id, { expectedRevision: disconnected.revision, state: "active", credentials: { botToken: "fixture-reconnected" } });
    expect(await channels.resolveDeployment("telegram", "bot:123")).toBeNull();
    const rebound = await channels.bind(a.scope, connection.id, { expectedRevision: reconnect.revision, agentId: a.agent.agent.id }); expect(rebound.id).not.toBe(binding.id);
    await channels.recordAssets(a.scope, connection.id, reconnect.revision, [{ providerAssetId: "bot:456", name: "Second", eligible: true }]);
    const first = await channels.listAssets(a.scope, connection.id, { limit: 1 }); expect(first.assets).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
    expect((await channels.listAssets(a.scope, connection.id, { limit: 1, cursor: first.nextCursor! })).assets).toHaveLength(1);
    await expect(channels.update(a.scope, connection.id, { expectedRevision: reconnect.revision, metadata: { accessToken: "forbidden" } })).rejects.toThrow();
    const pending = await channels.create(a.scope, { kind: "instagram", mode: "meta", name: "Discover", credentials: { accessToken: "fixture-private-discovery" } });
    expect((await channels.resolveSetupCredential(a.scope, pending.id, pending.revision)).accessToken).toBe("fixture-private-discovery");
    await expect(channels.resolveCredential({ organizationId: a.scope.organizationId, connectionId: pending.id })).rejects.toMatchObject({ code: "CHANNEL_AUTHORITY_CHANGED" });
    await pool.query("UPDATE agents_platform.memberships SET role='member' WHERE organization_id=$1 AND account_id=$2", [a.scope.organizationId, a.scope.accountId]);
    expect((await channels.list(a.scope)).length).toBeGreaterThan(0);
    await expect(channels.resolveSetupCredential(a.scope, pending.id, pending.revision)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(channels.disconnect(a.scope, connection.id, reconnect.revision)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
});
