import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { channelWebhookEventSchema } from "../src/contracts/channel-adapters";
import { defaultBusinessConfiguration, executionGrantSchema, requestDigest } from "../src/contracts/contracts";
import { transaction } from "../src/infrastructure/database";
import { ConnectionVault } from "../src/infrastructure/vault";
import { PlatformStore } from "../src/product/agents/store";
import { MemberChannels } from "../src/product/assistant/member-channels";
import { ChannelStore } from "../src/product/channels/channel-store";
import { ChannelDelivery } from "../src/product/channels/channel-delivery";
import { InboxStore } from "../src/product/inbox/inbox-store";
import { RemoteConnectionStore } from "../src/product/connections/remote-connections";
import { createRemoteMcpCapabilityCatalog } from "../src/capabilities/connected-tools/generic-connected-runtime";
import { ToolReviewStore } from "../src/capabilities/reviews/tool-reviews";
import { operationsForConfiguration } from "../src/product/automations/automations";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("verified member channel identity", () => {
  const database = `agents_member_channels_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, platform: PlatformStore, channels: ChannelStore, members: MemberChannels;
  const previousEnabled = process.env.AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS;
  beforeAll(async () => {
    process.env.AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS = "*";
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.href });
    await setupPlatformSchema(pool);
    platform = new PlatformStore(pool);
    channels = new ChannelStore(pool, new ConnectionVault("fixture", { fixture: randomBytes(32).toString("base64") }));
    members = new MemberChannels(pool);
  });
  afterAll(async () => {
    if (previousEnabled === undefined) delete process.env.AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS;
    else process.env.AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS = previousEnabled;
    await pool?.end();
    if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); }
  });
  const account = () => platform.ensureAccount({ issuer: "https://member-channel.fixture.test", subject: randomUUID(), email: "member@example.test", displayName: "Member" });
  async function fixture(kind: "telegram" | "whatsapp" = "telegram") {
    const owner = await account(), organization = await platform.createOrganization(owner.id, "Member channel fixture");
    const scope = { accountId: owner.id, organizationId: organization.id };
    const assetId = String(randomInt(1_000_000, 1_000_000_000));
    const connection = await channels.create(scope, { kind, mode: kind === "telegram" ? "bot" : "cloud_api", name: "Private connection", assetId,
      state: "active", credentials: kind === "telegram" ? { botToken: `${assetId}:fixture_token`, webhookSecret: "fixture_secret" } : { accessToken: "fixture_token" } });
    return { scope, connection };
  }
  const event = (assetId: string, text = "Hello", options: Record<string, unknown> = {}) => channelWebhookEventSchema.parse({
    kind: "message", assetId, eventId: randomUUID(), externalConversationId: "1234", senderId: "1234", providerMessageId: "555",
    occurredAt: new Date().toISOString(), text, privateChat: true, ...options,
  });
  const connectionRow = async (id: string) => (await pool.query("SELECT * FROM agents_platform.channel_connections WHERE id=$1", [id])).rows[0];
  const route = async (id: string, value: ReturnType<typeof event>) => transaction(pool, async db => members.route(db, await connectionRow(id), value));
  async function pending(f: Awaited<ReturnType<typeof fixture>>, identity: Record<string, unknown> = {}) {
    const challenge = await members.challenge(f.scope, { connectionId: f.connection.id });
    expect(await route(f.connection.id, event(f.connection.assetId, `/pair ${challenge.token}`, identity))).toEqual({ consumed: true });
    return challenge;
  }
  function worker(send: typeof fetch, beforeDispatch?: () => Promise<void>, acknowledgments?: string[]) {
    const inbox = new InboxStore(pool, { admit: async () => { throw Error("Unexpected customer model admission"); }, readableOutput: async (_db, _id, text) => text, cancelRoot: async () => undefined });
    return new ChannelDelivery(pool, channels, inbox, { assertPolicy: async () => undefined,
      acknowledgeInteraction: async (_connection, _event, outcome) => { acknowledgments?.push(outcome ?? "unknown"); },
      context: (_connection, credentials, beforeAttempt) => ({ credential: credentials.botToken ?? credentials.accessToken,
        apiVersion: "v24.0", fetch: async (input, init) => { await beforeDispatch?.(); await beforeAttempt(); return send(input, init); } }) });
  }
  async function queue(f: Awaited<ReturnType<typeof fixture>>, linkId: string, segments: number) {
    for (let segment = 0; segment < segments; segment++) {
      const request = { assetId: f.connection.assetId, recipientId: "1234", text: `Segment ${segment}` };
      await pool.query(`INSERT INTO agents_platform.channel_outbound(id,organization_id,connection_id,member_link_id,member_notice_key,
        segment,ownership_generation,connection_revision,credential_revision,request,digest)
        VALUES($1,$2,$3,$4,'fixture-result',$5,1,$6,$7,$8,$9)`,
      [randomUUID(), f.scope.organizationId, f.connection.id, linkId, segment, f.connection.revision, f.connection.credentialRevision, request, requestDigest(request)]);
    }
  }
  async function reviewFixture(kind: "telegram" | "whatsapp" = "telegram", value = "Approved payload") {
    const f = await fixture(kind), challenge = await pending(f);
    await members.confirm(f.scope, challenge.id);
    const owner = (await pool.query("SELECT * FROM agents_platform.accounts WHERE id=$1", [f.scope.accountId])).rows[0];
    await connectFixtureModel(pool, owner.id, f.scope.organizationId);
    const remote = new RemoteConnectionStore(pool, new ConnectionVault("review", { review: randomBytes(32).toString("base64") }), { callbackUrl: "http://localhost/callback", testLoopback: true });
    const endpoint = "http://127.0.0.1:19999/review-target";
    const connection = await remote.create(f.scope, { operationId: randomUUID(), name: "Review destination", endpoint, authentication: "none" });
    const catalog = createRemoteMcpCapabilityCatalog({ protocolVersion: "2025-11-25", transport: "streamable_http", resources: [], resourceTemplates: [], prompts: [], serverCapabilities: { tools: {} },
      diagnostics: [], digest: "a".repeat(64), attempts: [], tools: [{ name: "record_request", alias: "record_request", description: "Record one approved request", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
        definitionDigest: "b".repeat(64), schemaDigest: "c".repeat(64), effect: "unknown", reviewRequired: true, compatible: true, diagnostics: [] }] },
    { id: randomUUID(), organizationId: f.scope.organizationId, connectionId: connection.id, revision: 1 });
    await remote.catalogs.saveCandidate(f.scope, { operationId: randomUUID(), connectionId: connection.id, expectedRevision: connection.revision, catalog });
    const [binding] = await remote.catalogs.selectBindings(f.scope, { operationId: randomUUID(), connectionId: connection.id, expectedRevision: connection.revision, catalogId: catalog.id,
      selections: [{ providerOperation: "record_request", resources: [{ kind: "mcp.endpoint", id: endpoint }], effectPolicy: "exact_review" }] });
    const configuration = { ...defaultBusinessConfiguration(), connectedToolBindingIds: [binding!.id] };
    const agent = await platform.createAgent({ ...f.scope, name: "Review assistant", configuration });
    const version = await platform.createVersion({ ...f.scope, agentId: agent.id, expectedRevision: 1 });
    const authority = { product: "agents" as const, organizationId: f.scope.organizationId, resourceId: agent.id, callerClientId: "agents-execution",
      principal: { kind: "human" as const, issuer: owner.issuer, subject: owner.subject } };
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id, operations: operationsForConfiguration(configuration, true), sourceRevisionIds: [], connectedToolBindingIds: [binding!.id],
      maxInputBytes: configuration.model.maxInputBytes, maxOutputTokens: configuration.model.maxOutputTokens, maxContextTokens: configuration.context.maxInputTokens, expiresAt: new Date(Date.now() + 300000).toISOString(), revokedAt: null });
    await platform.createGrant({ accountId: owner.id, grant });
    const { task } = await platform.admitTask({ authority, grantId: grant.id, versionId: version.id, input: "Prepare a reviewed operation", requestKey: randomUUID() });
    const delivery = worker(async () => kind === "telegram" ? Response.json({ ok: true, result: { message_id: 888 } }) : Response.json({ messages: [{ id: "wamid.review" }] }));
    const incoming = event(f.connection.assetId);
    await delivery.persist(kind, [incoming]);
    const ingress = (await pool.query("UPDATE agents_platform.channel_ingress SET state='completed' WHERE connection_id=$1 RETURNING id", [f.connection.id])).rows[0];
    await pool.query("INSERT INTO agents_platform.member_channel_tasks(task_id,organization_id,link_id,link_generation,ingress_id) VALUES($1,$2,$3,1,$4)", [task.id, f.scope.organizationId, challenge.id, ingress.id]);
    await pool.query("UPDATE agents_platform.member_channel_links SET conversation_id=$2,latest_inbound_at=now() WHERE id=$1", [challenge.id, task.conversation_id]);
    const reviews = new ToolReviewStore(pool), review = await reviews.prepare(task.id, `review:${randomUUID()}`, binding!, { value });
    return { ...f, challenge, task, review, reviews, delivery, endpoint };
  }

  it("stores only a challenge hash, consumes it once, and requires app confirmation", async () => {
    const f = await fixture(), challenge = await members.challenge(f.scope, { connectionId: f.connection.id });
    const saved = (await pool.query("SELECT * FROM agents_platform.member_channel_links WHERE id=$1", [challenge.id])).rows[0];
    expect(saved.challenge_hash).toBe(createHash("sha256").update(challenge.token).digest("hex"));
    expect(JSON.stringify(saved)).not.toContain(challenge.token);
    await route(f.connection.id, event(f.connection.assetId, `/start ${challenge.token}`));
    expect((await members.list(f.scope)).links[0]).toMatchObject({ state: "pending", senderLabel: "1234" });
    expect(await route(f.connection.id, event(f.connection.assetId))).toEqual({ consumed: true });
    await route(f.connection.id, event(f.connection.assetId, `/pair ${challenge.token}`, { senderId: "5678", externalConversationId: "5678" }));
    expect((await pool.query("SELECT sender_id,challenge_hash FROM agents_platform.member_channel_links WHERE id=$1", [challenge.id])).rows[0]).toEqual({ sender_id: "1234", challenge_hash: null });
    await expect(members.confirm(f.scope, challenge.id)).resolves.toEqual({ id: challenge.id, state: "active" });
    expect(await route(f.connection.id, event(f.connection.assetId))).toEqual({ consumed: false, linkId: challenge.id });
    await expect(members.confirm(f.scope, challenge.id)).rejects.toMatchObject({ code: "MEMBER_CHANNEL_DENIED" });
  });

  it("does not consume expired challenges or pair through a group/other asset", async () => {
    const f = await fixture(), other = await fixture();
    const challenge = await members.challenge(f.scope, { connectionId: f.connection.id });
    await route(f.connection.id, event(f.connection.assetId, `/pair ${challenge.token}`, { privateChat: false, externalConversationId: "-42" }));
    await route(other.connection.id, event(other.connection.assetId, `/pair ${challenge.token}`));
    expect((await members.list(f.scope)).links[0]?.state).toBe("challenge");
    await pool.query("UPDATE agents_platform.member_channel_links SET expires_at=now()-interval '1 second' WHERE id=$1", [challenge.id]);
    await route(f.connection.id, event(f.connection.assetId, `/pair ${challenge.token}`));
    expect((await members.list(f.scope)).links[0]?.state).toBe("expired");
    await expect(members.confirm(f.scope, challenge.id)).rejects.toMatchObject({ code: "MEMBER_CHANNEL_DENIED" });
  });

  it("isolates challenge, list, confirmation and unlink across accounts and organizations", async () => {
    const f = await fixture(), other = await fixture(), teammate = await account();
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')", [f.scope.organizationId, teammate.id]);
    const challenge = await pending(f), teammateScope = { ...f.scope, accountId: teammate.id };
    expect((await members.list(teammateScope)).links).toEqual([]);
    for (const scope of [teammateScope, other.scope]) {
      await expect(members.confirm(scope, challenge.id)).rejects.toMatchObject({ code: "MEMBER_CHANNEL_DENIED" });
      await expect(members.revoke(scope, challenge.id)).rejects.toMatchObject({ code: "MEMBER_CHANNEL_DENIED" });
    }
    await expect(members.challenge(other.scope, { connectionId: f.connection.id })).rejects.toMatchObject({ code: "MEMBER_CHANNEL_DENIED" });
    await expect(members.list({ ...f.scope, accountId: other.scope.accountId })).rejects.toMatchObject({ code: "MEMBER_CHANNEL_DENIED" });
  });

  it("requires current membership and connection revisions at confirmation and routing", async () => {
    for (const change of ["membership", "revision", "credential_revision"] as const) {
      const f = await fixture(), challenge = await pending(f);
      if (change === "membership") await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2", [f.scope.organizationId, f.scope.accountId]);
      else await pool.query(`UPDATE agents_platform.channel_connections SET ${change}=${change}+1 WHERE id=$1`, [f.connection.id]);
      await expect(members.confirm(f.scope, challenge.id)).rejects.toMatchObject({ code: "MEMBER_CHANNEL_DENIED" });
      expect(await route(f.connection.id, event(f.connection.assetId))).toEqual({ consumed: true });
    }
  });

  it("consumes active identities after membership removal or connection replacement", async () => {
    for (const change of ["membership", "revision", "credential_revision"] as const) {
      const f = await fixture(), challenge = await pending(f);
      await members.confirm(f.scope, challenge.id);
      if (change === "membership") await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2", [f.scope.organizationId, f.scope.accountId]);
      else await pool.query(`UPDATE agents_platform.channel_connections SET ${change}=${change}+1 WHERE id=$1`, [f.connection.id]);
      expect(await route(f.connection.id, event(f.connection.assetId))).toEqual({ consumed: true });
    }
  });

  it("allows only one provider actor to consume a challenge under concurrent delivery", async () => {
    const f = await fixture(), challenge = await members.challenge(f.scope, { connectionId: f.connection.id });
    await Promise.all(["1111", "2222"].map(senderId => route(f.connection.id, event(f.connection.assetId, `/pair ${challenge.token}`, { senderId, externalConversationId: senderId }))));
    const saved = (await pool.query("SELECT state,sender_id,chat_id,challenge_hash FROM agents_platform.member_channel_links WHERE id=$1", [challenge.id])).rows[0];
    expect(saved).toMatchObject({ state: "pending", challenge_hash: null });
    expect(["1111", "2222"]).toContain(saved.sender_id);
    expect(saved.chat_id).toBe(saved.sender_id);
  });

  it.each(["telegram", "whatsapp"] as const)("keeps revoked %s identities consumed instead of falling through to customers", async kind => {
    const f = await fixture(kind), challenge = await pending(f);
    await members.confirm(f.scope, challenge.id);
    expect(await route(f.connection.id, event(f.connection.assetId, "Hello", { privateChat: false }))).toEqual({ consumed: true });
    expect(await route(f.connection.id, event(f.connection.assetId, "Hello", { senderId: "5678" }))).toEqual({ consumed: true });
    await members.revoke(f.scope, challenge.id);
    expect(await route(f.connection.id, event(f.connection.assetId))).toEqual({ consumed: true });
    const saved = (await pool.query("SELECT state,generation FROM agents_platform.member_channel_links WHERE id=$1", [challenge.id])).rows[0];
    expect(saved).toEqual({ state: "revoked", generation: 2 });
    expect(await route(f.connection.id, event(f.connection.assetId, "Customer", { senderId: "9999", externalConversationId: "9999" }))).toEqual({ consumed: false });
  });

  it("revokes stale pending challenges on replacement and enforces pairing issuance limits", async () => {
    const f = await fixture(), first = await pending(f);
    await members.challenge(f.scope, { connectionId: f.connection.id });
    await expect(members.confirm(f.scope, first.id)).rejects.toMatchObject({ code: "MEMBER_CHANNEL_DENIED" });
    for (let i = 0; i < 3; i++) await members.challenge(f.scope, { connectionId: f.connection.id });
    await expect(members.challenge(f.scope, { connectionId: f.connection.id })).rejects.toMatchObject({ code: "PAIRING_RATE_LIMIT", statusCode: 429 });
  });

  it("persists private ingress once without customer ownership and consumes revoked routes", async () => {
    const f = await fixture(), challenge = await pending(f), delivery = worker(async () => { throw Error("Unexpected provider call"); });
    await members.confirm(f.scope, challenge.id);
    const incoming = event(f.connection.assetId);
    expect(await delivery.persist("telegram", [incoming])).toBe(1);
    expect(await delivery.persist("telegram", [incoming])).toBe(0);
    const saved = (await pool.query("SELECT member_link_id,deployment_id FROM agents_platform.channel_ingress WHERE connection_id=$1", [f.connection.id])).rows;
    expect(saved).toEqual([{ member_link_id: challenge.id, deployment_id: null }]);
    await expect(delivery.persist("telegram", [{ ...incoming, text: "Conflicting replay" }])).rejects.toMatchObject({ code: "CHANNEL_EVENT_CONFLICT" });
    await members.revoke(f.scope, challenge.id);
    expect(await delivery.persist("telegram", [event(f.connection.assetId)])).toBe(0);
    expect((await pool.query("SELECT id FROM agents_platform.customer_conversations WHERE organization_id=$1", [f.scope.organizationId])).rows).toEqual([]);
  });

  it("preserves accepted segments and blocks later effects after a lost provider acknowledgment", async () => {
    const f = await fixture(), challenge = await pending(f);
    await members.confirm(f.scope, challenge.id);
    await queue(f, challenge.id, 3);
    let calls = 0;
    const delivery = worker(async () => { calls++; if (calls === 2) throw Error("Lost provider acknowledgment"); return Response.json({ ok: true, result: { message_id: 900 + calls } }); });
    await delivery.drain(8);
    await delivery.drain(8);
    expect(calls, JSON.stringify((await pool.query("SELECT segment,state,reason FROM agents_platform.channel_outbound WHERE member_link_id=$1 ORDER BY segment", [challenge.id])).rows)).toBe(2);
    expect((await pool.query("SELECT segment,state FROM agents_platform.channel_outbound WHERE member_link_id=$1 ORDER BY segment", [challenge.id])).rows)
      .toEqual([{ segment: 0, state: "accepted" }, { segment: 1, state: "unknown" }, { segment: 2, state: "pending" }]);
    await members.revoke(f.scope, challenge.id);
    expect((await pool.query("SELECT state FROM agents_platform.channel_outbound WHERE member_link_id=$1 AND segment=2", [challenge.id])).rows[0].state).toBe("suppressed");
  });

  it("retries a known rate rejection after cooldown without repeating accepted effects", async () => {
    const f = await fixture(), challenge = await pending(f);
    await members.confirm(f.scope, challenge.id);
    await queue(f, challenge.id, 1);
    let calls = 0;
    const delivery = worker(async () => { calls++; return calls === 1
      ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 60 } }, { status: 429 })
      : Response.json({ ok: true, result: { message_id: 777 } }); });
    await delivery.drain(4);
    await delivery.drain(4);
    expect(calls).toBe(1);
    expect((await pool.query("SELECT state,attempts FROM agents_platform.channel_outbound WHERE member_link_id=$1", [challenge.id])).rows[0]).toEqual({ state: "pending", attempts: 1 });
    await pool.query("UPDATE agents_platform.channel_send_limits SET next_send_at=now()-interval '1 second' WHERE connection_id=$1", [f.connection.id]);
    await pool.query("UPDATE agents_platform.channel_outbound SET available_at=now()-interval '1 second' WHERE member_link_id=$1", [challenge.id]);
    await delivery.drain(4);
    await delivery.drain(4);
    expect(calls).toBe(2);
    expect((await pool.query("SELECT state,attempts FROM agents_platform.channel_outbound WHERE member_link_id=$1", [challenge.id])).rows[0]).toEqual({ state: "accepted", attempts: 2 });
  });

  it("suppresses queued private sends after credential replacement", async () => {
    const f = await fixture(), challenge = await pending(f);
    await members.confirm(f.scope, challenge.id);
    await queue(f, challenge.id, 1);
    await pool.query("UPDATE agents_platform.channel_connections SET credential_revision=credential_revision+1 WHERE id=$1", [f.connection.id]);
    let calls = 0;
    await worker(async () => { calls++; throw Error("Unexpected provider dispatch"); }).drain(4);
    expect(calls).toBe(0);
    expect((await pool.query("SELECT state FROM agents_platform.channel_outbound WHERE member_link_id=$1", [challenge.id])).rows[0].state).toBe("suppressed");
  });

  it("rechecks revocation immediately before the physical provider effect", async () => {
    const f = await fixture(), challenge = await pending(f);
    await members.confirm(f.scope, challenge.id);
    await queue(f, challenge.id, 1);
    let calls = 0;
    await worker(async () => { calls++; throw Error("Revoked recipient reached provider"); }, async () => { await members.revoke(f.scope, challenge.id); }).drain(4);
    expect(calls).toBe(0);
    expect((await pool.query("SELECT state FROM agents_platform.channel_outbound WHERE member_link_id=$1", [challenge.id])).rows[0].state).toBe("suppressed");
  });

  it("applies only matching private WhatsApp receipts and keeps delivered/read facts monotonic", async () => {
    const f = await fixture("whatsapp"), challenge = await pending(f);
    await members.confirm(f.scope, challenge.id);
    await pool.query("UPDATE agents_platform.member_channel_links SET latest_inbound_at=now() WHERE id=$1", [challenge.id]);
    await queue(f, challenge.id, 1);
    let calls = 0;
    const delivery = worker(async () => { calls++; return Response.json({ messages: [{ id: "wamid.private" }] }); });
    await delivery.drain(4);
    expect(calls).toBe(1);
    const receipt = (status: string, options: Record<string, unknown> = {}) => event(f.connection.assetId, "", { kind: "receipt", providerMessageId: "wamid.private", status, ...options });
    expect(await delivery.persist("whatsapp", [receipt("read", { senderId: "9999" })])).toBe(0);
    expect(await delivery.persist("whatsapp", [receipt("read", { externalConversationId: "9999" })])).toBe(0);
    expect((await pool.query("SELECT state FROM agents_platform.channel_outbound WHERE member_link_id=$1", [challenge.id])).rows[0].state).toBe("accepted");
    await delivery.persist("whatsapp", [receipt("read")]);
    await delivery.drain(4);
    await delivery.persist("whatsapp", [receipt("delivered")]);
    await delivery.drain(4);
    expect(calls).toBe(1);
    expect((await pool.query("SELECT state FROM agents_platform.channel_outbound WHERE member_link_id=$1", [challenge.id])).rows[0].state).toBe("read");
  });

  it("acknowledges an invalid private Telegram approval as rejected without retrying it", async () => {
    const f = await fixture(), challenge = await pending(f);
    await members.confirm(f.scope, challenge.id);
    const acknowledgments: string[] = [];
    const delivery = worker(async () => { throw Error("Unexpected message send"); }, undefined, acknowledgments);
    const callback = event(f.connection.assetId, "", { kind: "interaction", interaction: `member:a:${randomUUID()}`, callbackQueryId: "invalid-callback" });
    expect(await delivery.persist("telegram", [callback])).toBe(1);
    await delivery.drain(4);
    await delivery.drain(4);
    expect(acknowledgments).toEqual(["rejected"]);
    expect((await pool.query("SELECT state FROM agents_platform.channel_ingress WHERE connection_id=$1 AND event_id=$2", [f.connection.id, callback.eventId])).rows[0].state).toBe("completed");
  });

  it("keeps a stale review authority race from starving another organization's queued delivery", async () => {
    const stale = await fixture(), staleChallenge = await pending(stale);
    await members.confirm(stale.scope, staleChallenge.id);
    const healthy = await fixture(), healthyChallenge = await pending(healthy);
    await members.confirm(healthy.scope, healthyChallenge.id);
    await queue(healthy, healthyChallenge.id, 1);
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2", [stale.scope.organizationId, stale.scope.accountId]);
    // Reproduce a review selected immediately before membership revocation; all subsequent authority and send queries use PostgreSQL.
    const snapshot = vi.spyOn(pool, "query").mockResolvedValueOnce({ rows: [{ link_id: staleChallenge.id }], rowCount: 1 } as never);
    let calls = 0;
    try {
      await worker(async () => { calls++; return Response.json({ ok: true, result: { message_id: 555 } }); }).drain(4);
    } finally { snapshot.mockRestore(); }
    expect(calls).toBe(1);
    expect((await pool.query("SELECT state FROM agents_platform.channel_outbound WHERE member_link_id=$1", [healthyChallenge.id])).rows[0].state).toBe("accepted");
  });

  it("delivers an exact operation/destination prompt and accepts only its bound Telegram callback", async () => {
    const f = await reviewFixture();
    await f.delivery.drain(4);
    const outbound = (await pool.query("SELECT * FROM agents_platform.channel_outbound WHERE member_link_id=$1 AND member_notice_key=$2", [f.challenge.id, `review:${f.review.id}`])).rows[0];
    expect(outbound.state).toBe("accepted");
    expect(outbound.request.text).toContain("record_request");
    expect(outbound.request.text).toContain("Review destination");
    expect(outbound.request.text).toContain(f.endpoint);
    expect(outbound.request.text).toContain("Approved payload");
    const callback = event(f.connection.assetId, "", { kind: "interaction", interaction: `member:a:${f.review.id}`, providerMessageId: "888", callbackQueryId: "valid-review" });
    expect(await f.delivery.persist("telegram", [callback])).toBe(1);
    await f.delivery.drain(4);
    expect((await f.reviews.list(f.scope, f.task.id))[0]?.state).toBe("approved");
    expect(await f.delivery.persist("telegram", [callback])).toBe(0);
    await f.delivery.drain(4);
    expect((await f.reviews.list(f.scope, f.task.id))[0]?.state).toBe("approved");
  });

  it.each(["actor", "chat", "root", "generation", "digest", "expiry", "prompt"] as const)("rejects a Telegram approval with mismatched %s authority", async mismatch => {
    const f = await reviewFixture();
    await f.delivery.drain(4);
    if (mismatch === "root") await pool.query("UPDATE agents_platform.channel_outbound SET member_task_id=NULL WHERE member_link_id=$1", [f.challenge.id]);
    if (mismatch === "generation") await pool.query("UPDATE agents_platform.member_channel_tasks SET link_generation=2 WHERE task_id=$1", [f.task.id]);
    if (mismatch === "digest") await pool.query("UPDATE agents_platform.channel_outbound SET request=jsonb_set(request,'{memberReview,digest}',to_jsonb($2::text)) WHERE member_link_id=$1", [f.challenge.id, "0".repeat(64)]);
    if (mismatch === "expiry") await pool.query("UPDATE agents_platform.tool_invocation_reviews SET expires_at=now()-interval '1 second' WHERE id=$1", [f.review.id]);
    const callback = event(f.connection.assetId, "", { kind: "interaction", interaction: `member:a:${f.review.id}`, providerMessageId: mismatch === "prompt" ? "999" : "888", callbackQueryId: "mismatched-review",
      ...(mismatch === "actor" ? { senderId: "9999" } : {}), ...(mismatch === "chat" ? { externalConversationId: "9999" } : {}) });
    const count = await f.delivery.persist("telegram", [callback]);
    expect(count).toBe(["actor", "chat"].includes(mismatch) ? 0 : 1);
    await f.delivery.drain(4);
    expect((await pool.query("SELECT state FROM agents_platform.tool_invocation_reviews WHERE id=$1", [f.review.id])).rows[0].state).toBe("pending");
  });

  it("accepts the linked WhatsApp member's exact reviewed action through the real decision store", async () => {
    const f = await reviewFixture("whatsapp");
    await f.delivery.drain(4);
    const callback = event(f.connection.assetId, "", { kind: "interaction", interaction: `member:a:${f.review.id}`, providerMessageId: "wamid.member-reply" });
    expect(await f.delivery.persist("whatsapp", [callback])).toBe(1);
    await f.delivery.drain(4);
    expect((await f.reviews.list(f.scope, f.task.id))[0]?.state).toBe("approved");
  });

  it("keeps a WhatsApp approval exceeding 1024 characters in the app without unusable buttons", async () => {
    const f = await reviewFixture("whatsapp", "x".repeat(1100));
    await f.delivery.drain(4);
    const outbound = (await pool.query("SELECT * FROM agents_platform.channel_outbound WHERE member_link_id=$1 AND member_notice_key=$2", [f.challenge.id, `review:${f.review.id}`])).rows[0];
    expect(outbound.state).toBe("accepted");
    expect(outbound.request.text).toBe("Action requires review. Open the app to continue.");
    expect(outbound.request.buttons).toBeUndefined();
    expect(outbound.request.memberReview).toBeUndefined();
    const callback = event(f.connection.assetId, "", { kind: "interaction", interaction: `member:a:${f.review.id}`, providerMessageId: "wamid.forged-button" });
    await f.delivery.persist("whatsapp", [callback]);
    await f.delivery.drain(4);
    expect((await f.reviews.list(f.scope, f.task.id))[0]?.state).toBe("pending");
  });

  it("excludes a real pending review after member revocation without starving another organization's send", async () => {
    const stale = await reviewFixture();
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2", [stale.scope.organizationId, stale.scope.accountId]);
    const healthy = await fixture(), healthyChallenge = await pending(healthy);
    await members.confirm(healthy.scope, healthyChallenge.id);
    await queue(healthy, healthyChallenge.id, 1);
    let calls = 0;
    await worker(async () => { calls++; return Response.json({ ok: true, result: { message_id: 555 } }); }).drain(4);
    expect(calls).toBe(1);
    expect((await pool.query("SELECT state FROM agents_platform.channel_outbound WHERE member_link_id=$1", [healthyChallenge.id])).rows[0].state).toBe("accepted");
    expect((await pool.query("SELECT id FROM agents_platform.channel_outbound WHERE member_link_id=$1", [stale.challenge.id])).rowCount).toBe(0);
  });

  it.each(["membership", "revision", "credential_revision", "disconnect"] as const)("requires fresh pairing after %s authority is restored", async change => {
    const f = await reviewFixture();
    await queue(f, f.challenge.id, 1);
    if (change === "membership") {
      await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2", [f.scope.organizationId, f.scope.accountId]);
      await pool.query("UPDATE agents_platform.memberships SET revoked_at=NULL WHERE organization_id=$1 AND account_id=$2", [f.scope.organizationId, f.scope.accountId]);
    } else if (change === "disconnect") {
      await pool.query("UPDATE agents_platform.channel_connections SET state='disconnected' WHERE id=$1", [f.connection.id]);
      await pool.query("UPDATE agents_platform.channel_connections SET state='active' WHERE id=$1", [f.connection.id]);
    } else {
      await pool.query(`UPDATE agents_platform.channel_connections SET ${change}=${change}+1 WHERE id=$1`, [f.connection.id]);
      await pool.query("UPDATE agents_platform.channel_connections SET state='active' WHERE id=$1", [f.connection.id]);
    }
    const prior = (await pool.query("SELECT state,generation,challenge_hash FROM agents_platform.member_channel_links WHERE id=$1", [f.challenge.id])).rows[0];
    expect(prior).toEqual({ state: "revoked", generation: 2, challenge_hash: null });
    expect(await route(f.connection.id, event(f.connection.assetId))).toEqual({ consumed: true });
    await expect(members.confirm(f.scope, f.challenge.id)).rejects.toMatchObject({ code: "MEMBER_CHANNEL_DENIED" });
    expect((await pool.query("SELECT g.revoked_at FROM agents_platform.tasks t JOIN agents_platform.execution_grants g ON g.id=t.grant_id WHERE t.id=$1", [f.task.id])).rows[0].revoked_at).toBeInstanceOf(Date);
    expect((await pool.query("SELECT state FROM agents_platform.channel_outbound WHERE member_link_id=$1", [f.challenge.id])).rows[0].state).toBe("suppressed");
    const fresh = await pending(f);
    await members.confirm(f.scope, fresh.id);
    expect(fresh.id).not.toBe(f.challenge.id);
    expect(await route(f.connection.id, event(f.connection.assetId))).toEqual({ consumed: false, linkId: fresh.id });
    expect((await pool.query("SELECT state FROM agents_platform.member_channel_links WHERE id=$1", [f.challenge.id])).rows[0].state).toBe("revoked");
  });

  it("records late WhatsApp delivery facts after unlink without restoring private execution access", async () => {
    const f = await reviewFixture("whatsapp");
    await f.delivery.drain(4);
    expect((await pool.query("SELECT state FROM agents_platform.channel_outbound WHERE member_link_id=$1", [f.challenge.id])).rows[0].state).toBe("accepted");
    const before = (await pool.query("SELECT count(*)::int count FROM agents_platform.execution_grants WHERE organization_id=$1", [f.scope.organizationId])).rows[0].count;
    await members.revoke(f.scope, f.challenge.id);
    const previous = process.env.AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS;
    process.env.AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS = "";
    try {
      for (const [status, expected] of [["delivered", "delivered"], ["read", "read"], ["failed", "read"]]) {
        const receipt = event(f.connection.assetId, "", { kind: "receipt", status, providerMessageId: "wamid.review" });
        expect(await f.delivery.persist("whatsapp", [receipt])).toBe(1);
        await f.delivery.drain(4);
        expect((await pool.query("SELECT state,attempts FROM agents_platform.channel_outbound WHERE member_link_id=$1", [f.challenge.id])).rows[0]).toEqual({ state: expected, attempts: 1 });
      }
      expect(await f.delivery.persist("whatsapp", [event(f.connection.assetId, "Private access must remain revoked")])).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS;
      else process.env.AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS = previous;
    }
    expect((await pool.query("SELECT status FROM agents_platform.channel_receipts WHERE connection_id=$1 ORDER BY created_at", [f.connection.id])).rows.map(row => row.status)).toEqual(["delivered", "read", "failed"]);
    expect((await pool.query("SELECT state FROM agents_platform.member_channel_links WHERE id=$1", [f.challenge.id])).rows[0].state).toBe("revoked");
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.execution_grants WHERE organization_id=$1", [f.scope.organizationId])).rows[0].count).toBe(before);
    expect((await pool.query("SELECT g.revoked_at FROM agents_platform.tasks t JOIN agents_platform.execution_grants g ON g.id=t.grant_id WHERE t.id=$1", [f.task.id])).rows[0].revoked_at).toBeInstanceOf(Date);
    expect((await pool.query("SELECT id FROM agents_platform.customer_conversations WHERE organization_id=$1", [f.scope.organizationId])).rowCount).toBe(0);
    expect((await pool.query("SELECT id FROM agents_platform.tasks WHERE organization_id=$1", [f.scope.organizationId])).rowCount).toBe(1);
  });

  it("replays a private receipt that arrived before the send response attached its provider ID", async () => {
    const f = await fixture("whatsapp"), challenge = await pending(f);
    await members.confirm(f.scope, challenge.id);
    await pool.query("UPDATE agents_platform.member_channel_links SET latest_inbound_at=now() WHERE id=$1", [challenge.id]);
    await queue(f, challenge.id, 1);
    let calls = 0;
    const delivery = worker(async () => {
      calls++;
      const receipt = event(f.connection.assetId, "", { kind: "receipt", status: "delivered", providerMessageId: "wamid.early" });
      expect(await delivery.persist("whatsapp", [receipt])).toBe(1);
      await delivery.drain(4);
      expect((await pool.query("SELECT state,provider_message_id FROM agents_platform.channel_outbound WHERE member_link_id=$1", [challenge.id])).rows[0]).toEqual({ state: "sending", provider_message_id: null });
      return Response.json({ messages: [{ id: "wamid.early" }] });
    });
    await delivery.drain(4);
    expect(calls).toBe(1);
    expect((await pool.query("SELECT state,provider_message_id FROM agents_platform.channel_outbound WHERE member_link_id=$1", [challenge.id])).rows[0]).toEqual({ state: "delivered", provider_message_id: "wamid.early" });
  });

  it("keeps receipt identities attached to the original delivery across unlink and fresh pairing", async () => {
    const f = await reviewFixture("whatsapp");
    await f.delivery.drain(4);
    const delivered = event(f.connection.assetId, "", { kind: "receipt", status: "delivered", providerMessageId: "wamid.review" });
    expect(await f.delivery.persist("whatsapp", [delivered])).toBe(1);
    await f.delivery.drain(4);
    await members.revoke(f.scope, f.challenge.id);
    const fresh = await pending(f);
    await members.confirm(f.scope, fresh.id);
    const read = event(f.connection.assetId, "", { kind: "receipt", status: "read", providerMessageId: "wamid.review" });
    expect(await f.delivery.persist("whatsapp", [delivered, read])).toBe(1);
    await f.delivery.drain(4);
    expect((await pool.query("SELECT member_link_id,event_id FROM agents_platform.channel_ingress WHERE connection_id=$1 AND event_id=ANY($2::text[]) ORDER BY event_id", [f.connection.id, [delivered.eventId, read.eventId]])).rows)
      .toEqual([delivered.eventId, read.eventId].sort().map(eventId => ({ member_link_id: f.challenge.id, event_id: eventId })));
    expect((await pool.query("SELECT state,attempts FROM agents_platform.channel_outbound WHERE member_link_id=$1", [f.challenge.id])).rows[0]).toEqual({ state: "read", attempts: 1 });
    expect((await pool.query("SELECT id FROM agents_platform.channel_outbound WHERE member_link_id=$1", [fresh.id])).rowCount).toBe(0);
    expect((await pool.query("SELECT id FROM agents_platform.tasks WHERE organization_id=$1", [f.scope.organizationId])).rowCount).toBe(1);
    expect((await pool.query("SELECT id FROM agents_platform.customer_conversations WHERE organization_id=$1", [f.scope.organizationId])).rowCount).toBe(0);
    expect(await route(f.connection.id, event(f.connection.assetId))).toEqual({ consumed: false, linkId: fresh.id });
  });
});
