import { describe, expect, it } from "vitest";
import { DiscordChannelAdapter, TelegramChannelAdapter } from "../src/channels";

describe("thin external channel adapters", () => {
  it("normalizes Telegram updates into the canonical envelope", () => {
    const event = new TelegramChannelAdapter().normalizeInbound({ update_id: 8, message: { message_id: 9, date: 1_700_000_000, text: "hello", from: { id: 10, first_name: "Ada" }, chat: { id: 11, type: "private" } } });
    expect(event).toMatchObject({ provider: "telegram", providerEventId: "8", externalIdentity: "10", externalConversationId: "11", message: { providerMessageId: "9", content: { text: "hello" } } });
  });

  it("normalizes Telegram documents and photos without copying provider URLs", () => {
    const document = new TelegramChannelAdapter().normalizeInbound({ update_id: 9, message: { message_id: 10, from: { id: 11 }, chat: { id: 12 }, caption: "invoice", document: { file_id: "file-1", file_name: "invoice.pdf", mime_type: "application/pdf" } } });
    expect(document.message).toMatchObject({ messageType: "attachment", content: { attachmentId: "file-1", mimeType: "application/pdf", fileName: "invoice.pdf", text: "invoice" } });

    const photo = new TelegramChannelAdapter().normalizeInbound({ update_id: 10, message: { message_id: 11, from: { id: 11 }, chat: { id: 12 }, photo: [{ file_id: "small" }, { file_id: "large", width: 1200, height: 900 }] } });
    expect(photo.message).toMatchObject({ messageType: "attachment", content: { attachmentId: "large", mimeType: "image/jpeg" } });
    expect(photo.message.content).not.toHaveProperty("url");
  });

  it("normalizes Discord messages and keeps delivery connector-owned", async () => {
    const adapter = new DiscordChannelAdapter();
    const event = adapter.normalizeInbound({ id: "msg-1", channel_id: "channel-1", content: "hello", author: { id: "user-1", username: "Ada" } });
    expect(event.message.content).toEqual({ text: "hello" });
    await expect(adapter.deliver({ organizationId: "org", conversationId: "c", messageId: "m", content: { text: "hi" }, idempotencyKey: "k" })).rejects.toThrow("not configured");
  });

  it("normalizes the first Discord attachment as a bounded canonical envelope", () => {
    const event = new DiscordChannelAdapter().normalizeInbound({ id: "msg-2", channel_id: "channel-1", content: "see this", author: { id: "user-1" }, attachments: [{ id: "attachment-1", filename: "photo.png", content_type: "image/png", url: "https://cdn.discord.test/temporary" }] });
    expect(event.message).toMatchObject({ messageType: "attachment", content: { attachmentId: "attachment-1", fileName: "photo.png", mimeType: "image/png", text: "see this" } });
    expect(event.message.content).not.toHaveProperty("url");
  });
});
