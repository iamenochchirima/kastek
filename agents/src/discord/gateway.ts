import type { AppConfig } from "../config";
import { ChannelCredentialRepository } from "../db/repositories/channel-credential-repository";
import type { ChannelConnectionRecord, ChannelRepository } from "../db/repositories/channel-repository";
import { DiscordBotClient } from "../channels/discord-client";
import { operationalLogger } from "../telemetry/logger";
import { readDiscordAccessPolicy, shouldDiscordAnswer, shouldDiscordAnswerComponent, stripDiscordMention } from "./policy";

interface GatewayPayload {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}

interface DiscordSocket {
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: Event | MessageEvent<string> | CloseEvent) => void): void;
  send(data: string): void;
  close(code?: number): void;
}

export interface DiscordGatewayOptions {
  connection: ChannelConnectionRecord;
  token: string;
  client: DiscordBotClient;
  platformUrl: string;
  forwardSecret: string;
  fetchImpl?: typeof fetch;
  socketFactory?: (url: string) => DiscordSocket;
  onStatus?: (status: "connecting" | "connected" | "error" | "stopped") => Promise<void> | void;
}

/** One Discord Gateway session. Discord sends both messages and button clicks here. */
export class DiscordGatewayConnection {
  private readonly fetchImpl: typeof fetch;
  private readonly socketFactory: (url: string) => DiscordSocket;
  private readonly policy;
  private socket: DiscordSocket | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private sequence: number | null = null;
  private stopped = false;
  private connecting = false;
  private backoffMs = 1_000;
  private botId: string | undefined;

  public constructor(private readonly options: DiscordGatewayOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url) as unknown as DiscordSocket);
    this.policy = readDiscordAccessPolicy(options.connection.metadata);
  }

  public async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  public stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeat = undefined;
    this.reconnectTimer = undefined;
    this.socket?.close(1000);
    this.socket = undefined;
    void this.options.onStatus?.("stopped");
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    await this.options.onStatus?.("connecting");
    try {
      const gatewayUrl = await this.options.client.getGatewayUrl(this.options.token);
      const socket = this.socketFactory(`${gatewayUrl}${gatewayUrl.includes("?") ? "&" : "?"}v=10&encoding=json`);
      this.socket = socket;
      socket.addEventListener("open", () => { this.backoffMs = 1_000; });
      socket.addEventListener("message", (event) => {
        const data = typeof (event as MessageEvent<string>).data === "string" ? (event as MessageEvent<string>).data : "";
        if (data) void this.handlePayload(JSON.parse(data) as GatewayPayload);
      });
      socket.addEventListener("close", () => this.scheduleReconnect());
      socket.addEventListener("error", () => { void this.options.onStatus?.("error"); });
    } catch (error) {
      await this.options.onStatus?.("error");
      this.scheduleReconnect(error instanceof Error ? error.message : "gateway connection failed");
    } finally {
      this.connecting = false;
    }
  }

  private async handlePayload(payload: GatewayPayload): Promise<void> {
    if (typeof payload.s === "number") this.sequence = payload.s;
    switch (payload.op) {
      case 10:
        this.startHeartbeat(Number((payload.d as Record<string, unknown> | null)?.heartbeat_interval ?? 41_250));
        this.send({ op: 2, d: { token: this.options.token, intents: 1 | 512 | 4096 | 32768, properties: { os: "linux", browser: "kasitek", device: "kasitek" } } });
        return;
      case 11:
        return;
      case 7:
        this.socket?.close(4_000);
        return;
      case 9:
        this.socket?.close(4_000);
        this.scheduleReconnect("invalid session");
        return;
      case 0:
        if (payload.t === "READY") {
          const ready = payload.d && typeof payload.d === "object" ? payload.d as Record<string, unknown> : {};
          const user = ready.user;
          if (user && typeof user === "object" && typeof (user as Record<string, unknown>).id === "string") this.botId = (user as Record<string, unknown>).id as string;
          await this.options.onStatus?.("connected");
        } else if (payload.t === "MESSAGE_CREATE") {
          await this.forwardMessage(payload.d && typeof payload.d === "object" ? payload.d as Record<string, unknown> : {});
        } else if (payload.t === "INTERACTION_CREATE") {
          await this.forwardComponent(payload.d && typeof payload.d === "object" ? payload.d as Record<string, unknown> : {});
        }
        return;
      default:
        return;
    }
  }

  private async forwardMessage(message: Record<string, unknown>): Promise<void> {
    const author = message.author && typeof message.author === "object" ? message.author as Record<string, unknown> : {};
    const channelId = typeof message.channel_id === "string" ? message.channel_id : "";
    const authorId = typeof author.id === "string" ? author.id : "";
    if (!channelId || !authorId || author.bot === true || (typeof message.content !== "string" && !Array.isArray(message.attachments))) return;
    const content = typeof message.content === "string" ? message.content : "";
    const mentioned = this.botId ? content.includes(`<@${this.botId}>`) || content.includes(`<@!${this.botId}>`) : false;
    const isDm = typeof message.guild_id !== "string";
    if (!shouldDiscordAnswer({ isDm, authorId, channelId, mentioned, policy: this.policy })) return;
    const stripped = stripDiscordMention(content, this.botId ?? "");
    if (!stripped && (!Array.isArray(message.attachments) || message.attachments.length === 0)) return;
    await this.forward({ ...message, content: stripped });
  }

  private async forwardComponent(interaction: Record<string, unknown>): Promise<void> {
    const member = interaction.member && typeof interaction.member === "object" ? interaction.member as Record<string, unknown> : {};
    const user = interaction.user && typeof interaction.user === "object" ? interaction.user as Record<string, unknown> : member.user && typeof member.user === "object" ? member.user as Record<string, unknown> : {};
    const channelId = typeof interaction.channel_id === "string" ? interaction.channel_id : "";
    const authorId = typeof user.id === "string" ? user.id : "";
    if (interaction.type !== 3 || !channelId || !authorId) return;
    if (!shouldDiscordAnswerComponent({ isDm: typeof interaction.guild_id !== "string", authorId, channelId, policy: this.policy })) return;
    await this.forward(interaction);
  }

  private async forward(payload: Record<string, unknown>): Promise<void> {
    const response = await this.fetchImpl(`${this.options.platformUrl.replace(/\/$/, "")}/v1/webhooks/discord/${encodeURIComponent(this.options.connection.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-kasitek-core-forward-secret": this.options.forwardSecret },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Discord event forwarding failed with ${response.status}`);
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => this.send({ op: 1, d: this.sequence }), Math.max(1_000, intervalMs));
    this.send({ op: 1, d: this.sequence });
  }

  private send(payload: GatewayPayload): void {
    this.socket?.send(JSON.stringify(payload));
  }

  private scheduleReconnect(reason?: string): void {
    if (this.stopped || this.reconnectTimer) return;
    if (reason) void this.options.onStatus?.("error");
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }
}

