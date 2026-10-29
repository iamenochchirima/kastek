import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { ChannelStore } from "../src/product/channels/channel-store";
import { MetaChannelSetup, MetaSetupSessions, metaSetupProfileDigest, type MetaSetupProfile } from "../src/product/channels/meta-setup";
import { channelPolicyReadiness, channelReplyPolicy } from "../src/product/channels/channel-policy";
import { ConnectionVault } from "../src/infrastructure/vault";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL, session = "lifecycle-fixture-owner-session";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const profile = (kind: "facebook" | "instagram" = "facebook", mode: "meta" | "instagram_login" = "meta"): MetaSetupProfile => ({
  kind, mode, appId: "app-owned", appSecret: "private-app", webhookVerifyToken: "private-verify", apiVersion: "v99.0", scopes: ["fixture_messaging"],
  redirectUri: "https://agents.fixture.test/app/connections", subscribedFields: ["messages"], discoveryPageLimit: 4,
});
describe("sourced customer reply policy", () => {
  const now = Date.now(), base = { kind: "instagram" as const, mode: "instagram_login", now, latestCustomerAt: now - 2 * 86400000,
    author: "human" as const, assignedHuman: true, relatedInquiryConfirmed: true, humanAgentApproved: true, humanAgentTransportEnabled: true };
  it("requires approved permission, actual assigned human authorship, relatedness and installed transport for seven-day support", () => {
    expect(channelReplyPolicy(base)).toMatchObject({ allowed: true, tag: "HUMAN_AGENT" });
    for (const denied of [{ author: "assistant" as const }, { assignedHuman: false }, { relatedInquiryConfirmed: false }, { humanAgentApproved: false }, { humanAgentTransportEnabled: false }, { kind: "facebook" as const }, { mode: "meta" }]) {
      expect(channelReplyPolicy({ ...base, ...denied }).allowed).toBe(false);
    }
    expect(channelReplyPolicy({ ...base, latestCustomerAt: now - 7 * 86400000 }).allowed).toBe(false);
    expect(channelPolicyReadiness("instagram", "instagram_login", true, true).humanSupport).toBe("approved_staff_confirmation_required");
    expect(channelPolicyReadiness("instagram", "instagram_login", true, false).humanSupport).toBe("standard_window_only");
    expect(channelPolicyReadiness("facebook", "meta", true, true).humanSupport).toBe("standard_window_only");
  });
  it("uses the verified customer's 24-hour boundary and never treats future or missing evidence as permission", () => {
    expect(channelReplyPolicy({ ...base, kind: "whatsapp", latestCustomerAt: now - 86400000 + 1 }).allowed).toBe(true);
    expect(channelReplyPolicy({ ...base, kind: "whatsapp", latestCustomerAt: now - 86400000 })).toMatchObject({ allowed: false, reason: "approved_template_required" });
    expect(channelReplyPolicy({ ...base, latestCustomerAt: now + 1 }).allowed).toBe(false);
    expect(channelReplyPolicy({ ...base, latestCustomerAt: null }).allowed).toBe(false);
  });
  it("reports the direct Instagram permission only when the server profile and adapter transport are both enabled", () => {
    const direct = new MetaChannelSetup(null as never, null as never,
      [{ ...profile("instagram", "instagram_login"), humanAgentApproved: true }], fetch);
    const pageLinked = new MetaChannelSetup(null as never, null as never,
      [{ ...profile("instagram", "meta"), humanAgentApproved: true }], fetch);
    expect(direct.readiness()[0]?.policy.humanSupport).toBe("approved_staff_confirmation_required");
    expect(pageLinked.readiness()[0]?.policy.humanSupport).toBe("standard_window_only");
  });
});

