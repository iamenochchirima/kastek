import { describe, expect, it, vi } from "vitest";
import { DiscordBotClient } from "../src/channels/discord-client";

describe("Discord bot client", () => {
  it("validates a bot and sends component buttons", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "bot-1", username: "kasi", bot: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "message-1" }), { status: 200 }));
    const client = new DiscordBotClient({ apiBaseUrl: "https://discord.test/api/v10", fetchImpl });

    await expect(client.getMe("secret")).resolves.toMatchObject({ id: "bot-1", username: "kasi" });
    await expect(client.sendApprovalPrompt("secret", "channel-1", "Approve?", { approve: "approve-token", reject: "reject-token" })).resolves.toEqual({ providerMessageId: "message-1", status: "sent" });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://discord.test/api/v10/channels/channel-1/messages", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: "Bot secret" }) }));
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({ components: [{ components: [{ custom_id: "approve-token", style: 3 }, { custom_id: "reject-token", style: 4 }] }] });
  });

  it("defers a component and edits the ephemeral original response", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = new DiscordBotClient({ apiBaseUrl: "https://discord.test/api/v10", fetchImpl });

    await client.deferComponent("interaction-1", "interaction-token");
    await client.editOriginalResponse("app-1", "interaction-token", "Approved");
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://discord.test/api/v10/interactions/interaction-1/interaction-token/callback", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ type: 5, data: { flags: 64 } });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://discord.test/api/v10/webhooks/app-1/interaction-token/messages/@original", expect.objectContaining({ method: "PATCH" }));
  });

  it("renders typed images as embeds and other media as links", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "message-2" }), { status: 200 }));
    const client = new DiscordBotClient({ apiBaseUrl: "https://discord.test/api/v10", fetchImpl });

    await expect(client.sendMediaResponse("secret", "channel-1", "See these files", [
      { assetId: "image-1", kind: "image", previewUrl: "https://core.test/image", fileName: "image.png" },
      { assetId: "doc-1", kind: "document", previewUrl: "https://core.test/doc", fileName: "brief.pdf" },
    ])).resolves.toEqual({ providerMessageId: "message-2", status: "sent" });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ content: "See these files\n\n[brief.pdf](https://core.test/doc)" });
    expect(body.embeds).toEqual([{ image: { url: "https://core.test/image" }, title: "image.png" }]);
  });

  it("falls back to a text link when Discord rejects an image embed", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Invalid Form Body" }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "message-3" }), { status: 200 }));
    const client = new DiscordBotClient({ apiBaseUrl: "https://discord.test/api/v10", fetchImpl });

    await expect(client.sendMediaResponse("secret", "channel-1", "The post is ready.", [
      { assetId: "image-1", kind: "image", previewUrl: "https://core.test/image", fileName: "image.png" },
    ])).resolves.toEqual({ providerMessageId: "message-3", status: "sent" });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({
      content: "The post is ready.\n\n[image.png](https://core.test/image)",
    });
  });
});
