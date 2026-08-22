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
    await expect(client.sendMessage("token", "42", "hello")).resolves.toEqual({ providerMessageId: "456", status: "sent" });

    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://telegram.test/bottoken/setWebhook", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({ secret_token: "secret", allowed_updates: ["message", "callback_query"] });
  });

  it("sends approval buttons and acknowledges callback clicks", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
    const client = new TelegramBotClient({ apiBaseUrl: "https://telegram.test", fetchImpl });

    await client.sendApprovalPrompt("token", "42", "Approve this action?", { approve: "approve-token", reject: "reject-token" });
    await client.answerCallbackQuery("token", "callback-1", "Approval recorded");

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: "approve-token" }, { text: "Deny", callback_data: "reject-token" }]] },
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({ callback_query_id: "callback-1", text: "Approval recorded" });
  });

  it("only accepts the exact webhook secret", () => {
    const hash = hashChannelSecret("webhook-secret");
    expect(channelSecretsEqual(hash, "webhook-secret")).toBe(true);
    expect(channelSecretsEqual(hash, "wrong-secret")).toBe(false);
  });
});
