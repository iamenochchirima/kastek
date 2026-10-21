import { createHash } from "node:crypto";
import { ChannelAdapterError, channelWebhookEventSchema, type ChannelAttachment, type ChannelWebhookEvent } from "../../../contracts/channel-adapters";

type Fields = Record<string, unknown>;
const object = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string | undefined => typeof value === "string" && value.length ? value : undefined;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function identifier(kind: string, assetId: string, identity: unknown): string {
  return `meta:${kind}:${createHash("sha256").update(canonical({ assetId, identity })).digest("hex")}`;
}
function timestamp(value: unknown): string | null {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || Number(number) < 0 || Number(number) > 8640000000000000) return null;
  return new Date(Number(number)).toISOString();
}
function watermark(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}
function url(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { const parsed = new URL(value); return parsed.protocol === "https:" && !parsed.username && !parsed.password ? value : undefined; } catch { return undefined; }
}
function media(raw: unknown): { attachments: ChannelAttachment[]; unsupported: Fields[] } {
  const attachments: ChannelAttachment[] = [], unsupported: Fields[] = [], seen = new Set<string>();
  const stickerUrls = new Set(array(raw).filter(item => object(item).type === "sticker" || object(item).render_as_sticker === true || object(object(item).payload).render_as_sticker === true).map(item => url(object(object(item).payload).url)).filter(Boolean));
  for (const item of array(raw)) {
    const attachment = object(item), payload = object(attachment.payload), sourceType = string(attachment.type) ?? "unknown";
    const sticker = sourceType === "sticker" || attachment.render_as_sticker === true || payload.render_as_sticker === true;
    const type = sticker || sourceType === "image_share" ? "image" : sourceType === "video_share" ? "video"
      : ["file", "document"].includes(sourceType) ? "document" : sourceType;
    const link = url(payload.url), providerMediaId = string(payload.id) ?? string(payload.attachment_id), mimeType = string(payload.mime_type), fileName = string(payload.name) ?? string(payload.filename);
    if (!["image", "audio", "video", "document"].includes(type) || !link && !providerMediaId) {
      unsupported.push({ type: sourceType, ...(link ? { url: link } : {}), ...(providerMediaId ? { providerMediaId } : {}) }); continue;
    }
    if (sourceType !== "sticker" && !sticker && link && stickerUrls.has(link)) continue;
    const identity = canonical({ type, url: link ?? null, providerMediaId: link ? null : providerMediaId ?? null });
    if (seen.has(identity)) continue; seen.add(identity);
    attachments.push({ kind: type as ChannelAttachment["kind"], ...(sticker || sourceType !== type ? { providerType: sticker ? "sticker" : sourceType } : {}), ...(link ? { url: link } : {}), ...(providerMediaId ? { providerMediaId } : {}),
      ...(mimeType ? { mimeType } : {}), ...(fileName ? { fileName } : {}) });
  }
  return { attachments, unsupported };
}

/** Native envelope shapes match Growth's audited Meta integration and Meta's published webhook collection. */
export function normalizeMetaWebhook(kind: "facebook" | "instagram", raw: unknown): ChannelWebhookEvent[] {
  const payload = object(raw), expectedObject = kind === "facebook" ? "page" : "instagram";
  if (payload.object !== expectedObject) return [];
  if (!Array.isArray(payload.entry)) throw new ChannelAdapterError("CHANNEL_WEBHOOK_PAYLOAD_INVALID", "rejected", 400);
  const normalized: ChannelWebhookEvent[] = [];
  const append = (event: unknown) => {
    const parsed = channelWebhookEventSchema.safeParse(event);
    if (!parsed.success) throw new ChannelAdapterError("CHANNEL_WEBHOOK_EVENT_INVALID", "rejected", 400);
    normalized.push(parsed.data);
  };
  for (const rawEntry of payload.entry) {
    const entry = object(rawEntry), assetId = string(entry.id); if (!assetId) continue;
    for (const rawEvent of array(entry.messaging)) {
      const event = object(rawEvent), senderId = string(object(event.sender).id), recipientId = string(object(event.recipient).id);
      if (!senderId || !recipientId || senderId !== assetId && recipientId !== assetId) continue;
      const message = object(event.message);
      const echo: boolean = message.is_echo === true || message.is_self === true || senderId === assetId;
      const customer: string = echo ? recipientId : senderId; if (customer === assetId) continue;
      const base = { assetId, externalConversationId: `${assetId}:${customer}`, senderId,
        occurredAt: timestamp(event.timestamp), providerMessageId: null, attachments: [], echo };
      const receipt = event.delivery !== undefined ? object(event.delivery) : event.read !== undefined ? object(event.read) : undefined;
      if (receipt) {
        const status = event.delivery !== undefined ? "delivered" : "read", receiptWatermark = watermark(receipt.watermark);
        const ids = [...new Set([...array(receipt.mids), receipt.mid, receipt.message_id].filter((value): value is string => typeof value === "string" && value.length > 0))];
        for (const mid of ids.length ? ids : receiptWatermark ? [null] : []) append({ ...base, kind: "receipt", status,
          eventId: identifier(status, assetId, { senderId, mid, watermark: receiptWatermark ?? null }), providerMessageId: mid,
          ...(receiptWatermark ? { receiptWatermark } : {}), occurredAt: base.occurredAt ?? timestamp(receiptWatermark) });
        continue;
      }
      if (event.reaction !== undefined) {
        const reaction = object(event.reaction), mid = string(reaction.mid); if (!mid) continue;
        append({ ...base, kind: "interaction", providerMessageId: mid, eventId: identifier("reaction", assetId, event),
          interaction: canonical({ type: "reaction", action: string(reaction.action) ?? "react", emoji: string(reaction.reaction) ?? string(reaction.emoji) ?? null }) }); continue;
      }
      if (event.postback !== undefined) {
        const postback = object(event.postback);
        append({ ...base, kind: "interaction", providerMessageId: string(postback.mid) ?? null, eventId: identifier("postback", assetId, event),
          interaction: canonical({ type: "postback", payload: string(postback.payload) ?? null, title: string(postback.title) ?? null }) }); continue;
      }
      if (event.message === undefined) continue;
      const mid = string(message.mid), text = string(message.text), replyToProviderMessageId = string(object(message.reply_to).mid);
      if (message.is_deleted === true || message.is_unsupported === true) {
        append({ ...base, kind: "interaction", providerMessageId: mid ?? null, eventId: identifier("message-state", assetId, event),
          interaction: canonical({ type: message.is_deleted === true ? "message_deleted" : "message_unsupported", ...(text ? { text } : {}) }) }); continue;
      }
      const attachments = media(message.attachments);
      if (text || attachments.attachments.length) append({ ...base, kind: "message", providerMessageId: mid ?? null,
        eventId: identifier(echo ? "echo" : "message", assetId, mid ?? event), ...(text ? { text } : {}), attachments: attachments.attachments,
        ...(replyToProviderMessageId ? { replyToProviderMessageId } : {}),
        ...(message.quick_reply ? { interaction: canonical({ type: "quick_reply", payload: string(object(message.quick_reply).payload) ?? null }) } : {}) });
      const story = object(object(message.reply_to).story);
      if (attachments.unsupported.length || Object.keys(story).length) append({ ...base, kind: "interaction", providerMessageId: mid ?? null,
        eventId: identifier("shared-media", assetId, event), interaction: canonical({ type: "shared_media", attachments: attachments.unsupported,
          ...(url(story.url) ? { story: { url: url(story.url), id: string(story.id) ?? null } } : {}) }) });
    }
  }
  return normalized;
}
