import type { Notification, Pool, PoolClient } from "pg";
import { operationalLogger } from "../telemetry/logger";

const CHANNEL = "agent_conversation_events";

export interface ConversationChangeNotification {
  organizationId: string;
  subject: string;
  eventType: string;
}

export interface ConversationEventNotifications {
  subscribe(listener: (event: ConversationChangeNotification) => void): Promise<() => void>;
  close(): Promise<void>;
}

export class PostgresConversationEventNotifications implements ConversationEventNotifications {
  private client: PoolClient | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(event: ConversationChangeNotification) => void>();

  public constructor(private readonly pool: Pick<Pool, "connect">) {}

  public async subscribe(listener: (event: ConversationChangeNotification) => void): Promise<() => void> {
    if (this.closed) throw new Error("Conversation event notifications are closed");
    this.listeners.add(listener);
    try {
      await this.ensureConnected();
    } catch (error) {
      this.listeners.delete(listener);
      throw error;
    }
    return () => this.listeners.delete(listener);
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.connecting?.catch(() => undefined);
    const client = this.client;
    this.client = null;
    if (!client) return;
    client.removeListener("notification", this.onNotification);
    client.removeListener("error", this.onConnectionError);
    client.removeListener("end", this.onConnectionEnd);
    await client.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
    client.release();
  }

  private async ensureConnected(): Promise<void> {
    if (this.client || this.closed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const client = await this.pool.connect();
    if (this.closed) {
      client.release();
      return;
    }
    client.on("notification", this.onNotification);
    client.on("error", this.onConnectionError);
    client.on("end", this.onConnectionEnd);
    try {
      await client.query(`LISTEN ${CHANNEL}`);
      this.client = client;
      operationalLogger.info({ event: "conversation.events.listener.connected" }, "Conversation event listener connected");
    } catch (error) {
      client.removeListener("notification", this.onNotification);
      client.removeListener("error", this.onConnectionError);
      client.removeListener("end", this.onConnectionEnd);
      client.release();
      throw error;
    }
  }

  private readonly onNotification = (notification: Notification): void => {
    if (notification.channel !== CHANNEL || !notification.payload) return;
    try {
      const parsed = JSON.parse(notification.payload) as Partial<ConversationChangeNotification>;
      if (typeof parsed.organizationId !== "string" || typeof parsed.subject !== "string" || typeof parsed.eventType !== "string") return;
      const event = { organizationId: parsed.organizationId, subject: parsed.subject, eventType: parsed.eventType };
      for (const listener of this.listeners) listener(event);
    } catch {
      operationalLogger.warn({ event: "conversation.events.notification.invalid" }, "Invalid conversation event notification ignored");
    }
  };

  private readonly onConnectionError = (error: Error): void => {
    operationalLogger.warn({ event: "conversation.events.listener.disconnected", error_type: error.name }, "Conversation event listener disconnected");
    this.disconnectAndReconnect();
  };

  private readonly onConnectionEnd = (): void => {
    this.disconnectAndReconnect();
  };

  private disconnectAndReconnect(): void {
    const client = this.client;
    this.client = null;
    if (client) {
      client.removeListener("notification", this.onNotification);
      client.removeListener("error", this.onConnectionError);
      client.removeListener("end", this.onConnectionEnd);
      client.release(true);
    }
    if (this.closed || this.reconnectTimer || this.listeners.size === 0) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected().catch((error: unknown) => {
        operationalLogger.warn({ event: "conversation.events.listener.reconnect_failed", error_type: error instanceof Error ? error.name : "unknown" }, "Conversation event listener reconnect failed");
        this.disconnectAndReconnect();
      });
    }, 1_000);
    this.reconnectTimer.unref();
  }
}
