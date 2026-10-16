import type { ChannelAdapter, ChannelDeliveryRequest, ChannelDeliveryResult, CanonicalChannelEvent } from "./types";

export type TelegramMediaKind = "image" | "video" | "audio";

const telegramMimeTypesByExtension: Record<string, string> = {
  aac: "audio/aac",
  flac: "audio/flac",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  m4a: "audio/m4a",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  opus: "audio/opus",
  png: "image/png",
  webm: "video/webm",
  wav: "audio/wav",
  webp: "image/webp",
};

export function inferTelegramMimeType(fileName?: string): string | undefined {
  const extension = fileName?.split(".").at(-1)?.trim().toLowerCase();
  return extension ? telegramMimeTypesByExtension[extension] : undefined;
}

export function normalizeTelegramMimeType(input: { mimeType?: unknown; fileName?: unknown; fallback?: string }): string {
  const mimeType = typeof input.mimeType === "string"
    ? input.mimeType.split(";", 1)[0]?.trim().toLowerCase()
    : undefined;
  const fileName = typeof input.fileName === "string" ? input.fileName : undefined;
  const inferred = inferTelegramMimeType(fileName);
  if (!mimeType || mimeType === "application/octet-stream" || mimeType === "binary/octet-stream") {
    return inferred ?? input.fallback ?? "application/octet-stream";
  }
  return mimeType;
}

export function telegramMediaKind(mimeType: string): TelegramMediaKind | undefined {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/") || normalized === "application/ogg") return "audio";
  return undefined;
}

export interface TelegramAdapterOptions {
  deliverMessage?: (request: ChannelDeliveryRequest) => Promise<ChannelDeliveryResult>;
}

export class TelegramChannelAdapter implements ChannelAdapter {
  public readonly channelType = "telegram";
  public constructor(private readonly options: TelegramAdapterOptions = {}) {}

  public normalizeInbound(payload: unknown): CanonicalChannelEvent {
    const update = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const callbackQuery = update.callback_query && typeof update.callback_query === "object" ? update.callback_query as Record<string, unknown> : undefined;
    if (callbackQuery) {
      const from = callbackQuery.from && typeof callbackQuery.from === "object" ? callbackQuery.from as Record<string, unknown> : {};
      const message = callbackQuery.message && typeof callbackQuery.message === "object" ? callbackQuery.message as Record<string, unknown> : {};
      const chat = message.chat && typeof message.chat === "object" ? message.chat as Record<string, unknown> : {};
      const updateId = update.update_id;
      const callbackId = callbackQuery.id;
      const senderId = from.id;
      const conversationId = chat.id;
      const callbackData = callbackQuery.data;
      const messageId = message.message_id;
      if (![updateId, callbackId, senderId, conversationId, callbackData].every((value) => typeof value === "number" || typeof value === "string")) throw new Error("Invalid Telegram callback query");
      return {
        provider: "telegram",
        providerEventId: String(updateId),
        channelType: this.channelType,
        externalIdentity: String(senderId),
        externalConversationId: String(conversationId),
        message: {
          direction: "inbound",
          messageType: "command",
          content: { name: "agent_approval", arguments: { token: String(callbackData) } },
          ...(typeof messageId === "number" || typeof messageId === "string" ? { providerMessageId: String(messageId) } : {}),
        },
        approvalAction: { token: String(callbackData), callbackQueryId: String(callbackId) },
        metadata: {
          senderDisplayName: [from.first_name, from.last_name].filter((value): value is string => typeof value === "string").join(" ") || undefined,
          chatType: chat.type,
        },
      };
    }
    const message = update.message && typeof update.message === "object" ? update.message as Record<string, unknown> : {};
    const from = message.from && typeof message.from === "object" ? message.from as Record<string, unknown> : {};
    const chat = message.chat && typeof message.chat === "object" ? message.chat as Record<string, unknown> : {};
    const updateId = update.update_id;
    const messageId = message.message_id;
    const senderId = from.id;
    const conversationId = chat.id;
    if (![updateId, messageId, senderId, conversationId].every((value) => typeof value === "number" || typeof value === "string")) throw new Error("Invalid Telegram update");
    const document = message.document && typeof message.document === "object" ? message.document as Record<string, unknown> : undefined;
    const voice = message.voice && typeof message.voice === "object" ? message.voice as Record<string, unknown> : undefined;
    const audio = message.audio && typeof message.audio === "object" ? message.audio as Record<string, unknown> : undefined;
    if ((voice || audio) && ![voice, audio].every((attachment) => !attachment || typeof attachment.file_id === "string" && attachment.file_id.trim())) {
      throw new Error("Invalid Telegram audio attachment");
    }
    const photos = Array.isArray(message.photo)
      ? message.photo.filter((photo): photo is Record<string, unknown> => Boolean(photo && typeof photo === "object"))
      : [];
    const photo = photos.at(-1);
    const attachment = document ?? audio ?? voice ?? photo;
    const attachmentId = attachment && typeof attachment.file_id === "string" ? attachment.file_id : undefined;
    const caption = typeof message.caption === "string" ? message.caption : undefined;
    const text = typeof message.text === "string" ? message.text : "";
    const fileName = typeof attachment?.file_name === "string" ? attachment.file_name : undefined;
    const mimeType = normalizeTelegramMimeType({
      mimeType: attachment?.mime_type,
      fileName,
      fallback: voice ? "audio/ogg" : photo ? "image/jpeg" : undefined,
    });
    const content = attachmentId
      ? {
          attachmentId,
          mimeType,
          ...(fileName ? { fileName } : {}),
          ...(typeof attachment?.duration === "number" ? { durationMs: Math.round(attachment.duration * 1000) } : {}),
          ...(telegramMediaKind(mimeType) ? { mediaKind: telegramMediaKind(mimeType) } : {}),
          ...(caption ? { text: caption } : {}),
        }
      : { text };
    return {
      provider: "telegram",
      providerEventId: String(updateId),
      channelType: this.channelType,
      externalIdentity: String(senderId),
      externalConversationId: String(conversationId),
      message: { direction: "inbound", messageType: attachmentId ? "attachment" : "text", content, providerMessageId: String(messageId), occurredAt: typeof message.date === "number" ? new Date(message.date * 1000).toISOString() : undefined },
      metadata: { senderDisplayName: [from.first_name, from.last_name].filter((value): value is string => typeof value === "string").join(" ") || undefined, chatType: chat.type },
    };
  }

  public async deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    if (!this.options.deliverMessage) throw new Error("Telegram connector is not configured");
    return this.options.deliverMessage(request);
  }
}
