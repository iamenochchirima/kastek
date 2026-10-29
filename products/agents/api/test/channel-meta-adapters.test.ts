import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { facebookChannelAdapter, instagramChannelAdapter } from "../src/adapters/channels/meta";
import { ChannelAdapterError, type ChannelProviderAdapter, type ChannelProviderContext } from "../src/contracts/channel-adapters";

const event = (value: object = {}) => ({ sender: { id: "customer" }, recipient: { id: "asset" }, timestamp: 1700000000000, ...value });
const envelope = (kind: "facebook" | "instagram", ...events: object[]) => ({ object: kind === "facebook" ? "page" : "instagram", entry: [{ id: "asset", messaging: events }] });
const request = { assetId: "asset", recipientId: "customer", text: "Hello" };
function context(overrides: Partial<ChannelProviderContext> = {}, response = Response.json({ recipient_id: "customer", message_id: "accepted-message" })) {
  const fetch = vi.fn(async () => response);
  return { context: { credential: "private-fixture-credential", mode: "meta" as const, apiVersion: "v99.0", fetch, ...overrides }, fetch };
}

describe("Meta signed webhook boundary", () => {
  it("verifies the original bytes and configured app secret, including header casing", () => {
    const rawBody = Buffer.from('{ "object": "page", "entry": [] }'), secret = "private-signing-fixture";
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    expect(() => facebookChannelAdapter.verifyWebhook({ rawBody, headers: { "X-Hub-Signature-256": signature }, secrets: { appSecret: secret } })).not.toThrow();
    expect(() => instagramChannelAdapter.verifyWebhook({ rawBody, headers: { "x-hub-signature-256": signature }, secrets: { appSecret: secret } })).not.toThrow();
    for (const changed of [Buffer.from('{}'), Buffer.from('{"object":"page","entry":[]}')]) expect(() => facebookChannelAdapter.verifyWebhook({ rawBody: changed, headers: { "x-hub-signature-256": signature }, secrets: { appSecret: secret } })).toThrow(ChannelAdapterError);
    for (const value of [undefined, "sha1=123", "sha256=", `sha256=${"g".repeat(64)}`, `sha256=${"0".repeat(64)}`]) expect(() => facebookChannelAdapter.verifyWebhook({ rawBody, headers: { "x-hub-signature-256": value }, secrets: { appSecret: secret } })).toThrow(ChannelAdapterError);
    expect(() => facebookChannelAdapter.verifyWebhook({ rawBody, headers: { "x-hub-signature-256": signature }, secrets: {} })).toThrow(ChannelAdapterError);
  });
  it("returns only an authenticated challenge and never accepts an empty verification token", () => {
    const query = { "hub.mode": "subscribe", "hub.verify_token": "fixture", "hub.challenge": "challenge-value" };
    expect(facebookChannelAdapter.verifyChallenge!(query, "fixture")).toBe("challenge-value");
    for (const invalid of [{ ...query, "hub.mode": "other" }, { ...query, "hub.verify_token": "wrong" }, { ...query, "hub.challenge": "" }]) expect(() => instagramChannelAdapter.verifyChallenge!(invalid, "fixture")).toThrow(ChannelAdapterError);
    expect(() => facebookChannelAdapter.verifyChallenge!({ ...query, "hub.verify_token": "" }, "")).toThrow(ChannelAdapterError);
  });
});

