import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { telegramAdapter } from "../src/adapters/channels/telegram/adapter";
import { whatsappAdapter } from "../src/adapters/channels/whatsapp/adapter";
import { ChannelAdapterError, type ChannelProviderContext } from "../src/contracts/channel-adapters";

const telegram = (fetch = vi.fn<typeof globalThis.fetch>()): ChannelProviderContext => ({ credential: "123:synthetic_secret", fetch });
const whatsapp = (fetch = vi.fn<typeof globalThis.fetch>()): ChannelProviderContext => ({ credential: "synthetic-whatsapp-token", apiVersion: "v24.0", fetch });
const tgMessage = { update_id: 17, message: { message_id: 23, date: 1710000000, chat: { id: -42 }, from: { id: 7 }, text: "Hello", reply_to_message: { message_id: 22 } } };
const waPayload = (value: unknown) => ({ object: "whatsapp_business_account", entry: [{ id: "waba", changes: [{ field: "messages", value: { metadata: { phone_number_id: "123" }, ...value as object } }] }] });
const tgRequest = { assetId: "123", recipientId: "-42", text: "Hello", replyToProviderMessageId: "22" };
const waRequest = { assetId: "123", recipientId: "27820000000", text: "Hello", replyToProviderMessageId: "wamid.previous" };

it.each(["telegram", "whatsapp"] as const)("does not dispatch a pre-cancelled %s request", async kind => {
  const fetch = vi.fn<typeof globalThis.fetch>(), controller = new AbortController(); controller.abort();
  const adapter = kind === "telegram" ? telegramAdapter : whatsappAdapter, context = kind === "telegram" ? telegram(fetch) : whatsapp(fetch);
  await expect(adapter.send(kind === "telegram" ? tgRequest : waRequest, { ...context, signal: controller.signal })).rejects.toMatchObject({ outcome: "rejected", status: 409 });
  expect(fetch).not.toHaveBeenCalled();
});

describe("Telegram native adapter", () => {
  it("requires the configured secret header, including case-insensitive names", () => {
    telegramAdapter.verifyWebhook({ rawBody: new Uint8Array(), headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" }, secrets: { webhookSecret: "secret" } });
    for (const secrets of [{}, { webhookSecret: "other" }]) expect(() => telegramAdapter.verifyWebhook({ rawBody: new Uint8Array(), headers: { "x-telegram-bot-api-secret-token": "secret" }, secrets })).toThrow(ChannelAdapterError);
  });
  it("retains stable update/chat/message identities and requires a trusted bot asset", () => {
    const context = { assetId: "123" }, events = telegramAdapter.normalize(tgMessage, context);
    expect(events).toEqual(telegramAdapter.normalize(tgMessage, context));
    expect(events[0]).toMatchObject({ assetId: "123", eventId: "17", externalConversationId: "-42", senderId: "7", providerMessageId: "23", text: "Hello", replyToProviderMessageId: "22", echo: false });
    expect(() => telegramAdapter.normalize(tgMessage)).toThrowError("TELEGRAM_ASSET_REQUIRED");
    expect(() => telegramAdapter.normalize({ ...tgMessage, update_id: Number.MAX_SAFE_INTEGER + 1 }, context)).toThrow(ChannelAdapterError);
    expect(telegramAdapter.normalize(null, context)).toEqual([]);
  });
  it("normalizes callback data, bot echoes and provider media without exposing a token URL", () => {
    expect(telegramAdapter.normalize({ update_id: 18, callback_query: { id: "callback", from: { id: 7 }, data: "approve", message: tgMessage.message } }, { assetId: "123" })[0]).toMatchObject({ kind: "interaction", interaction: "approve" });
    expect(telegramAdapter.normalize({ update_id: 19, message: { ...tgMessage.message, text: undefined, from: { id: 123, is_bot: true }, photo: [{ file_id: "small" }, { file_id: "large" }] } }, { assetId: "123" })[0]).toMatchObject({ echo: true, attachments: [{ kind: "image", providerMediaId: "large" }] });
  });
  it("sends one plain text effect with reply identity and no hidden fallback", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ ok: true, result: { message_id: 55 } }));
    await expect(telegramAdapter.send(tgRequest, telegram(fetch))).resolves.toEqual({ providerMessageId: "55", status: "accepted" });
    expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]![0]).toBe("https://api.telegram.org/bot123:synthetic_secret/sendMessage");
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ chat_id: "-42", text: "Hello", reply_parameters: { message_id: 22, allow_sending_without_reply: false } });
  });
  it.each([["image", "sendPhoto", "photo"], ["audio", "sendAudio", "audio"], ["video", "sendVideo", "video"], ["document", "sendDocument", "document"]] as const)("sends one %s using its native method", async (kind, method, field) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ ok: true, result: { message_id: 56 } }));
    await telegramAdapter.send({ ...tgRequest, attachments: [{ kind, providerMediaId: "file-id" }] }, telegram(fetch));
    expect(String(fetch.mock.calls[0]![0]).endsWith(`/${method}`)).toBe(true); expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))[field]).toBe("file-id"); expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects unsupported batches, unsafe reply IDs and oversized messages before I/O", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const request of [{ ...tgRequest, text: "x".repeat(4097) }, { ...tgRequest, replyToProviderMessageId: "99999999999999999999" },
      { ...tgRequest, attachments: [{ kind: "image" as const, providerMediaId: "a" }, { kind: "image" as const, providerMediaId: "b" }] }]) await expect(telegramAdapter.send(request, telegram(fetch))).rejects.toMatchObject({ outcome: "rejected" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("distinguishes provider rejection, missing receipts and network uncertainty without retaining credential-bearing errors", async () => {
    const limited = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ ok: false, error_code: 429, parameters: { retry_after: 3 }, description: "private" }, { status: 429 }));
    await expect(telegramAdapter.send(tgRequest, telegram(limited))).rejects.toMatchObject({ outcome: "rejected", retryAfterMs: 3000 }); expect(limited).toHaveBeenCalledOnce();
    const serverFailure = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ ok: false, error_code: 400 }, { status: 500 }));
    await expect(telegramAdapter.send(tgRequest, telegram(serverFailure))).rejects.toMatchObject({ outcome: "unknown", status: 500 });
    for (const body of [{ ok: true, result: {} }, { malformed: true }]) await expect(telegramAdapter.send(tgRequest, telegram(vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(body))))).rejects.toMatchObject({ outcome: "unknown" });
    const broken = vi.fn<typeof globalThis.fetch>().mockRejectedValue(Error("https://api.telegram.org/bot123:synthetic_secret/sendMessage"));
    const error = await telegramAdapter.send(tgRequest, telegram(broken)).catch(error => error);
    expect(error).toMatchObject({ outcome: "unknown" }); expect(String(error)).not.toMatch(/synthetic_secret|https:/); expect(error).not.toHaveProperty("cause"); expect(broken).toHaveBeenCalledOnce();
  });
});

