import type { ChannelAdapter, ChannelDeliveryRequest, ChannelDeliveryResult, CanonicalChannelEvent } from "./types";

export interface DiscordAdapterOptions {
  deliverMessage?: (request: ChannelDeliveryRequest) => Promise<ChannelDeliveryResult>;
}

export class DiscordChannelAdapter implements ChannelAdapter {
  public readonly channelType = "discord";
  public constructor(private readonly options: DiscordAdapterOptions = {}) {}

  public normalizeInbound(payload: unknown): CanonicalChannelEvent {
    const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const interaction = value.type === 3 ? value : undefined;
    if (interaction) {
      const data = interaction.data && typeof interaction.data === "object" ? interaction.data as Record<string, unknown> : {};
      const user = interaction.user && typeof interaction.user === "object"
        ? interaction.user as Record<string, unknown>
        : interaction.member && typeof interaction.member === "object" && (interaction.member as Record<string, unknown>).user && typeof (interaction.member as Record<string, unknown>).user === "object"
          ? (interaction.member as Record<string, unknown>).user as Record<string, unknown>
          : {};
      const message = interaction.message && typeof interaction.message === "object" ? interaction.message as Record<string, unknown> : {};
      const interactionId = interaction.id;
      const interactionToken = interaction.token;
      const applicationId = interaction.application_id;
      const channelId = interaction.channel_id ?? message.channel_id;
      const customId = data.custom_id;
      if (![interactionId, interactionToken, applicationId, channelId, customId, user.id].every((candidate) => typeof candidate === "string" && candidate.length > 0)) {
        throw new Error("Invalid Discord component interaction");
      }
      const guildId = typeof interaction.guild_id === "string"
        ? interaction.guild_id
        : typeof message.guild_id === "string" ? message.guild_id : undefined;
      return {
        provider: "discord",
        providerEventId: interactionId as string,
        channelType: this.channelType,
        externalIdentity: user.id as string,
        externalConversationId: channelId as string,
        message: {
          direction: "inbound",
          messageType: "command",
          content: { name: "agent_approval", arguments: { token: customId as string } },
          ...(typeof message.id === "string" ? { providerMessageId: message.id } : {}),
        },
        approvalAction: {
          token: customId as string,
          interactionId: interactionId as string,
          interactionToken: interactionToken as string,
          applicationId: applicationId as string,
        },
        metadata: {
          senderDisplayName: typeof user.global_name === "string" ? user.global_name : typeof user.username === "string" ? user.username : undefined,
          guildId,
          interactionType: "message_component",
        },
      };
    }
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
      metadata: {
        senderDisplayName: typeof author.global_name === "string" ? author.global_name : typeof author.username === "string" ? author.username : undefined,
        guildId: typeof value.guild_id === "string" ? value.guild_id : undefined,
        authorIsBot: author.bot === true,
      },
    };
  }

  public async deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    if (!this.options.deliverMessage) throw new Error("Discord connector is not configured");
    return this.options.deliverMessage(request);
  }
}
