export type ChannelMessageType = "text" | "attachment" | "reaction" | "status" | "command" | "system";

export interface CanonicalChannelEvent {
  provider: string;
  providerEventId: string;
  channelType: string;
  externalIdentity: string;
  externalConversationId: string;
  message: {
    direction: "inbound" | "outbound" | "system";
    messageType: ChannelMessageType;
    content: Record<string, unknown>;
    providerMessageId?: string;
    occurredAt?: string;
  };
  metadata: Record<string, unknown>;
}

export interface ChannelDeliveryRequest {
  organizationId: string;
  conversationId: string;
  messageId: string;
  content: Record<string, unknown>;
  idempotencyKey: string;
}

export interface ChannelDeliveryResult {
  providerMessageId?: string;
  status: "sent" | "unknown";
  raw?: Record<string, unknown>;
}

export interface ChannelAdapter {
  readonly channelType: string;
  normalizeInbound(payload: unknown): CanonicalChannelEvent;
  deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult>;
}

/** The sidebar channel is already authenticated by the Agent Platform API. */
export class PlatformChannelAdapter implements ChannelAdapter {
  public readonly channelType = "platform";

  public normalizeInbound(payload: unknown): CanonicalChannelEvent {
    if (!payload || typeof payload !== "object") throw new Error("Invalid platform channel payload");
    const value = payload as Record<string, unknown>;
    const required = ["providerEventId", "externalIdentity", "externalConversationId"];
    for (const key of required) if (typeof value[key] !== "string" || !value[key]) throw new Error(`Missing platform event field: ${key}`);
    const message = value.message;
    if (!message || typeof message !== "object") throw new Error("Missing platform message");
    const messageValue = message as Record<string, unknown>;
    return {
      provider: "kasitek-platform",
      providerEventId: value.providerEventId as string,
      channelType: "platform",
      externalIdentity: value.externalIdentity as string,
      externalConversationId: value.externalConversationId as string,
      message: {
        direction: "inbound",
        messageType: (messageValue.messageType as ChannelMessageType | undefined) ?? "text",
        content: (messageValue.content && typeof messageValue.content === "object" ? messageValue.content : { text: String(messageValue.content ?? "") }) as Record<string, unknown>,
        providerMessageId: typeof messageValue.providerMessageId === "string" ? messageValue.providerMessageId : undefined,
        occurredAt: typeof messageValue.occurredAt === "string" ? messageValue.occurredAt : undefined,
      },
      metadata: value.metadata && typeof value.metadata === "object" ? value.metadata as Record<string, unknown> : {},
    };
  }

  public async deliver(_request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    throw new Error("Platform delivery is handled by the authenticated API client");
  }
}
