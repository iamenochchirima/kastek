import { describe, expect, it, vi } from "vitest";
import { DiscordGatewayConnection } from "../src/discord/gateway";

class FakeSocket {
  public readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: Event | MessageEvent<string> | CloseEvent) => void>>();

  public addEventListener(type: "open" | "message" | "close" | "error", listener: (event: Event | MessageEvent<string> | CloseEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  public send(data: string): void { this.sent.push(data); }
  public close(): void {}

  public emit(type: "open" | "message" | "close" | "error", data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener((type === "message" ? { data } : {}) as Event & MessageEvent<string>);
  }
}

const connection = {
  id: "connection-1",
  organization_id: "org-1",
  installation_id: "installation-1",
  channel_type: "discord",
  channel_key: "bot:bot-1",
  credential_reference: "credential-1",
  webhook_secret_hash: null,
  webhook_url: null,
  metadata: {},
  status: "active",
  created_by: "actor-1",
  created_at: "2026-08-22T00:00:00.000Z",
  updated_at: "2026-08-22T00:00:00.000Z",
} as const;

describe("Discord Gateway connection", () => {
  it("identifies, heartbeats, filters, strips mentions, and forwards messages and components", async () => {
    const socket = new FakeSocket();
    const forwarded = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const client = { getGatewayUrl: vi.fn(async () => "wss://discord.test/gateway") };
    const gateway = new DiscordGatewayConnection({
      connection,
      token: "bot-token",
      client: client as never,
      platformUrl: "http://agents.test",
      forwardSecret: "internal-secret",
      fetchImpl: forwarded,
      socketFactory: () => socket,
    });

    await gateway.start();
    socket.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 }, s: 1 }));
    socket.emit("message", JSON.stringify({ op: 0, t: "READY", d: { user: { id: "bot-1" } }, s: 2 }));
    socket.emit("message", JSON.stringify({ op: 0, t: "MESSAGE_CREATE", d: { id: "message-1", channel_id: "dm-1", content: "<@bot-1> hello", author: { id: "user-1", username: "Ada" } }, s: 3 }));
    socket.emit("message", JSON.stringify({ op: 0, t: "MESSAGE_CREATE", d: { id: "message-2", channel_id: "server-1", guild_id: "guild-1", content: "<@bot-1> ignored", author: { id: "user-1" } }, s: 4 }));
    socket.emit("message", JSON.stringify({ op: 0, t: "INTERACTION_CREATE", d: { id: "interaction-1", type: 3, application_id: "app-1", token: "interaction-token", channel_id: "dm-1", data: { component_type: 2, custom_id: "approval-token" }, user: { id: "user-1" } }, s: 5 }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.getGatewayUrl).toHaveBeenCalledWith("bot-token");
    expect(JSON.parse(socket.sent.find((value) => JSON.parse(value).op === 2)!)).toMatchObject({ op: 2, d: { token: "bot-token", intents: 37377 } });
    expect(JSON.parse(socket.sent.find((value) => JSON.parse(value).op === 1)!)).toMatchObject({ op: 1, d: 1 });
    expect(forwarded).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(forwarded.mock.calls[0]?.[1]?.body))).toMatchObject({ content: "hello" });
    expect(JSON.parse(String(forwarded.mock.calls[1]?.[1]?.body))).toMatchObject({ type: 3, data: { custom_id: "approval-token" } });
    gateway.stop();
  });
});
