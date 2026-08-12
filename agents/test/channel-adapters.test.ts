import { describe, expect, it } from "vitest";
import { DiscordChannelAdapter, TelegramChannelAdapter } from "../src/channels";

describe("thin external channel adapters", () => {
  it("normalizes Telegram updates into the canonical envelope", () => {
    const event = new TelegramChannelAdapter().normalizeInbound({ update_id: 8, message: { message_id: 9, date: 1_700_000_000, text: "hello", from: { id: 10, first_name: "Ada" }, chat: { id: 11, type: "private" } } });
    expect(event).toMatchObject({ provider: "telegram", providerEventId: "8", externalIdentity: "10", externalConversationId: "11", message: { providerMessageId: "9", content: { text: "hello" } } });
  });

  it("normalizes Discord messages and keeps delivery connector-owned", async () => {
    const adapter = new DiscordChannelAdapter();
    const event = adapter.normalizeInbound({ id: "msg-1", channel_id: "channel-1", content: "hello", author: { id: "user-1", username: "Ada" } });
    expect(event.message.content).toEqual({ text: "hello" });
    await expect(adapter.deliver({ organizationId: "org", conversationId: "c", messageId: "m", content: { text: "hi" }, idempotencyKey: "k" })).rejects.toThrow("not configured");
  });
});
