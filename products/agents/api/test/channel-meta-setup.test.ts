import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { ChannelStore } from "../src/product/channels/channel-store";
import { MetaChannelSetup, MetaSetupProvider, MetaSetupSessions, type MetaSetupProfile } from "../src/product/channels/meta-setup";
import { ConnectionVault } from "../src/infrastructure/vault";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
const session = "fixture-session-owner-only", otherSession = "fixture-session-other-device";
const profile = (kind: "facebook" | "instagram" | "whatsapp", mode: "meta" | "instagram_login" | "cloud_api"): MetaSetupProfile => ({
  kind, mode, appId: "app-123", appSecret: "private-app-fixture", webhookVerifyToken: "private-webhook-fixture", apiVersion: "v99.0",
  redirectUri: "https://agents.fixture.test/api/channels/meta/callback", scopes: ["fixture_messaging"], subscribedFields: ["messages", "message_reads"],
  discoveryPageLimit: 4, ...(kind === "whatsapp" ? { embeddedConfigurationId: "embedded-123" } : {}),
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
(databaseUrl ? describe : describe.skip)("Meta setup durable native onboarding", () => {
  const database = `agents_meta_setup_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, platform: PlatformStore, channels: ChannelStore, sessions: MetaSetupSessions;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href });
    await setupPlatformSchema(pool); platform = new PlatformStore(pool);
    const vault = new ConnectionVault("test", { test: randomBytes(32).toString("base64") });
    channels = new ChannelStore(pool, vault); sessions = new MetaSetupSessions(pool, vault, 600);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  async function workspace(kind: "facebook" | "instagram" | "whatsapp" = "facebook", mode: "meta" | "instagram_login" | "cloud_api" = "meta") {
    const account = await platform.ensureAccount({ issuer: "https://meta.fixture.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await platform.createOrganization(account.id, "Meta channels"), scope = { accountId: account.id, organizationId: org.id };
    const connection = await channels.create(scope, { kind, mode, name: "Setup" });
    return { scope, connection };
  }
  function transport(extra: (url: URL, init?: RequestInit) => Response | undefined = () => undefined) {
    return vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input)), response = extra(url, init); if (response) return response;
      if (url.pathname.endsWith("/oauth/access_token")) return json({ access_token: "private-user-fixture", expires_in: 3600 });
      if (url.pathname.endsWith("/debug_token")) return json({ data: { is_valid: true, app_id: "app-123", scopes: ["fixture_messaging"] } });
      if (url.pathname.endsWith("/subscribed_apps")) return json({ success: true });
      throw new Error(`Unexpected fixture path ${url.pathname}`);
    });
  }
  it("binds one-use OAuth state to owner session, survives new service instances and encrypts every token", async () => {
    const { scope, connection } = await workspace(), second = await workspace();
    const http = transport(url => url.pathname.endsWith("/me/accounts") ? json({ data: [{ id: "page-select-a", name: "Page A", access_token: "private-page-fixture", tasks: ["MESSAGING"] }] }) : undefined);
    const setup = new MetaChannelSetup(channels, sessions, [profile("facebook", "meta")], http);
    const begin = await setup.begin(scope, session, { connectionId: connection.id, expectedRevision: 1 });
    expect(begin.flow).toBe("oauth"); if (begin.flow !== "oauth") throw new Error("Expected OAuth");
    const authorize = new URL(begin.authorizationUrl); expect(authorize.origin).toBe("https://www.facebook.com"); expect(authorize.searchParams.get("state")).toBe(begin.state);
    await expect(setup.complete(scope, otherSession, { state: begin.state, code: "private-code" })).rejects.toMatchObject({ code: "CHANNEL_SETUP_EXPIRED_OR_CHANGED" });
    await expect(setup.complete(second.scope, session, { state: begin.state, code: "private-code" })).rejects.toMatchObject({ code: "CHANNEL_SETUP_EXPIRED_OR_CHANGED" });
    expect(http).not.toHaveBeenCalled();
    const restored = new MetaChannelSetup(channels, sessions, [profile("facebook", "meta")], http);
    const completed = await restored.complete(scope, session, { state: begin.state, code: "private-code" });
    await expect(restored.complete(scope, session, { state: begin.state, code: "private-code" })).rejects.toMatchObject({ code: "CHANNEL_SETUP_EXPIRED_OR_CHANGED" });
    const discovery = await restored.discover(scope, session, { ticket: completed.ticket }); expect(discovery.assets[0]?.id).toBe("page-select-a");
    expect(JSON.stringify(discovery)).not.toContain("private-");
    expect((await channels.get(scope, connection.id)).state).toBe("pending");
    expect((await channels.listAssets(scope, connection.id)).assets).toHaveLength(0);
    const stored = (await pool.query("SELECT envelope FROM agents_platform.channel_setup_sessions WHERE connection_id=$1", [connection.id])).rows;
    expect(JSON.stringify(stored)).not.toContain("private-user-fixture"); expect(JSON.stringify(stored)).not.toContain(begin.state);
    const selected = await restored.select(scope, session, { ticket: completed.ticket, assetId: "page-select-a" });
    expect(selected).toMatchObject({ state: "active", assetId: "page-select-a", revision: 2, credentialRevision: 1 });
    expect((await channels.resolveSetupCredential(scope, connection.id, 2)).accessToken).toBe("private-page-fixture");
    expect(JSON.stringify(selected)).not.toContain("private-");
    await expect(restored.select(scope, session, { ticket: completed.ticket, assetId: "page-select-a" })).rejects.toMatchObject({ code: "CHANNEL_SETUP_EXPIRED_OR_CHANGED" });
  });
  it("paginates Page discovery safely and explicitly selects a linked Instagram identity from a later page", async () => {
    const { scope, connection } = await workspace("instagram", "meta");
    const http = transport(url => url.pathname.endsWith("/me/accounts") ? url.searchParams.has("after")
      ? json({ data: [{ id: "linked-page-b", name: "Page B", tasks: ["MANAGE"], access_token: "private-linked-fixture", instagram_business_account: { id: "ig-linked-b", username: "business" } }] })
      : json({ data: [{ id: "unlinked-page", name: "No Instagram", tasks: ["MESSAGING"], access_token: "private-other" }], paging: { next: "https://evil.fixture.test?access_token=never-follow", cursors: { after: "page-two" } } }) : undefined);
    const setup = new MetaChannelSetup(channels, sessions, [profile("instagram", "meta")], http);
    const start = await setup.begin(scope, session, { connectionId: connection.id, expectedRevision: 1 });
    const complete = await setup.complete(scope, session, { state: start.state, code: "code" });
    const first = await setup.discover(scope, session, { ticket: complete.ticket }); expect(first).toMatchObject({ nextCursor: "page-two", assets: [{ eligible: false, reasonCode: "instagram_account_not_linked" }] });
    const selected = await setup.select(scope, session, { ticket: complete.ticket, assetId: "ig-linked-b" });
    expect(selected).toMatchObject({ assetId: "ig-linked-b", metadata: { pageId: "linked-page-b" } });
    expect(http.mock.calls.every(([url]) => new URL(String(url)).hostname === "graph.facebook.com")).toBe(true);
    const subscribed = http.mock.calls.find(([url]) => String(url).endsWith("/linked-page-b/subscribed_apps")); expect(subscribed).toBeTruthy();
  });
  it("separates Instagram Login exchange, professional identity and subscription from Page token mode", async () => {
    const { scope, connection } = await workspace("instagram", "instagram_login");
    const http = transport((url, init) => {
      if (url.hostname === "api.instagram.com") { expect(init?.method).toBe("POST"); return json({ access_token: "private-direct-short", permissions: ["fixture_messaging"] }); }
      if (url.pathname === "/access_token") return json({ access_token: "private-direct-long", expires_in: 5000 });
      if (url.pathname.endsWith("/me")) return json({ id: "ig-app-scoped", user_id: "ig-direct-native", username: "direct", account_type: "BUSINESS" });
      return undefined;
    });
    const setup = new MetaChannelSetup(channels, sessions, [profile("instagram", "instagram_login")], http);
    const begin = await setup.begin(scope, session, { connectionId: connection.id, expectedRevision: 1 });
    expect(begin.flow === "oauth" && new URL(begin.authorizationUrl).hostname).toBe("www.instagram.com");
    const complete = await setup.complete(scope, session, { state: begin.state, code: "direct-code" });
    const selected = await setup.select(scope, session, { ticket: complete.ticket, assetId: "ig-direct-native" });
    expect(selected.assetId).toBe("ig-direct-native");
    const credentials = await channels.resolveSetupCredential(scope, connection.id, selected.revision); expect(credentials.accessToken).toBe("private-direct-long");
    expect(http.mock.calls.some(([url]) => String(url).includes("graph.facebook.com"))).toBe(false);
  });
  it("completes embedded signup using revalidated WABA/phone and explicit registration, never a browser phone hint", async () => {
    const { scope, connection } = await workspace("whatsapp", "cloud_api");
    const http = transport(url => {
      if (url.pathname.endsWith("/waba-native")) return json({ id: "waba-native" });
      if (url.pathname.endsWith("/phone_numbers")) return json({ data: [{ id: "phone-native", display_phone_number: "+000000", code_verification_status: "VERIFIED", platform_type: "NOT_REGISTERED" }] });
      if (url.pathname.endsWith("/register")) return json({ success: true });
      return undefined;
    });
    const setup = new MetaChannelSetup(channels, sessions, [profile("whatsapp", "cloud_api")], http);
    const begin = await setup.begin(scope, session, { connectionId: connection.id, expectedRevision: 1 });
    expect(begin).toMatchObject({ flow: "embedded_signup", configurationId: "embedded-123", messageOrigins: ["https://www.facebook.com", "https://web.facebook.com"] });
    expect(JSON.stringify(begin)).not.toContain("private-");
    const complete = await setup.complete(scope, session, { state: begin.state, code: "embedded-code", wabaId: "waba-native" });
    const assets = await setup.discover(scope, session, { ticket: complete.ticket }); expect(assets.assets[0]).toMatchObject({ id: "phone-native", metadata: { registrationRequired: true } });
    await setup.select(scope, session, { ticket: complete.ticket, assetId: "phone-native", registrationPin: "123456" });
    const registers = http.mock.calls.filter(([url]) => String(url).endsWith("/phone-native/register")); expect(registers).toHaveLength(1);
    expect(String(registers[0]?.[1]?.body)).toContain("pin=123456");
    expect(http.mock.calls.some(([url]) => String(url).endsWith("/waba-native/subscribed_apps"))).toBe(true);
  });
  it("rejects expired state, owner removal, missing scopes and provider app mismatch before activation", async () => {
    const { scope, connection } = await workspace(), http = transport(), setup = new MetaChannelSetup(channels, sessions, [profile("facebook", "meta")], http);
    const expired = await setup.begin(scope, session, { connectionId: connection.id, expectedRevision: 1 });
    await pool.query("UPDATE agents_platform.channel_setup_sessions SET expires_at=now()-interval '1 second' WHERE connection_id=$1", [connection.id]);
    await expect(setup.complete(scope, session, { state: expired.state, code: "code" })).rejects.toMatchObject({ code: "CHANNEL_SETUP_EXPIRED_OR_CHANGED" });
    const removed = await setup.begin(scope, session, { connectionId: connection.id, expectedRevision: 1 });
    await pool.query("UPDATE agents_platform.memberships SET role='member' WHERE organization_id=$1", [scope.organizationId]);
    await expect(setup.complete(scope, session, { state: removed.state, code: "code" })).rejects.toMatchObject({ code: "CHANNEL_SETUP_EXPIRED_OR_CHANGED" });
    expect(http).not.toHaveBeenCalled();
    for (const data of [{ is_valid: true, app_id: "wrong-app", scopes: ["fixture_messaging"] }, { is_valid: true, app_id: "app-123", scopes: [] }]) {
      const provider = new MetaSetupProvider(profile("facebook", "meta"), transport(url => url.pathname.endsWith("/debug_token") ? json({ data }) : undefined));
      await expect(provider.exchange("code")).rejects.toMatchObject({ code: data.app_id === "wrong-app" ? "CHANNEL_AUTHENTICATION_FAILED" : "CHANNEL_PERMISSION_DENIED" });
    }
  });
  it("permits an advanced WhatsApp token only through native app/scope/WABA verification and explicit selection", async () => {
    const { scope, connection } = await workspace("whatsapp", "cloud_api");
    const http = transport(url => {
      if (url.pathname.endsWith("/manual-waba")) return json({ id: "manual-waba" });
      if (url.pathname.endsWith("/phone_numbers")) return json({ data: [{ id: "manual-phone", display_phone_number: "+001", code_verification_status: "VERIFIED", platform_type: "CLOUD_API" }] });
      return undefined;
    });
    const setup = new MetaChannelSetup(channels, sessions, [profile("whatsapp", "cloud_api")], http);
    const authorized = await setup.manual(scope, session, { connectionId: connection.id, expectedRevision: 1, accessToken: "private-manual-token", wabaId: "manual-waba" });
    expect(http.mock.calls.some(([url]) => String(url).endsWith("/oauth/access_token"))).toBe(false);
    expect((await channels.get(scope, connection.id)).state).toBe("pending"); expect(JSON.stringify(authorized)).not.toContain("private-manual-token");
    await expect(setup.select(scope, session, { ticket: authorized.ticket, assetId: "not-in-provider-list" })).rejects.toMatchObject({ code: "CHANNEL_ASSET_UNAVAILABLE" });
    expect(http.mock.calls.some(([url]) => String(url).endsWith("/subscribed_apps"))).toBe(false);
    const retry = await setup.manual(scope, session, { connectionId: connection.id, expectedRevision: 1, accessToken: "private-manual-token", wabaId: "manual-waba" });
    const selected = await setup.select(scope, session, { ticket: retry.ticket, assetId: "manual-phone" }); expect(selected.state).toBe("active");
    expect(http.mock.calls.some(([url]) => String(url).endsWith("/register"))).toBe(false);
  });
  it("blocks a changed provider profile and stale expected revision before using customer credentials", async () => {
    const { scope, connection } = await workspace(), http = transport();
    const setup = new MetaChannelSetup(channels, sessions, [profile("facebook", "meta")], http);
    const start = await setup.begin(scope, session, { connectionId: connection.id, expectedRevision: 1 });
    const changed = new MetaChannelSetup(channels, sessions, [{ ...profile("facebook", "meta"), apiVersion: "v100.0" }], http);
    await expect(changed.complete(scope, session, { state: start.state, code: "code" })).rejects.toMatchObject({ code: "CHANNEL_SETUP_CONFIGURATION_CHANGED" });
    expect(http).not.toHaveBeenCalled();
    await channels.update(scope, connection.id, { expectedRevision: 1, name: "Changed" });
    await expect(setup.begin(scope, session, { connectionId: connection.id, expectedRevision: 1 })).rejects.toMatchObject({ code: "CHANNEL_CONNECTION_CHANGED" });
  });
  it("fences stale selection on disconnect/reconnect and never changes accepted credential revision", async () => {
    const { scope, connection } = await workspace();
    const http = transport(url => url.pathname.endsWith("/me/accounts") ? json({ data: [{ id: "page-stale", name: "Stale", tasks: ["MESSAGING"], access_token: "private-stale-fixture" }] }) : undefined);
    const setup = new MetaChannelSetup(channels, sessions, [profile("facebook", "meta")], http);
    const begin = await setup.begin(scope, session, { connectionId: connection.id, expectedRevision: 1 });
    const complete = await setup.complete(scope, session, { state: begin.state, code: "code" });
    const disconnected = await setup.disconnect(scope, { connectionId: connection.id, expectedRevision: 1 }); expect(disconnected.unsubscribe).toBe("not_needed");
    const calls = http.mock.calls.length;
    await expect(setup.select(scope, session, { ticket: complete.ticket, assetId: "page-stale" })).rejects.toMatchObject({ code: "CHANNEL_SETUP_EXPIRED_OR_CHANGED" });
    expect(http).toHaveBeenCalledTimes(calls);
    const fresh = await setup.begin(scope, session, { connectionId: connection.id, expectedRevision: disconnected.connection.revision });
    const authorized = await setup.complete(scope, session, { state: fresh.state, code: "new-code" });
    const selected = await setup.select(scope, session, { ticket: authorized.ticket, assetId: "page-stale" }); expect(selected.credentialRevision).toBe(1);
    const result = await setup.disconnect(scope, { connectionId: connection.id, expectedRevision: selected.revision }); expect(result.unsubscribe).toBe("confirmed");
    await expect(channels.resolveCredential({ organizationId: scope.organizationId, connectionId: connection.id })).rejects.toMatchObject({ code: "CHANNEL_AUTHORITY_CHANGED" });
  });
  it("keeps disconnect local when remote cleanup fails and preserves a shared Page subscription", async () => {
    const { scope } = await workspace();
    const pageId = randomUUID(), a = await channels.create(scope, { kind: "facebook", mode: "meta", name: "Page", assetId: pageId, state: "active", credentials: { accessToken: "private-page" }, metadata: { pageId } });
    const b = await channels.create(scope, { kind: "instagram", mode: "meta", name: "IG", assetId: randomUUID(), state: "active", credentials: { accessToken: "private-page" }, metadata: { pageId } });
    const http = transport(() => json({ error: { message: "private-provider-error" } }, 503));
    const setup = new MetaChannelSetup(channels, sessions, [profile("facebook", "meta"), profile("instagram", "meta")], http);
    expect((await setup.disconnect(scope, { connectionId: a.id, expectedRevision: 1 })).unsubscribe).toBe("shared_subscription_retained"); expect(http).not.toHaveBeenCalled();
    const last = await setup.disconnect(scope, { connectionId: b.id, expectedRevision: 1 }); expect(last).toMatchObject({ connection: { state: "disconnected" }, unsubscribe: "unconfirmed" }); expect(http).toHaveBeenCalledTimes(1);
  });
  it("consumes state atomically under racing completion and never retries a failed code exchange", async () => {
    const { scope, connection } = await workspace(); const http = transport(() => json({ error: { message: "private-failure" } }, 502));
    const setup = new MetaChannelSetup(channels, sessions, [profile("facebook", "meta")], http), begin = await setup.begin(scope, session, { connectionId: connection.id, expectedRevision: 1 });
    const results = await Promise.allSettled([setup.complete(scope, session, { state: begin.state, code: "code" }), setup.complete(scope, session, { state: begin.state, code: "code" })]);
    expect(results.every(result => result.status === "rejected")).toBe(true); expect(http).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(results)).not.toContain("private-failure");
  });
});
