import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { ChannelStore } from "../src/product/channels/channel-store";
import { WhatsappTemplates, whatsappCustomerServiceWindowMs } from "../src/product/channels/whatsapp-templates";
import { ChannelAttachments } from "../src/product/channels/channel-attachments";
import { ConnectionVault } from "../src/infrastructure/vault";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const definition = () => ({ id: "template-main", name: "appointment_update", language: "en_US", category: "UTILITY", status: "APPROVED", components: [{ type: "BODY", text: "Hello {{1}}, your booking is confirmed." }, { type: "FOOTER", text: "Support team" }] });
(databaseUrl ? describe : describe.skip)("channel template authority and private staff attachments", () => {
  const database = `agents_channel_policy_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, platform: PlatformStore, channels: ChannelStore;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href });
    await setupPlatformSchema(pool); platform = new PlatformStore(pool);
    channels = new ChannelStore(pool, new ConnectionVault("test", { test: randomBytes(32).toString("base64") }));
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  async function fixture(kind: "whatsapp" | "facebook" | "telegram" = "whatsapp", attachment: Record<string, unknown> = { kind: "document", providerMediaId: "media-owned", fileName: "customer.pdf" }) {
    const account = await platform.ensureAccount({ issuer: "https://policy.fixture.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const organization = await platform.createOrganization(account.id, "Channel policy"), scope = { accountId: account.id, organizationId: organization.id };
    const agent = await platform.createConfiguredAgent({ ...scope, name: "Support", offering: "faq" });
    const assetId = String(BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`));
    const connection = await channels.create(scope, { kind, mode: kind === "whatsapp" ? "cloud_api" : kind === "telegram" ? "bot" : "meta", assetId, name: "Customer channel", state: "active",
      credentials: kind === "telegram" ? { botToken: `${assetId}:private-bot` } : { accessToken: "private-provider-token" }, metadata: { apiVersion: "v99.0", wabaId: "waba-owned" } });
    const deployment = await channels.bind(scope, connection.id, { expectedRevision: 1, agentId: agent.agent.id });
    const conversationId = randomUUID(), messageId = randomUUID();
    await pool.query(`INSERT INTO agents_platform.customer_conversations(id,organization_id,agent_id,version_id,channel_kind,channel_deployment_id,external_conversation_id,external_sender_id,state,assignee_account_id)
      VALUES($1,$2,$3,$4,$5,$6,'155500000','155500000','human_owned',$7)`, [conversationId, scope.organizationId, agent.agent.id, deployment.versionId, kind, deployment.id, scope.accountId]);
    await pool.query(`INSERT INTO agents_platform.customer_messages(id,conversation_id,sequence,author_kind,body,request_key,request_digest,ownership_generation)
      VALUES($1,$2,1,'visitor','I agree to booking updates','fixture','fixture',1)`, [messageId, conversationId]);
    await pool.query(`INSERT INTO agents_platform.channel_message_facts(message_id,connection_id,external_conversation_id,provider_message_id,attachments) VALUES($1,$2,'155500000','provider-native',$3)`, [messageId, connection.id, JSON.stringify([attachment])]);
    return { scope, connection, conversationId, messageId, assetId };
  }
  async function optIn(service: WhatsappTemplates, item: Awaited<ReturnType<typeof fixture>>) {
    return service.recordConsent(item.scope, { conversationId: item.conversationId, expectedRevision: "1", expectedConsentRevision: 0, granted: true, categories: ["UTILITY"], evidence: { kind: "customer_message", messageId: item.messageId } });
  }
  it("requires recorded consent, prepares exact approved content and revalidates provider status before dispatch", async () => {
    const item = await fixture(); let current = definition();
    const http = vi.fn<typeof fetch>(async input => { expect(String(input)).toContain("/waba-owned/message_templates"); return json({ data: [current] }); });
    const service = new WhatsappTemplates(channels, http);
    expect(whatsappCustomerServiceWindowMs).toBe(86400000);
    const input = { conversationId: item.conversationId, expectedRevision: "1", templateId: "template-main", parameters: { body: ["Ada"] } };
    await expect(service.prepare(item.scope, input)).rejects.toMatchObject({ code: "WHATSAPP_CUSTOMER_OPT_IN_REQUIRED" });
    await optIn(service, item);
    const prepared = await service.prepare(item.scope, input);
    expect(prepared.preview).toBe("Hello Ada, your booking is confirmed.\n\nSupport team");
    const dispatch = { organizationId: item.scope.organizationId, connectionId: item.connection.id, conversationId: item.conversationId, ownershipGeneration: "1", messageBody: prepared.preview,
      request: { assetId: item.assetId, recipientId: "155500000", text: "", template: prepared.template, templateAuthorization: prepared.authorization } };
    await service.assertDispatch(dispatch);
    current = { ...definition(), status: "PAUSED" };
    await expect(service.assertDispatch(dispatch)).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_NOT_APPROVED" });
    expect(http.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
  it("fences opt-out, template/parameter edits, recipient substitution and stale staff ownership", async () => {
    const item = await fixture(), service = new WhatsappTemplates(channels, vi.fn<typeof fetch>(async () => json({ data: [definition()] })));
    await optIn(service, item);
    const prepared = await service.prepare(item.scope, { conversationId: item.conversationId, expectedRevision: "1", templateId: "template-main", parameters: { body: ["Ada"] } });
    const dispatch = { organizationId: item.scope.organizationId, connectionId: item.connection.id, conversationId: item.conversationId, ownershipGeneration: "1", messageBody: prepared.preview,
      request: { assetId: item.assetId, recipientId: "155500000", text: "", template: prepared.template, templateAuthorization: prepared.authorization } };
    await expect(service.assertDispatch({ ...dispatch, request: { ...dispatch.request, recipientId: "different-recipient" } })).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_AUTHORITY_CHANGED" });
    await expect(service.assertDispatch({ ...dispatch, request: { ...dispatch.request, template: { ...prepared.template, components: [{ type: "body", parameters: [{ type: "text", text: "Different effect" }] }] } } })).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_CHANGED" });
    await service.recordConsent(item.scope, { conversationId: item.conversationId, expectedRevision: "1", expectedConsentRevision: 1, granted: false, categories: ["UTILITY"], evidence: { kind: "external_record", reference: "Customer requested opt-out by phone" } });
    await expect(service.assertDispatch(dispatch)).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_AUTHORITY_CHANGED" });
    await pool.query("UPDATE agents_platform.customer_conversations SET assignee_account_id=NULL WHERE id=$1", [item.conversationId]);
    await expect(service.recordConsent(item.scope, { conversationId: item.conversationId, expectedRevision: "1", expectedConsentRevision: 2, granted: true, categories: ["UTILITY"], evidence: { kind: "customer_message", messageId: item.messageId } })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it("paginates approved templates without following token-bearing next URLs and labels unsupported content", async () => {
    const item = await fixture();
    const http = vi.fn<typeof fetch>(async input => new URL(String(input)).searchParams.has("after")
      ? json({ data: [{ ...definition(), id: "media-template", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Photo" }] }] })
      : json({ data: [{ ...definition(), status: "REJECTED" }, definition()], paging: { next: "https://evil.fixture.test/?token=private", cursors: { after: "next-page" } } }));
    const service = new WhatsappTemplates(channels, http);
    const first = await service.list(item.scope, { connectionId: item.connection.id }); expect(first.templates).toHaveLength(1); expect(first.nextCursor).toBe("next-page");
    const second = await service.list(item.scope, { connectionId: item.connection.id, cursor: first.nextCursor }); expect(second.templates[0]?.supported).toBe(false);
    expect(http.mock.calls.every(([url]) => new URL(String(url)).hostname === "graph.facebook.com")).toBe(true);
  });
  it("downloads canonical WhatsApp media privately and scopes the native media lookup to the phone", async () => {
    const item = await fixture();
    const http = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "graph.facebook.com") { expect(url.searchParams.get("phone_number_id")).toBe(item.assetId); return json({ id: "media-owned", url: "https://cdn.fixture.test/customer.pdf?signature=private", file_size: 3 }); }
      expect(init?.headers).toMatchObject({ authorization: "Bearer private-provider-token" }); return new Response("PDF", { headers: { "content-type": "application/pdf" } });
    });
    const service = new ChannelAttachments(channels, { fetch: http, maximumBytes: 1024, mediaHostSuffixes: ["cdn.fixture.test"] });
    const result = await service.download(item.scope, { conversationId: item.conversationId, messageId: item.messageId, index: 0 });
    expect(result.body.toString()).toBe("PDF"); expect(result.fileName).toBe("customer.pdf"); expect(JSON.stringify(result)).not.toContain("private"); expect(http).toHaveBeenCalledTimes(2);
  });
  it("rejects other-tenant access and malicious private URLs before any download", async () => {
    const item = await fixture("facebook", { kind: "image", url: "https://127.0.0.1/private" }), other = await fixture();
    const http = vi.fn<typeof fetch>(async () => new Response("unexpected"));
    const service = new ChannelAttachments(channels, { fetch: http, maximumBytes: 1024, mediaHostSuffixes: ["fbcdn.net"] });
    await expect(service.download(other.scope, { conversationId: item.conversationId, messageId: item.messageId, index: 0 })).rejects.toMatchObject({ code: "CHANNEL_ATTACHMENT_NOT_FOUND" });
    await expect(service.download(item.scope, { conversationId: item.conversationId, messageId: item.messageId, index: 0 })).rejects.toMatchObject({ code: "CHANNEL_ATTACHMENT_URL_DENIED" });
    expect(http).not.toHaveBeenCalled();
  });
  it("enforces streamed byte limits and blocks active browser content", async () => {
    const item = await fixture("facebook", { kind: "document", url: "https://media.fbcdn.net/file" });
    const large = new ChannelAttachments(channels, { fetch: vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); controller.close(); } }), { headers: { "content-type": "application/pdf" } })), maximumBytes: 8, mediaHostSuffixes: ["fbcdn.net"] });
    await expect(large.download(item.scope, { conversationId: item.conversationId, messageId: item.messageId, index: 0 })).rejects.toMatchObject({ code: "CHANNEL_ATTACHMENT_TOO_LARGE" });
    const html = new ChannelAttachments(channels, { fetch: vi.fn<typeof fetch>(async () => new Response("<script>bad</script>", { headers: { "content-type": "text/html" } })), maximumBytes: 100, mediaHostSuffixes: ["fbcdn.net"] });
    await expect(html.download(item.scope, { conversationId: item.conversationId, messageId: item.messageId, index: 0 })).rejects.toMatchObject({ code: "CHANNEL_ATTACHMENT_CONTENT_UNSUPPORTED" });
  });
  it("rechecks staff membership after download and never forwards credentials to Meta CDN URLs", async () => {
    const item = await fixture("facebook", { kind: "image", url: "https://media.fbcdn.net/image" });
    const http = vi.fn<typeof fetch>(async (_input, init) => { expect(init?.headers).toBeUndefined(); await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1", [item.scope.organizationId]); return new Response("pixels", { headers: { "content-type": "image/png" } }); });
    const service = new ChannelAttachments(channels, { fetch: http, maximumBytes: 1024, mediaHostSuffixes: ["fbcdn.net"] });
    await expect(service.download(item.scope, { conversationId: item.conversationId, messageId: item.messageId, index: 0 })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it("resolves Telegram media by native file ID and rejects traversing provider file paths", async () => {
    const item = await fixture("telegram", { kind: "document", providerMediaId: "tg-file", fileName: "file.txt" });
    const http = vi.fn<typeof fetch>(async () => json({ ok: true, result: { file_id: "tg-file", file_path: "../private", file_size: 5 } }));
    const service = new ChannelAttachments(channels, { fetch: http, maximumBytes: 1024, mediaHostSuffixes: [] });
    await expect(service.download(item.scope, { conversationId: item.conversationId, messageId: item.messageId, index: 0 })).rejects.toMatchObject({ code: "CHANNEL_ATTACHMENT_URL_DENIED" }); expect(http).toHaveBeenCalledTimes(1);
  });
  it("rejects evaluation-only template/media connections before provider I/O", async () => {
    const item = await fixture(), http = vi.fn<typeof fetch>(async () => new Response("must not be called"));
    await pool.query("UPDATE agents_platform.channel_connections SET metadata=metadata||'{\"evaluationFixture\":true,\"evaluationTrialId\":\"fixture-only\"}'::jsonb WHERE id=$1", [item.connection.id]);
    await expect(new WhatsappTemplates(channels, http).list(item.scope, { connectionId: item.connection.id })).rejects.toMatchObject({ code: "CHANNEL_EVALUATION_FIXTURE_LIVE_IO_DENIED" });
    await expect(new ChannelAttachments(channels, { fetch: http, maximumBytes: 1024, mediaHostSuffixes: [] }).download(item.scope, { conversationId: item.conversationId, messageId: item.messageId, index: 0 })).rejects.toMatchObject({ code: "CHANNEL_EVALUATION_FIXTURE_LIVE_IO_DENIED" }); expect(http).not.toHaveBeenCalled();
  });
});
