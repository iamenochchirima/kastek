import type { ChannelAdapter, ChannelDeliveryRequest, ChannelDeliveryResult, CanonicalChannelEvent } from "./types";

export type DiscordMediaKind = "image" | "video" | "audio";

const discordMimeByExtension: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mov: "video/quicktime",
  mp4: "video/mp4",
  webm: "video/webm",
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/m4a",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
};

export function normalizeDiscordMimeType(input: { mimeType?: unknown; fileName?: unknown }): string {
  const mimeType = typeof input.mimeType === "string" ? input.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "" : "";
  if (mimeType && mimeType !== "application/octet-stream" && mimeType !== "binary/octet-stream") return mimeType;
  const fileName = typeof input.fileName === "string" ? input.fileName : "";
  const extension = fileName.split(".").at(-1)?.trim().toLowerCase() ?? "";
  return discordMimeByExtension[extension] ?? mimeType;
}

export function discordMediaKind(mimeType: string): DiscordMediaKind | undefined {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/") || normalized === "application/ogg") return "audio";
  return undefined;
}

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
    const attachmentMimeType = normalizeDiscordMimeType({ mimeType: attachment?.content_type, fileName: attachment?.filename });
    const attachmentMediaKind = discordMediaKind(attachmentMimeType);
    const content = attachmentId
      ? {
          attachmentId,
          mimeType: attachmentMimeType || "application/octet-stream",
          ...(typeof attachment?.filename === "string" ? { fileName: attachment.filename } : {}),
          ...(typeof attachment?.url === "string" ? { url: attachment.url } : {}),
          ...(typeof attachment?.duration_secs === "number" ? { durationMs: Math.round(attachment.duration_secs * 1000) } : {}),
          ...(attachmentMediaKind ? { mediaKind: attachmentMediaKind } : {}),
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