for (const adapter of [facebookChannelAdapter, instagramChannelAdapter]) describe(`${adapter.kind} canonical webhook events`, () => {
  const kind = adapter.kind as "facebook" | "instagram";
  it("preserves asset/customer scope, Unicode text, replies, attachments and exact provider IDs", () => {
    const input = envelope(kind, event({ message: { mid: "mid-a", text: "Hello 🌍", reply_to: { mid: "original" }, attachments: [{ type: "image", payload: { id: "image-1", url: "https://cdn.example.test/photo.jpg" } }, { type: "file", payload: { id: "doc-1", filename: "receipt.pdf", mime_type: "application/pdf" } }] } }));
    const [normalized] = adapter.normalize(input);
    expect(normalized).toMatchObject({ kind: "message", assetId: "asset", externalConversationId: "asset:customer", senderId: "customer", providerMessageId: "mid-a", text: "Hello 🌍", echo: false, replyToProviderMessageId: "original", occurredAt: "2023-11-14T22:13:20.000Z" });
    expect(normalized!.attachments).toEqual([{ kind: "image", providerMediaId: "image-1", url: "https://cdn.example.test/photo.jpg" }, { kind: "document", providerType: "file", providerMediaId: "doc-1", mimeType: "application/pdf", fileName: "receipt.pdf" }]);
    expect(adapter.normalize(input)).toEqual(adapter.normalize(input));
    expect(adapter.normalize({ ...input, entry: [{ id: "other", messaging: [event({ recipient: { id: "other" }, message: { mid: "mid-a", text: "Hello" } })] }] })[0]!.eventId).not.toBe(normalized!.eventId);
  });
  it("does not reinterpret business echoes as customer input or accept mismatched entry assets", () => {
    const [echo] = adapter.normalize(envelope(kind, event({ sender: { id: "asset" }, recipient: { id: "customer" }, message: { mid: "echo-a", text: "Human reply", is_echo: true } })));
    expect(echo).toMatchObject({ externalConversationId: "asset:customer", senderId: "asset", echo: true });
    expect(adapter.normalize(envelope(kind, event({ recipient: { id: "another-asset" }, message: { mid: "for-other", text: "wrong asset" } })))).toEqual([]);
  });
  it("retains watermark-only reads and delivery/read IDs without generating new receipt timestamps", () => {
    const events = adapter.normalize(envelope(kind, event({ delivery: { mids: ["one", "two", "one"], watermark: 1700000000000 } }), event({ read: { watermark: "1700000000001" } }), event({ read: { mid: "two" } })));
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ kind: "receipt", status: "delivered", providerMessageId: "one", receiptWatermark: "1700000000000" });
    expect(events[2]).toMatchObject({ kind: "receipt", status: "read", providerMessageId: null, receiptWatermark: "1700000000001" });
    expect(events[3]).toMatchObject({ status: "read", providerMessageId: "two" });
    expect(new Set(events.map(value => value.eventId)).size).toBe(4);
  });
  it("preserves reactions/postbacks/deletions and shared-only media as distinct interactions", () => {
    const events = adapter.normalize(envelope(kind, event({ reaction: { mid: "reacted", action: "unreact", reaction: "❤" } }), event({ postback: { mid: "post", payload: "help", title: "Help" } }), event({ message: { mid: "deleted", is_deleted: true, text: "Removed" } }), event({ message: { mid: "shared", attachments: [{ type: "share", payload: { url: "https://instagram.com/p/example" } }] } })));
    expect(events.map(value => value.kind)).toEqual(["interaction", "interaction", "interaction", "interaction"]);
    expect(JSON.parse(events[0]!.interaction!)).toEqual({ type: "reaction", action: "unreact", emoji: "❤" });
    expect(JSON.parse(events[2]!.interaction!).type).toBe("message_deleted");
    expect(events[3]!.interaction).toContain("https://instagram.com/p/example");
  });
  it("uses stable fallback IDs with missing mid/time and deduplicates sticker/image representations", () => {
    const input = envelope(kind, event({ timestamp: undefined, message: { text: "Text", attachments: [{ type: "image", payload: { url: "https://cdn.example.test/sticker.gif" } }, { type: "sticker", payload: { url: "https://cdn.example.test/sticker.gif", id: "sticker-id" } }] } }));
    const [first] = adapter.normalize(input), [second] = adapter.normalize(JSON.parse(JSON.stringify(input)));
    expect(first!.eventId).toBe(second!.eventId); expect(first!.occurredAt).toBeNull(); expect(first!.providerMessageId).toBeNull();
    expect(first!.attachments).toEqual([{ kind: "image", providerType: "sticker", providerMediaId: "sticker-id", url: "https://cdn.example.test/sticker.gif" }]);
    expect(adapter.normalize({ object: kind === "facebook" ? "instagram" : "page", entry: [] })).toEqual([]);
  });
});

