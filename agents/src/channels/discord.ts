import type { ChannelAdapter, ChannelDeliveryRequest, ChannelDeliveryResult, CanonicalChannelEvent } from "./types";

export interface DiscordAdapterOptions {
  deliverMessage?: (request: ChannelDeliveryRequest) => Promise<ChannelDeliveryResult>;
}

export class DiscordChannelAdapter implements ChannelAdapter {
  public readonly channelType = "discord";
  public constructor(private readonly options: DiscordAdapterOptions = {}) {}

  public normalizeInbound(payload: unknown): CanonicalChannelEvent {
    const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const author = value.author && typeof value.author === "object" ? value.author as Record<string, unknown> : {};
    if (typeof value.id !== "string" || typeof value.channel_id !== "string" || typeof author.id !== "string") throw new Error("Invalid Discord message");
    const attachment = Array.isArray(value.attachments)
      ? value.attachments.find((candidate): candidate is Record<string, unknown> => Boolean(candidate && typeof candidate === "object"))
      : undefined;
    const attachmentId = attachment && typeof attachment.id === "string" ? attachment.id : undefined;
    const content = attachmentId
      ? {
          attachmentId,
          mimeType: typeof attachment?.content_type === "string" ? attachment.content_type : "application/octet-stream",
          ...(typeof attachment?.filename === "string" ? { fileName: attachment.filename } : {}),
          ...(typeof value.content === "string" && value.content ? { text: value.content } : {}),
        }
      : { text: typeof value.content === "string" ? value.content : "" };
    return {
      provider: "discord",
      providerEventId: value.id,
      channelType: this.channelType,
      externalIdentity: author.id,
      externalConversationId: value.channel_id,
      message: { direction: "inbound", messageType: attachmentId ? "attachment" : "text", content, providerMessageId: value.id, occurredAt: typeof value.timestamp === "string" ? value.timestamp : undefined },
      metadata: { authorDisplayName: typeof author.username === "string" ? author.username : undefined, guildId: typeof value.guild_id === "string" ? value.guild_id : undefined },
    };
  }

  public async deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    if (!this.options.deliverMessage) throw new Error("Discord connector is not configured");
    return this.options.deliverMessage(request);
  }
}
