import { describe, expect, it, vi } from "vitest";
import { TelegramBotClient } from "../src/channels/telegram-client";
import { channelSecretsEqual, hashChannelSecret } from "../src/db/channel-secret-crypto";

describe("Telegram bot client", () => {
  it("validates a bot, registers a webhook, and sends a message", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { id: 123, is_bot: true, first_name: "Kasi", username: "kasi_bot" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 456 } }), { status: 200 }));
    const client = new TelegramBotClient({ apiBaseUrl: "https://telegram.test", fetchImpl });

    await expect(client.getMe("token")).resolves.toMatchObject({ id: 123, username: "kasi_bot" });
    await expect(client.setWebhook("token", "https://core.test/api/webhooks/telegram/connection", "secret")).resolves.toBeUndefined();
    await expect(client.sendMessage("token", "42", "**hello**")).resolves.toEqual({ providerMessageId: "456", status: "sent" });

    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://telegram.test/bottoken/setWebhook", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({ secret_token: "secret", allowed_updates: ["message", "callback_query"] });
    expect(fetchImpl).toHaveBeenNthCalledWith(3, "https://telegram.test/bottoken/sendRichMessage", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toMatchObject({
      chat_id: "42",
      rich_message: { markdown: "**hello**" },
    });
  });

  it("falls back to Telegram HTML when rich messages are unavailable", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: "Method not found" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 457 } }), { status: 200 }));
    const client = new TelegramBotClient({ apiBaseUrl: "https://telegram.test", fetchImpl });

    await expect(client.sendMessage("token", "42", "**hello**")).resolves.toEqual({ providerMessageId: "457", status: "sent" });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://telegram.test/bottoken/sendMessage", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({
      text: "<b>hello</b>",
      parse_mode: "HTML",
    });
  });

  it("sends Markdown image previews as Telegram photos", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 458 } }), { status: 200 }));
    const client = new TelegramBotClient({ apiBaseUrl: "https://telegram.test", fetchImpl });

    await expect(client.sendMessage("token", "42", "Please confirm:\n\n![announcement](https://core.test/api/social/media/asset-1/public?expires=123&signature=abc)"))
      .resolves.toEqual({ providerMessageId: "458", status: "sent" });
    expect(fetchImpl).toHaveBeenCalledWith("https://telegram.test/bottoken/sendPhoto", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      chat_id: "42",
      photo: "https://core.test/api/social/media/asset-1/public?expires=123&signature=abc",
      caption: "Please confirm:",
      parse_mode: "HTML",
    });
  });

  it("sends typed media using Telegram's native media methods", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 459 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 460 } }), { status: 200 }));
    const client = new TelegramBotClient({ apiBaseUrl: "https://telegram.test", fetchImpl });

    await expect(client.sendMediaResponse("token", "42", "See these files", [
      { assetId: "image-1", kind: "image", previewUrl: "https://core.test/image", fileName: "image.png" },
      { assetId: "doc-1", kind: "document", previewUrl: "https://core.test/doc", fileName: "brief.pdf" },
    ])).resolves.toEqual({ providerMessageId: "460", status: "sent" });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://telegram.test/bottoken/sendPhoto", expect.objectContaining({ method: "POST" }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://telegram.test/bottoken/sendDocument", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ photo: "https://core.test/image", caption: "See these files", parse_mode: "HTML" });
  });

  it("sends approval buttons and acknowledges callback clicks", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
    const client = new TelegramBotClient({ apiBaseUrl: "https://telegram.test", fetchImpl });

    await client.sendApprovalPrompt("token", "42", "Approve this action?", { approve: "approve-token", reject: "reject-token" });
    await client.answerCallbackQuery("token", "callback-1", "Approval recorded");

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      rich_message: { markdown: "Approve this action?" },
      reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: "approve-token" }, { text: "Deny", callback_data: "reject-token" }]] },
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({ callback_query_id: "callback-1", text: "Approval recorded" });
  });

  it("resolves and downloads an inbound image", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { file_path: "photos/image.jpg", file_size: bytes.length } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } }));
    const client = new TelegramBotClient({ apiBaseUrl: "https://telegram.test", fetchImpl });

    await expect(client.downloadFile("token", "file-1")).resolves.toMatchObject({
      filePath: "photos/image.jpg",
      bytes,
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://telegram.test/file/bottoken/photos/image.jpg", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("only accepts the exact webhook secret", () => {
    const hash = hashChannelSecret("webhook-secret");
    expect(channelSecretsEqual(hash, "webhook-secret")).toBe(true);
    expect(channelSecretsEqual(hash, "wrong-secret")).toBe(false);
  });
});