const routes: Array<{ name: string; adapter: ChannelProviderAdapter; mode: ChannelProviderContext["mode"]; pageId?: string; expected: string }> = [
  { name: "Messenger", adapter: facebookChannelAdapter, mode: "meta", expected: "https://graph.facebook.com/v99.0/asset/messages" },
  { name: "Instagram via Page", adapter: instagramChannelAdapter, mode: "meta", pageId: "linked-page", expected: "https://graph.facebook.com/v99.0/linked-page/messages" },
  { name: "Instagram Login", adapter: instagramChannelAdapter, mode: "instagram_login", expected: "https://graph.instagram.com/v99.0/asset/messages" },
];
for (const route of routes) describe(`${route.name} physical send boundary`, () => {
  it("uses the explicit reviewed version, correct identity/token and one HTTP request", async () => {
    const f = context({ mode: route.mode, pageId: route.pageId });
    expect(await route.adapter.send({ ...request, replyToProviderMessageId: "original" }, f.context)).toEqual({ status: "accepted", providerMessageId: "accepted-message" });
    expect(f.fetch).toHaveBeenCalledTimes(1); const [url, init] = f.fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(route.expected); expect(url).not.toContain("private-fixture-credential"); expect(init.redirect).toBe("error"); expect(init.headers).toMatchObject({ authorization: "Bearer private-fixture-credential" });
    const body = JSON.parse(String(init.body)); expect(body).toMatchObject({ recipient: { id: "customer" }, message: { text: "Hello", reply_to: { mid: "original" } } });
    if (route.mode === "instagram_login") expect(body).not.toHaveProperty("messaging_type"); else expect(body.messaging_type).toBe("RESPONSE");
    expect(body).not.toHaveProperty("tag");
  });
  it.each(["image", "audio", "video"] as const)("sends one %s attachment without changing it into a text-only reply", async kind => {
    const f = context({ mode: route.mode, pageId: route.pageId });
    await route.adapter.send({ ...request, text: "", attachments: [{ kind, url: `https://media.example.test/${kind}` }] }, f.context);
    const body = JSON.parse(String((f.fetch.mock.calls[0]! as unknown as [unknown, RequestInit])[1].body));
    expect(body.message).toEqual({ attachment: { type: kind, payload: { url: `https://media.example.test/${kind}` } } }); expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects mixed/multiple effects before dispatch and does not guess a Graph version", async () => {
    const f = context({ mode: route.mode, pageId: route.pageId });
    for (const input of [{ ...request, attachments: [{ kind: "image" as const, url: "https://media.example.test/x" }] }, { ...request, text: "", attachments: [{ kind: "image" as const, url: "https://media.example.test/x" }, { kind: "video" as const, url: "https://media.example.test/y" }] }]) await expect(route.adapter.send(input, f.context)).rejects.toMatchObject({ outcome: "rejected" });
    await expect(route.adapter.send(request, { ...f.context, apiVersion: undefined })).rejects.toMatchObject({ code: "CHANNEL_API_VERSION_REQUIRED" }); expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([[401, "CHANNEL_AUTHENTICATION_FAILED"], [403, "CHANNEL_PERMISSION_DENIED"], [404, "CHANNEL_ASSET_UNAVAILABLE"], [429, "CHANNEL_RATE_LIMITED"]])("classifies HTTP%s without retries or raw provider-error leakage", async (status, code) => {
    const f = context({ mode: route.mode, pageId: route.pageId }, new Response(JSON.stringify({ error: { message: "private-fixture-credential denied" } }), { status: Number(status), headers: { "retry-after": "7" } }));
    const error = await route.adapter.send(request, f.context).catch(error => error);
    expect(error).toMatchObject({ code, outcome: "rejected", retryAfterMs: 7000 }); expect(String(error)).not.toContain("private-fixture-credential"); expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps ambiguous acceptance and network loss unknown and never retries", async () => {
    for (const response of [Response.json({ recipient_id: "customer" }), new Response("not-json"), Response.json({ recipient_id: "another-customer", message_id: "wrong" }), Response.json({ error: { message: "lost" } }, { status: 503 })]) {
      const f = context({ mode: route.mode, pageId: route.pageId }, response), result = await route.adapter.send(request, f.context).catch(error => error);
      expect(result.status === "unknown" || result.outcome === "unknown").toBe(true); expect(f.fetch).toHaveBeenCalledTimes(1);
    }
    const fetch = vi.fn(async () => { throw Error("private-fixture-credential: socket closed"); });
    await expect(route.adapter.send(request, { ...context({ mode: route.mode, pageId: route.pageId }).context, fetch })).rejects.toMatchObject({ code: "CHANNEL_SEND_OUTCOME_UNKNOWN", outcome: "unknown" }); expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Meta media and cancellation distinctions", () => {
  it("serializes HUMAN_AGENT only for an authorized text-only direct-Instagram send", async () => {
    const direct = context({ mode: "instagram_login", messageTag: "HUMAN_AGENT" });
    await instagramChannelAdapter.send(request, direct.context);
    const body = JSON.parse(String((direct.fetch.mock.calls[0]! as unknown as [unknown, RequestInit])[1].body));
    expect(body.tag).toBe("HUMAN_AGENT");
    expect(body).not.toHaveProperty("messaging_type");

    for (const [adapter, mode, pageId] of [
      [facebookChannelAdapter, "meta", undefined],
      [instagramChannelAdapter, "meta", "linked-page"],
    ] as const) {
      const f = context({ mode, pageId, messageTag: "HUMAN_AGENT" });
      await expect(adapter.send(request, f.context)).rejects.toMatchObject({ code: "CHANNEL_MESSAGE_TAG_UNSUPPORTED", outcome: "rejected" });
      expect(f.fetch).not.toHaveBeenCalled();
    }

    const attachment = context({ mode: "instagram_login", messageTag: "HUMAN_AGENT" });
    await expect(instagramChannelAdapter.send({ ...request, text: "", attachments: [{ kind: "image", url: "https://media.example.test/photo.jpg" }] }, attachment.context))
      .rejects.toMatchObject({ code: "CHANNEL_HUMAN_SUPPORT_TEXT_ONLY", outcome: "rejected" });
    expect(attachment.fetch).not.toHaveBeenCalled();

    const untrustedRequest = context({ mode: "instagram_login" });
    await instagramChannelAdapter.send({ ...request, tag: "HUMAN_AGENT" } as typeof request, untrustedRequest.context);
    const untrustedBody = JSON.parse(String((untrustedRequest.fetch.mock.calls[0]! as unknown as [unknown, RequestInit])[1].body));
    expect(untrustedBody).not.toHaveProperty("tag");
  });
  it("supports Messenger files/reusable attachment IDs while rejecting unreviewed Instagram file/reuse variants", async () => {
    const f = context(); await facebookChannelAdapter.send({ ...request, text: "", attachments: [{ kind: "document", providerMediaId: "uploaded-file" }] }, f.context);
    expect(JSON.parse(String((f.fetch.mock.calls[0]! as unknown as [unknown, RequestInit])[1].body)).message.attachment).toEqual({ type: "file", payload: { attachment_id: "uploaded-file" } });
    await expect(instagramChannelAdapter.send({ ...request, text: "", attachments: [{ kind: "document", url: "https://media.example.test/file.pdf" }] }, { ...f.context, pageId: "page" })).rejects.toMatchObject({ code: "CHANNEL_ATTACHMENT_UNSUPPORTED" });
    await expect(instagramChannelAdapter.send({ ...request, text: "", attachments: [{ kind: "image", providerMediaId: "uploaded-file" }] }, { ...f.context, mode: "instagram_login" })).rejects.toMatchObject({ code: "CHANNEL_ATTACHMENT_REUSE_UNSUPPORTED" });
  });
  it("requires the linked Page identity and rejects pre-cancelled sends without any request", async () => {
    const f = context(); await expect(instagramChannelAdapter.send(request, f.context)).rejects.toMatchObject({ code: "CHANNEL_PAGE_BINDING_REQUIRED" });
    await expect(facebookChannelAdapter.send(request, { ...f.context, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "CHANNEL_CANCELLED_BEFORE_DISPATCH", outcome: "rejected" }); expect(f.fetch).not.toHaveBeenCalled();
  });
});
