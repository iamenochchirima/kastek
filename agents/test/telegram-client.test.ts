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
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({ secret_token: "secret", allowed_updates: ["message"] });
  });

  it("only accepts the exact webhook secret", () => {
    const hash = hashChannelSecret("webhook-secret");
    expect(channelSecretsEqual(hash, "webhook-secret")).toBe(true);
    expect(channelSecretsEqual(hash, "wrong-secret")).toBe(false);
  });
});
