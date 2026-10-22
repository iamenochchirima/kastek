import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { channelAttachmentSchema,channelButtonsSchema, channelWebhookEventSchema, ChannelAdapterError, type ChannelAttachment, type ChannelProviderAdapter,
  type ChannelProviderContext, type ChannelSendRequest, type ChannelSendResult, type ChannelWebhookEvent, type ChannelWebhookRequest } from "../../../contracts/channel-adapters";

const object = (value: unknown): Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const invalid = () => new ChannelAdapterError("WHATSAPP_REQUEST_INVALID", "rejected", 400);
function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{1,13}$/.test(value)) return null;
  const date = new Date(Number(value) * 1000); return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function normalizeMessage(raw: unknown, assetId: string, echo: boolean): ChannelWebhookEvent | undefined {
  const message = object(raw), senderId = string(message.from), recipient = echo ? string(message.to) : senderId;
  const providerMessageId = string(message.id); if (!senderId || !recipient || !providerMessageId) throw invalid();
  let text = string(object(message.text).body), interaction: string | undefined;
  const attachments: ChannelAttachment[] = [];
  for (const [field, kind] of [["image", "image"], ["sticker", "image"], ["audio", "audio"], ["video", "video"], ["document", "document"]] as const) {
    if (message.type !== field) continue;
    const media = object(message[field]), mediaId = string(media.id); if (!mediaId) throw invalid();
    attachments.push({ kind, providerMediaId: mediaId, ...(string(media.mime_type) ? { mimeType: media.mime_type } : {}),
      ...(string(media.filename) ? { fileName: media.filename } : {}) }); text = string(media.caption);
  }
  if (message.type === "interactive") {
    const button = object(object(message.interactive).button_reply ?? object(message.interactive).list_reply);
    interaction = string(button.id); text = string(button.title); if (!interaction) throw invalid();
  } else if (message.type === "button") { interaction = string(object(message.button).payload); text = string(object(message.button).text); }
  if (!text && !attachments.length && !interaction) return undefined;
  return { kind: interaction ? "interaction" : "message", assetId, eventId: providerMessageId, externalConversationId: recipient,
    senderId, providerMessageId, occurredAt: timestamp(message.timestamp), ...(text ? { text } : {}), attachments, echo,
    ...(interaction ? { interaction } : {}), ...(string(object(message.context).id) ? { replyToProviderMessageId: message.context.id } : {}) };
}
export function normalizeWhatsapp(payload: unknown, context?: { assetId: string }): ChannelWebhookEvent[] {
  const events: ChannelWebhookEvent[] = [];
  if (object(payload).object !== "whatsapp_business_account") return events;
  for (const entry of array(object(payload).entry)) for (const change of array(object(entry).changes)) {
    const value = object(object(change).value), assetId = string(object(value.metadata).phone_number_id);
    if (!assetId) { if (array(value.messages).length || array(value.statuses).length) throw invalid(); continue; }
    if (context && context.assetId !== assetId) throw new ChannelAdapterError("WHATSAPP_ASSET_MISMATCH", "rejected", 403);
    for (const raw of array(value.messages)) {
      const event = normalizeMessage(raw, assetId, object(change).field === "smb_message_echoes" || object(raw).echo === true || object(raw).is_echo === true);
      if (event) events.push(event);
    }
    for (const raw of array(value.message_echoes)) { const event = normalizeMessage(raw, assetId, true); if (event) events.push(event); }
    for (const raw of array(value.statuses)) {
      const status = object(raw), providerMessageId = string(status.id), recipient = string(status.recipient_id);
      if (!["sent", "delivered", "read", "failed"].includes(status.status)) continue;
      if (!providerMessageId || !recipient) throw invalid();
      events.push({ kind: "receipt", assetId, eventId: `receipt:${createHash("sha256").update(JSON.stringify([assetId, providerMessageId, status.status, status.timestamp ?? null])).digest("hex")}`,
        externalConversationId: recipient, senderId: recipient, providerMessageId, occurredAt: timestamp(status.timestamp),
        attachments: [], echo: false, status: status.status, ...(object(array(status.errors)[0]).code !== undefined ? { errorCode: String(object(array(status.errors)[0]).code) } : {}) });
    }
  }
  return events.map(event => { const parsed = channelWebhookEventSchema.safeParse(event); if (!parsed.success) throw invalid(); return parsed.data; });
}
function mediaPayload(attachment: ChannelAttachment): Record<string, string> {
  let value: Record<string, string>;
  if (attachment.providerMediaId && !/[\u0000-\u001f\u007f]/.test(attachment.providerMediaId)) value = { id: attachment.providerMediaId };
  else { try { const url = new URL(attachment.url!); if (url.protocol !== "https:" || url.username || url.password || url.hash) throw invalid(); value = { link: url.href }; } catch { throw invalid(); } }
  if (attachment.kind === "document" && attachment.fileName) value.filename = attachment.fileName;
  return value;
}
export async function sendWhatsapp(request: ChannelSendRequest, context: ChannelProviderContext): Promise<ChannelSendResult> {
  if (!/^v\d{1,3}\.\d{1,2}$/.test(context.apiVersion ?? "") || context.mode === "instagram_login") throw new ChannelAdapterError("WHATSAPP_VERSION_REQUIRED", "rejected", 400);
  if (!/^\d{1,32}$/.test(request.assetId) || !/^\+?\d{1,32}$/.test(request.recipientId) || !context.credential || /[\r\n]/.test(context.credential) ||
    typeof context.fetch !== "function" || typeof request.text !== "string" || request.attachments !== undefined && !Array.isArray(request.attachments) ||
    (request.attachments?.length ?? 0) > 1) throw invalid();
  const body: Record<string, unknown> = { messaging_product: "whatsapp", recipient_type: "individual", to: request.recipientId };
  if (request.replyToProviderMessageId) { if (/[\u0000-\u001f\u007f]/.test(request.replyToProviderMessageId)) throw invalid(); body.context = { message_id: request.replyToProviderMessageId }; }
  const attachment = request.attachments?.[0];
  if(request.buttons){
    const parsed=channelButtonsSchema.safeParse(request.buttons);if(!parsed.success||request.template||attachment||!request.text.trim()||[...request.text].length>1024)throw invalid();
    body.type="interactive";body.interactive={type:"button",body:{text:request.text},action:{buttons:parsed.data.map(button=>({type:"reply",reply:{id:button.payload,title:button.title}}))}};
  }else if (request.template) {
    if (attachment || request.text || !/^[a-z0-9_]{1,512}$/.test(request.template.name) || !/^[A-Za-z0-9_-]{1,32}$/.test(request.template.language) ||
      (request.template.components?.length ?? 0) > 16) throw invalid();
    body.type = "template"; body.template = { name: request.template.name, language: { code: request.template.language },
      ...(request.template.components ? { components: request.template.components } : {}) };
  } else if (attachment) {
    if (!channelAttachmentSchema.safeParse(attachment).success) throw invalid();
    if (!["image", "audio", "video", "document"].includes(attachment.kind) || [...request.text].length > 1024 || attachment.kind === "audio" && request.text) throw invalid();
    const media = mediaPayload(attachment); if (request.text) media.caption = request.text; body.type = attachment.kind; body[attachment.kind] = media;
  } else { if (!request.text.trim() || [...request.text].length > 4096) throw invalid(); body.type = "text"; body.text = { body: request.text }; }
  let serialized: string; try { serialized = JSON.stringify(body); } catch { throw invalid(); }
  if (context.signal?.aborted) throw new ChannelAdapterError("WHATSAPP_CANCELLED", "rejected", 409);
  let response: Response;
  try { response = await context.fetch(`https://graph.facebook.com/${context.apiVersion}/${request.assetId}/messages`, { method: "POST",
    headers: { authorization: `Bearer ${context.credential}`, "content-type": "application/json" }, body: serialized, signal: context.signal }); }
  catch { throw new ChannelAdapterError("WHATSAPP_OUTCOME_UNKNOWN", "unknown"); }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch {}
    const retry = response.headers.get("retry-after"), retryMs = retry && /^\d{1,5}$/.test(retry) ? Number(retry) * 1000 : undefined;
    throw new ChannelAdapterError("WHATSAPP_PROVIDER_ERROR", response.status >= 400 && response.status < 500 && response.status !== 408 ? "rejected" : "unknown", response.status, retryMs);
  }
  let decoded: unknown; try { decoded = await response.json(); } catch { throw new ChannelAdapterError("WHATSAPP_RESPONSE_INVALID", "unknown"); }
  const messages = object(decoded).messages, messageId = Array.isArray(messages) && messages.length === 1 ? string(object(messages[0]).id) : undefined;
  if (!messageId || /[\u0000-\u001f\u007f]/.test(messageId)) throw new ChannelAdapterError("WHATSAPP_RESPONSE_INVALID", "unknown");
  return { providerMessageId: messageId, status: "accepted" };
}
export const whatsappAdapter: ChannelProviderAdapter = Object.freeze({ kind: "whatsapp", normalize: normalizeWhatsapp, send: sendWhatsapp,
  verifyWebhook(request: ChannelWebhookRequest) {
    const secret = request.secrets.appSecret, signature = Object.entries(request.headers).find(([key]) => key.toLowerCase() === "x-hub-signature-256")?.[1];
    if (!secret || !signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature) ||
      !timingSafeEqual(createHmac("sha256", secret).update(request.rawBody).digest(), Buffer.from(signature.slice(7), "hex"))) {
      throw new ChannelAdapterError("WHATSAPP_SIGNATURE_INVALID", "rejected", 403);
    }
  },
  verifyChallenge(query: Readonly<Record<string, string | undefined>>, verifyToken: string) {
    if (!verifyToken || !query["hub.verify_token"] || query["hub.mode"] !== "subscribe" || !query["hub.challenge"] ||
      !timingSafeEqual(createHash("sha256").update(verifyToken).digest(), createHash("sha256").update(query["hub.verify_token"]).digest())) {
      throw new ChannelAdapterError("WHATSAPP_CHALLENGE_INVALID", "rejected", 403);
    }
    return query["hub.challenge"];
  },
});