describe("WhatsApp native adapter", () => {
  it("verifies exact raw bytes and a nonempty subscription challenge token", () => {
    const rawBody = Buffer.from('{"entry":[]}'), signature = `sha256=${createHmac("sha256", "secret").update(rawBody).digest("hex")}`;
    whatsappAdapter.verifyWebhook({ rawBody, headers: { "x-hub-signature-256": signature }, secrets: { appSecret: "secret" } });
    expect(() => whatsappAdapter.verifyWebhook({ rawBody: Buffer.from("{}"), headers: { "x-hub-signature-256": signature }, secrets: { appSecret: "secret" } })).toThrow(ChannelAdapterError);
    expect(whatsappAdapter.verifyChallenge!({ "hub.mode": "subscribe", "hub.verify_token": "verify", "hub.challenge": "challenge" }, "verify")).toBe("challenge");
    expect(() => whatsappAdapter.verifyChallenge!({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "challenge" }, "")).toThrow(ChannelAdapterError);
  });
  it("normalizes text, media, interaction and distinct stable delivery receipts", () => {
    const payload = waPayload({ messages: [{ id: "wamid.a", from: "2782", timestamp: "1710000000", type: "text", text: { body: "Hello" }, context: { id: "wamid.prior" } },
      { id: "wamid.b", from: "2782", type: "document", document: { id: "media", mime_type: "application/pdf", filename: "a.pdf", caption: "Read" } },
      { id: "wamid.c", from: "2782", type: "interactive", interactive: { button_reply: { id: "approve", title: "Approve" } } }],
      statuses: [{ id: "wamid.out", recipient_id: "2782", status: "delivered", timestamp: "1710000001" }, { id: "wamid.out", recipient_id: "2782", status: "read", timestamp: "1710000002" }] });
    const events = whatsappAdapter.normalize(payload); expect(events).toEqual(whatsappAdapter.normalize(payload)); expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({ assetId: "123", eventId: "wamid.a", externalConversationId: "2782", replyToProviderMessageId: "wamid.prior", text: "Hello" });
    expect(events[1]).toMatchObject({ attachments: [{ kind: "document", providerMediaId: "media", fileName: "a.pdf" }] });
    expect(events[2]).toMatchObject({ kind: "interaction", interaction: "approve" });
    expect(events[3]!.eventId).not.toBe(events[4]!.eventId); expect(events[3]).toMatchObject({ kind: "receipt", status: "delivered", providerMessageId: "wamid.out" });
  });
  it("normalizes echoes and rejects known messages lacking stable IDs or mismatched assets", () => {
    expect(whatsappAdapter.normalize(waPayload({ message_echoes: [{ id: "wamid.echo", from: "business", to: "2782", type: "text", text: { body: "Outbound" } }] }))[0]).toMatchObject({ echo: true, externalConversationId: "2782" });
    expect(() => whatsappAdapter.normalize(waPayload({ messages: [{ from: "2782", type: "text", text: { body: "No id" } }] }))).toThrow(ChannelAdapterError);
    expect(() => whatsappAdapter.normalize(waPayload({ messages: [] }), { assetId: "foreign" })).toThrowError("WHATSAPP_ASSET_MISMATCH");
    expect(whatsappAdapter.normalize(null)).toEqual([]);
  });
  it("sends text, reply identity and only the explicitly configured API version", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ messages: [{ id: "wamid.sent" }] }));
    await expect(whatsappAdapter.send(waRequest, whatsapp(fetch))).resolves.toEqual({ providerMessageId: "wamid.sent", status: "accepted" });
    expect(fetch.mock.calls[0]![0]).toBe("https://graph.facebook.com/v24.0/123/messages");
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ messaging_product: "whatsapp", to: "27820000000", context: { message_id: "wamid.previous" }, type: "text", text: { body: "Hello" } });
    expect(fetch.mock.calls[0]![1]?.headers).toMatchObject({ authorization: "Bearer synthetic-whatsapp-token" });
    await expect(whatsappAdapter.send(waRequest, { ...whatsapp(fetch), apiVersion: undefined })).rejects.toMatchObject({ code: "WHATSAPP_VERSION_REQUIRED" }); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["image", "audio", "video", "document"] as const)("sends one %s without another provider effect", async kind => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ messages: [{ id: "wamid.media" }] }));
    await whatsappAdapter.send({ ...waRequest, text: kind === "audio" ? "" : "Caption", attachments: [{ kind, providerMediaId: "media", fileName: "a.pdf" }] }, whatsapp(fetch));
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ type: kind, [kind]: { id: "media" } }); expect(fetch).toHaveBeenCalledOnce();
  });
  it("sends a template and rejects attachment batches or silently discarded audio captions", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ messages: [{ id: "wamid.template" }] }));
    await whatsappAdapter.send({ ...waRequest, text: "", template: { name: "booking_confirmation", language: "en_US", components: [{ type: "body", parameters: [{ type: "text", text: "Jane" }] }] } }, whatsapp(fetch));
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ type: "template", template: { name: "booking_confirmation", language: { code: "en_US" } } });
    await expect(whatsappAdapter.send({ ...waRequest, attachments: [{ kind: "audio", providerMediaId: "a" }] }, whatsapp(fetch))).rejects.toMatchObject({ outcome: "rejected" });
    await expect(whatsappAdapter.send({ ...waRequest, attachments: [{ kind: "image", providerMediaId: "a" }, { kind: "video", providerMediaId: "b" }] }, whatsapp(fetch))).rejects.toMatchObject({ outcome: "rejected" }); expect(fetch).toHaveBeenCalledOnce();
  });
  it("never retries rejected, malformed-success or lost-acknowledgement requests", async () => {
    for (const [status, outcome] of [[401, "rejected"], [429, "rejected"], [500, "unknown"]] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("private provider error", { status, headers: { "retry-after": "3" } }));
      await expect(whatsappAdapter.send(waRequest, whatsapp(fetch))).rejects.toMatchObject({ outcome, status, retryAfterMs: 3000 }); expect(fetch).toHaveBeenCalledOnce();
    }
    for (const body of [{ messages: [] }, { messages: [{}] }]) await expect(whatsappAdapter.send(waRequest, whatsapp(vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(body))))).rejects.toMatchObject({ outcome: "unknown" });
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(Error("private token"));
    const error = await whatsappAdapter.send(waRequest, whatsapp(fetch)).catch(error => error); expect(error).toMatchObject({ outcome: "unknown" }); expect(String(error)).not.toContain("private token"); expect(fetch).toHaveBeenCalledOnce();
  });
});