export class DiscordGatewaySupervisor {
  private readonly sessions = new Map<string, DiscordGatewayConnection>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;

  public constructor(
    private readonly repository: ChannelRepository,
    private readonly credentials: ChannelCredentialRepository,
    private readonly config: AppConfig,
  ) {}

  public async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.config.DISCORD_GATEWAY_POLL_INTERVAL_MS);
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
  }

  private async refresh(): Promise<void> {
    if (this.stopping) return;
    const connections = await this.repository.listActiveDiscordConnections();
    const active = new Set(connections.map((connection) => connection.id));
    for (const [id, session] of this.sessions) {
      if (!active.has(id)) {
        session.stop();
        this.sessions.delete(id);
      }
    }
    for (const connection of connections) {
      if (this.sessions.has(connection.id) || !connection.credential_reference) continue;
      const token = await this.credentials.resolve(connection.organization_id, connection.credential_reference, "discord").catch((error) => {
        operationalLogger.warn({ err: error, event: "discord.credential.unavailable", connection_id: connection.id }, "Discord credential unavailable");
        return undefined;
      });
      if (!token) continue;
      const session = new DiscordGatewayConnection({
        connection,
        token,
        client: new DiscordBotClient({ apiBaseUrl: this.config.DISCORD_API_BASE_URL, timeoutMs: this.config.DISCORD_API_TIMEOUT_MS }),
        platformUrl: this.config.DISCORD_GATEWAY_PLATFORM_URL ?? `http://127.0.0.1:${this.config.PORT}`,
        forwardSecret: this.config.INTERNAL_AUTH_SECRET ?? "",
        onStatus: async (status) => {
          await this.repository.updateConnection({
            organizationId: connection.organization_id,
            connectionId: connection.id,
            metadata: { ...connection.metadata, gateway: { status } },
          }).catch((error) => operationalLogger.warn({ err: error, event: "discord.status.update.failed", connection_id: connection.id }, "Could not update Discord connection status"));
        },
      });
      this.sessions.set(connection.id, session);
      void session.start().catch((error) => operationalLogger.warn({ err: error, event: "discord.session.failed", connection_id: connection.id }, "Discord session failed"));
    }
  }
}
