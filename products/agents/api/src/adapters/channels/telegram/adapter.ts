import { createHash, timingSafeEqual } from "node:crypto";
import { channelAttachmentSchema, channelWebhookEventSchema, ChannelAdapterError, type ChannelAttachment, type ChannelProviderAdapter,
  type ChannelProviderContext, type ChannelSendRequest, type ChannelSendResult, type ChannelWebhookEvent, type ChannelWebhookRequest } from "../../../contracts/channel-adapters";

const object = (value: unknown): Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const id = (value: unknown): string | undefined => typeof value === "number" && Number.isSafeInteger(value) ? String(value) :
  typeof value === "string" && /^-?\d{1,20}$/.test(value) && Number.isSafeInteger(Number(value)) ? value : undefined;
const invalid = () => new ChannelAdapterError("TELEGRAM_REQUEST_INVALID", "rejected", 400);
const timestamp = (value: unknown): string | null => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return null;
  const date = new Date(Number(value) * 1000); return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
function media(message: Record<string, any>): ChannelAttachment[] {
  const photo = Array.isArray(message.photo) ? message.photo.at(-1) : undefined;
  const entries = [["image", photo], ["audio", message.voice ?? message.audio], ["video", message.video], ["document", message.document]] as const;
  for (const [kind, raw] of entries) {
    if (raw === undefined) continue;
    const value = object(raw);
    if (typeof value.file_id !== "string" || !value.file_id) throw invalid();
    return [{ kind, providerMediaId: value.file_id, ...(typeof value.mime_type === "string" ? { mimeType: value.mime_type } : {}),
      ...(typeof value.file_name === "string" ? { fileName: value.file_name } : {}) }];
  }
  return [];
}
export function normalizeTelegram(payload: unknown, context?: { assetId: string }): ChannelWebhookEvent[] {
  const update = object(payload), callback = object(update.callback_query);
  const raw = update.message ?? callback.message;
  if (raw === undefined) return [];
  if (!context || !id(context.assetId)) throw new ChannelAdapterError("TELEGRAM_ASSET_REQUIRED", "rejected", 400);
  const message = object(raw), chat = object(message.chat), sender = object(update.callback_query ? callback.from : message.from ?? message.sender_chat);
  const eventId = id(update.update_id), chatId = id(chat.id), senderId = id(sender.id), messageId = id(message.message_id);
  if (!eventId || !chatId || !senderId || !messageId) throw invalid();
  const interaction = update.callback_query ? callback.data : undefined;
  if (update.callback_query && (typeof interaction !== "string" || !interaction)) return [];
  const attachments = update.callback_query ? [] : media(message);
  const text = typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : undefined;
  if (text === undefined && !attachments.length && interaction === undefined) return [];
  const parsed = channelWebhookEventSchema.safeParse({ kind: interaction === undefined ? "message" : "interaction",
    assetId: context.assetId, eventId, externalConversationId: chatId, senderId, providerMessageId: messageId,
    occurredAt: timestamp(message.date), ...(text === undefined ? {} : { text }), attachments,
    ...(interaction === undefined ? {} : { interaction }), echo: sender.is_bot === true,
    ...(id(object(message.reply_to_message).message_id) ? { replyToProviderMessageId: id(object(message.reply_to_message).message_id) } : {}) });
  if (!parsed.success) throw invalid();
  return [parsed.data];
}
function retryAfter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86400 ? value * 1000 : undefined;
}
async function call(context: ChannelProviderContext, method: string, body: Record<string, unknown>): Promise<unknown> {
  // Telegram requires the credential in its URL. Never retain provider exceptions or response descriptions.
  if (!/^\d+:[A-Za-z0-9_-]{1,256}$/.test(context.credential) || typeof context.fetch !== "function") throw invalid();
  if (context.signal?.aborted) throw new ChannelAdapterError("TELEGRAM_CANCELLED", "rejected", 409);
  let response: Response;
  try { response = await context.fetch(`https://api.telegram.org/bot${context.credential}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: context.signal,
  }); } catch { throw new ChannelAdapterError("TELEGRAM_OUTCOME_UNKNOWN", "unknown"); }
  let decoded: unknown;
  try { decoded = await response.json(); } catch {
    throw new ChannelAdapterError("TELEGRAM_RESPONSE_INVALID", response.status >= 400 && response.status < 500 && response.status !== 408 ? "rejected" : "unknown", response.status || 502);
  }
  const value = object(decoded);
  if (!response.ok || value.ok !== true) {
    const status = !response.ok ? response.status : Number.isInteger(value.error_code) && value.error_code >= 400 && value.error_code <= 599 ? value.error_code : 502;
    const known = status >= 400 && status < 500 && status !== 408;
    throw new ChannelAdapterError("TELEGRAM_PROVIDER_ERROR", known ? "rejected" : "unknown", status,
      retryAfter(object(value.parameters).retry_after));
  }
  return value.result;
}
function mediaReference(attachment: ChannelAttachment): string {
  if (attachment.providerMediaId && !/[\u0000-\u001f\u007f]/.test(attachment.providerMediaId)) return attachment.providerMediaId;
  try { const url = new URL(attachment.url!); if (url.protocol === "https:" && !url.username && !url.password && !url.hash) return url.href; } catch {}
  throw invalid();
}
export async function sendTelegram(request: ChannelSendRequest, context: ChannelProviderContext): Promise<ChannelSendResult> {
  if (typeof context.credential !== "string" || !id(request.assetId) || !id(request.recipientId) || request.template || typeof request.text !== "string" ||
    request.attachments !== undefined && !Array.isArray(request.attachments) || (request.attachments?.length ?? 0) > 1 ||
    request.replyToProviderMessageId !== undefined && (!id(request.replyToProviderMessageId) || Number(request.replyToProviderMessageId) <= 0)) throw invalid();
  if (context.credential.split(":")[0] !== request.assetId) throw new ChannelAdapterError("TELEGRAM_ASSET_MISMATCH", "rejected", 403);
  const body: Record<string, unknown> = { chat_id: request.recipientId };
  if (request.replyToProviderMessageId) body.reply_parameters = { message_id: Number(request.replyToProviderMessageId), allow_sending_without_reply: false };
  const attachment = request.attachments?.[0]; let method = "sendMessage";
  if (attachment) {
    if (!channelAttachmentSchema.safeParse(attachment).success) throw invalid();
    const methods = { image: ["sendPhoto", "photo"], audio: ["sendAudio", "audio"], video: ["sendVideo", "video"], document: ["sendDocument", "document"] } as const;
    const selected = methods[attachment.kind]; if (!selected || [...request.text].length > 1024) throw invalid();
    method = selected[0]; body[selected[1]] = mediaReference(attachment); if (request.text) body.caption = request.text;
  } else { if (!request.text.trim() || [...request.text].length > 4096) throw invalid(); body.text = request.text; }
  const result = object(await call(context, method, body)), messageId = id(result.message_id);
  if (!messageId || Number(messageId) <= 0) throw new ChannelAdapterError("TELEGRAM_RESPONSE_INVALID", "unknown");
  return { providerMessageId: messageId, status: "accepted" };
}
export const telegramAdapter: ChannelProviderAdapter = Object.freeze({ kind: "telegram", normalize: normalizeTelegram, send: sendTelegram,
  verifyWebhook(request: ChannelWebhookRequest) {
    const secret = request.secrets.webhookSecret;
    const provided = Object.entries(request.headers).find(([key]) => key.toLowerCase() === "x-telegram-bot-api-secret-token")?.[1];
    if (!secret || !provided || !timingSafeEqual(createHash("sha256").update(secret).digest(), createHash("sha256").update(provided).digest())) {
      throw new ChannelAdapterError("TELEGRAM_SIGNATURE_INVALID", "rejected", 403);
    }
  },
});
