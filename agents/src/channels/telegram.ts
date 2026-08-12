import type { ChannelAdapter, ChannelDeliveryRequest, ChannelDeliveryResult, CanonicalChannelEvent } from "./types";

export interface TelegramAdapterOptions {
  deliverMessage?: (request: ChannelDeliveryRequest) => Promise<ChannelDeliveryResult>;
}

export class TelegramChannelAdapter implements ChannelAdapter {
  public readonly channelType = "telegram";
  public constructor(private readonly options: TelegramAdapterOptions = {}) {}

  public normalizeInbound(payload: unknown): CanonicalChannelEvent {
    const update = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const message = update.message && typeof update.message === "object" ? update.message as Record<string, unknown> : {};
    const from = message.from && typeof message.from === "object" ? message.from as Record<string, unknown> : {};
    const chat = message.chat && typeof message.chat === "object" ? message.chat as Record<string, unknown> : {};
    const updateId = update.update_id;
    const messageId = message.message_id;
    const senderId = from.id;
    const conversationId = chat.id;
    if (![updateId, messageId, senderId, conversationId].every((value) => typeof value === "number" || typeof value === "string")) throw new Error("Invalid Telegram update");
    const text = typeof message.text === "string" ? message.text : "";
    return {
      provider: "telegram",
      providerEventId: String(updateId),
      channelType: this.channelType,
      externalIdentity: String(senderId),
      externalConversationId: String(conversationId),
      message: { direction: "inbound", messageType: "text", content: { text }, providerMessageId: String(messageId), occurredAt: typeof message.date === "number" ? new Date(message.date * 1000).toISOString() : undefined },
      metadata: { senderDisplayName: [from.first_name, from.last_name].filter((value): value is string => typeof value === "string").join(" ") || undefined, chatType: chat.type },
    };
  }

  public async deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    if (!this.options.deliverMessage) throw new Error("Telegram connector is not configured");
    return this.options.deliverMessage(request);
  }
}