(databaseUrl ? describe : describe.skip)("native Meta lifecycle and explicit uncertain-effect reconciliation", () => {
  const database = `agents_channel_lifecycle_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, platform: PlatformStore, channels: ChannelStore, sessions: MetaSetupSessions;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href });
    await setupPlatformSchema(pool); platform = new PlatformStore(pool);
    const vault = new ConnectionVault("test", { test: randomBytes(32).toString("base64") }); channels = new ChannelStore(pool, vault); sessions = new MetaSetupSessions(pool, vault, 600);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  async function fixture(p = profile(), pending = false) {
    const account = await platform.ensureAccount({ issuer: "https://lifecycle.fixture.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const organization = await platform.createOrganization(account.id, "Lifecycle"), scope = { accountId: account.id, organizationId: organization.id };
    const assetId = `asset-${randomUUID()}`, pageId = p.kind === "instagram" && p.mode === "meta" ? `page-${randomUUID()}` : assetId;
    const connection = await channels.create(scope, { kind: p.kind, mode: p.mode, name: "Native account", ...(!pending ? { assetId, state: "active", credentials: { accessToken: "private-current", appSecret: p.appSecret, verifyToken: p.webhookVerifyToken },
      metadata: { ...(p.mode === "meta" ? { pageId } : {}), setupProfileDigest: metaSetupProfileDigest(p), apiVersion: p.apiVersion, expiresAt: new Date(Date.now() + 3600000).toISOString(), issuedAt: new Date(Date.now() - 2 * 86400000).toISOString() } } : {}) });
    return { scope, connection, assetId, pageId };
  }
  function native(item: Awaited<ReturnType<typeof fixture>>, extra: (url: URL, init?: RequestInit) => Response | undefined = () => undefined) {
    return vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input)), response = extra(url, init); if (response) return response;
      if (url.pathname.endsWith("/oauth/access_token")) return json({ access_token: "private-user", expires_in: 5000 });
      if (url.pathname.endsWith("/debug_token")) return json({ data: { is_valid: true, app_id: "app-owned", scopes: ["fixture_messaging"] } });
      if (url.pathname.endsWith("/me/accounts")) return json({ data: [{ id: item.pageId, name: "Page", access_token: "private-page", tasks: ["MESSAGING"], ...(item.connection.kind === "instagram" ? { instagram_business_account: { id: item.assetId } } : {}) }] });
      if (url.pathname.endsWith("/me/permissions")) return json({ data: [{ permission: "fixture_messaging", status: "granted" }] });
      if (url.pathname.endsWith("/me")) return json({ id: item.assetId, user_id: item.assetId, username: "native" });
      if (url.pathname.endsWith("/subscribed_apps")) return init?.method === "POST" || init?.method === "DELETE" ? json({ success: true }) : json({ data: [{ id: "app-owned", subscribed_fields: ["messages"] }] });
      if (url.pathname.endsWith(`/${item.pageId}`)) return json({ id: item.pageId, instagram_business_account: { id: item.assetId } });
      throw new Error(`Unexpected lifecycle fixture path ${url.pathname}`);
    });
  }
  async function authorize(service: MetaChannelSetup, item: Awaited<ReturnType<typeof fixture>>) {
    const current = await channels.get(item.scope, item.connection.id), begin = await service.begin(item.scope, session, { connectionId: current.id, expectedRevision: current.revision });
    return service.complete(item.scope, session, { state: begin.state, code: "fixture-code" });
  }
  async function expireClaims(id: string) {
    await pool.query("UPDATE agents_platform.channel_setup_claims SET expires_at=now()-interval '1 second' WHERE connection_id=$1", [id]);
    await pool.query("UPDATE agents_platform.channel_setup_resource_claims SET expires_at=now()-interval '1 second' WHERE connection_id=$1", [id]);
  }
  it("observes valid native health without rotating authority, then pauses bindings on reduced permission", async () => {
    const item = await fixture(); let allowed = true;
    const http = native(item, url => !allowed && url.pathname.endsWith("/debug_token") ? json({ data: { is_valid: true, app_id: "app-owned", scopes: [] } }) : undefined);
    const setup = new MetaChannelSetup(channels, sessions, [profile()], http);
    const agent = await platform.createConfiguredAgent({ ...item.scope, name: "Support", offering: "faq" });
    const binding = await channels.bind(item.scope, item.connection.id, { expectedRevision: 1, agentId: agent.agent.id });
    expect(await setup.health(item.scope, { connectionId: item.connection.id, expectedRevision: 1 })).toMatchObject({ status: "healthy", connection: { revision: 1 } });
    allowed = false;
    expect(await setup.health(item.scope, { connectionId: item.connection.id, expectedRevision: 1 })).toMatchObject({ status: "needs_attention", reason: "CHANNEL_PERMISSION_DENIED", connection: { revision: 2 } });
    expect((await pool.query("SELECT state FROM agents_platform.channel_deployments WHERE id=$1", [binding.id])).rows[0].state).toBe("paused");
    expect(http.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
  it("treats removed linked Instagram identity and missing subscriptions as factual attention states", async () => {
    const p = profile("instagram", "meta"), item = await fixture(p);
    const http = native(item, url => url.pathname.endsWith(`/${item.pageId}`) ? json({ id: item.pageId, instagram_business_account: { id: "different-account" } }) : undefined);
    const setup = new MetaChannelSetup(channels, sessions, [p], http);
    expect(await setup.health(item.scope, { connectionId: item.connection.id, expectedRevision: 1 })).toMatchObject({ status: "needs_attention", reason: "CHANNEL_ASSET_UNAVAILABLE" });
    const other = await fixture(), missing = new MetaChannelSetup(channels, sessions, [profile()], native(other, url => url.pathname.endsWith("/subscribed_apps") ? json({ data: [] }) : undefined));
    expect(await missing.health(other.scope, { connectionId: other.connection.id, expectedRevision: 1 })).toMatchObject({ status: "needs_attention", reason: "CHANNEL_SUBSCRIPTION_MISSING" });
  });
  it("refreshes only reviewed, eligible direct-Instagram tokens and rotates encrypted credentials after native identity/permission proof", async () => {
    const p = { ...profile("instagram", "instagram_login"), instagramRefreshReviewed: true }, item = await fixture(p);
    const http = native(item, url => url.pathname === "/refresh_access_token" ? json({ access_token: "private-refreshed", expires_in: 5000 }) : undefined);
    const setup = new MetaChannelSetup(channels, sessions, [p], http);
    const updated = await setup.refresh(item.scope, { connectionId: item.connection.id, expectedRevision: 1 });
    expect(updated).toMatchObject({ revision: 2, credentialRevision: 2, assetId: item.assetId });
    expect((await channels.resolveSetupCredential(item.scope, updated.id, updated.revision)).accessToken).toBe("private-refreshed");
    expect(http.mock.calls.filter(([url]) => String(url).includes("/refresh_access_token"))).toHaveLength(1);
    expect(JSON.stringify(updated)).not.toContain("private-refreshed");
    await expect(setup.refresh(item.scope, { connectionId: updated.id, expectedRevision: updated.revision })).rejects.toMatchObject({ code: "CHANNEL_REFRESH_NOT_ELIGIBLE" });
    expect(http.mock.calls.filter(([url]) => String(url).includes("/refresh_access_token"))).toHaveLength(1);
  });
  it("blocks refresh without current provider review and expired health before provider requests", async () => {
    const p = profile("instagram", "instagram_login"), item = await fixture(p), http = native(item), setup = new MetaChannelSetup(channels, sessions, [p], http);
    await expect(setup.refresh(item.scope, { connectionId: item.connection.id, expectedRevision: 1 })).rejects.toMatchObject({ code: "CHANNEL_REFRESH_REVIEW_REQUIRED" }); expect(http).not.toHaveBeenCalled();
    await pool.query("UPDATE agents_platform.channel_connections SET metadata=jsonb_set(metadata,'{expiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE id=$1", [item.connection.id]);
    expect(await setup.health(item.scope, { connectionId: item.connection.id, expectedRevision: 1 })).toMatchObject({ status: "needs_attention", reason: "CHANNEL_AUTHENTICATION_FAILED" }); expect(http).not.toHaveBeenCalled();
  });
  it("requires an explicit fresh owner ticket plus native evidence to reconcile a lost subscribe acknowledgement", async () => {
    const item = await fixture(profile(), true); let subscribed = false;
    const http = native(item, (url, init) => {
      if (url.pathname.endsWith("/subscribed_apps")) {
        if (init?.method === "POST") { subscribed = true; throw new Error("Lost acknowledgement"); }
        return json({ data: subscribed ? [{ id: "app-owned", subscribed_fields: ["messages"] }] : [] });
      } return undefined;
    });
    const setup = new MetaChannelSetup(channels, sessions, [profile()], http), first = await authorize(setup, item);
    await expect(setup.select(item.scope, session, { ticket: first.ticket, assetId: item.assetId })).rejects.toMatchObject({ code: "CHANNEL_SETUP_PROVIDER_OUTCOME_UNKNOWN" });
    const early = await authorize(setup, item);
    await expect(setup.reconcile(item.scope, session, { ticket: early.ticket, assetId: item.assetId, intent: "connect" })).rejects.toMatchObject({ code: "CHANNEL_SETUP_RECONCILIATION_NOT_READY" });
    await expireClaims(item.connection.id);
    const fresh = await authorize(setup, item), result = await setup.reconcile(item.scope, session, { ticket: fresh.ticket, assetId: item.assetId, intent: "connect" });
    expect(result).toMatchObject({ status: "active", observedSubscription: true, connection: { assetId: item.assetId, credentialRevision: 1 } });
    expect(http.mock.calls.filter(([, init]) => init?.method === "POST" && String(init?.body).includes("subscribed_fields"))).toHaveLength(1);
  });
  it("does not activate a missing provider effect and does not repeat an already completed disconnect", async () => {
    const item = await fixture(), http = native(item, (url, init) => {
      if (url.pathname.endsWith("/subscribed_apps") && init?.method === "DELETE") throw new Error("Lost delete acknowledgement");
      if (url.pathname.endsWith("/subscribed_apps")) return json({ data: [] }); return undefined;
    });
    const setup = new MetaChannelSetup(channels, sessions, [profile()], http);
    expect((await setup.disconnect(item.scope, { connectionId: item.connection.id, expectedRevision: 1 })).unsubscribe).toBe("unconfirmed");
    await expireClaims(item.connection.id);
    const authorized = await authorize(setup, item), result = await setup.reconcile(item.scope, session, { ticket: authorized.ticket, assetId: item.assetId, intent: "disconnect" });
    expect(result).toMatchObject({ status: "disconnected", observedSubscription: false });
    expect(http.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    const pending = await fixture(profile(), true), pendingHttp = native(pending, (url, init) => {
      if (url.pathname.endsWith("/subscribed_apps") && init?.method === "POST") throw new Error("Not applied");
      if (url.pathname.endsWith("/subscribed_apps")) return json({ data: [] }); return undefined;
    });
    const pendingSetup = new MetaChannelSetup(channels, sessions, [profile()], pendingHttp), first = await authorize(pendingSetup, pending);
    await expect(pendingSetup.select(pending.scope, session, { ticket: first.ticket, assetId: pending.assetId })).rejects.toMatchObject({ code: "CHANNEL_SETUP_PROVIDER_OUTCOME_UNKNOWN" });
    await expireClaims(pending.connection.id);
    const second = await authorize(pendingSetup, pending);
    expect(await pendingSetup.reconcile(pending.scope, session, { ticket: second.ticket, assetId: pending.assetId, intent: "connect" })).toMatchObject({ status: "reconnect_required", observedSubscription: false, connection: { state: "pending" } });
    expect(pendingHttp.mock.calls.filter(([, init]) => init?.method === "POST" && String(init?.body).includes("subscribed_fields"))).toHaveLength(1);
  });
  it("rejects evaluation-only setup/health connections before all provider I/O", async () => {
    const item = await fixture(), http = native(item), setup = new MetaChannelSetup(channels, sessions, [profile()], http);
    await pool.query("UPDATE agents_platform.channel_connections SET metadata=metadata||'{\"evaluationFixture\":true,\"evaluationTrialId\":\"fixture-only\"}'::jsonb WHERE id=$1", [item.connection.id]);
    await expect(setup.begin(item.scope, session, { connectionId: item.connection.id, expectedRevision: 1 })).rejects.toMatchObject({ code: "CHANNEL_EVALUATION_FIXTURE_LIVE_IO_DENIED" });
    await expect(setup.health(item.scope, { connectionId: item.connection.id, expectedRevision: 1 })).rejects.toMatchObject({ code: "CHANNEL_EVALUATION_FIXTURE_LIVE_IO_DENIED" }); expect(http).not.toHaveBeenCalled();
  });
});
