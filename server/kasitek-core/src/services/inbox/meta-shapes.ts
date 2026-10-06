import { obj, str, arr, firstPresent, type ObjectValue } from './types.js';
export interface MetaIncomingAttachment {
  kind: string;
  providerMediaId: string | null;
  mimeType: string | null;
  fileName: string | null;
  metadata: ObjectValue;
}
export function normalizeAttachmentKind(value: string) {
  switch (value.trim().toLowerCase()) {
    case 'image':
    case 'image_share':
      return 'image';
    case 'video':
    case 'video_share':
      return 'video';
    case 'audio':
      return 'audio';
    case 'sticker':
      return 'sticker';
    case 'file':
    case 'document':
    case 'fallback':
      return 'document';
    default:
      return 'file';
  }
}
export function metaValueIdentifier(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  return null;
}
export function metaAttachmentIsSticker(attachment: unknown, payload: unknown) {
  const a = obj(attachment),
    p = obj(payload);
  return (
    str(a.type)?.toLowerCase() === 'sticker' ||
    a.render_as_sticker === true ||
    p.render_as_sticker === true ||
    (a.sticker_id !== null && a.sticker_id !== undefined) ||
    (p.sticker_id !== null && p.sticker_id !== undefined) ||
    str(a.id)?.startsWith('sticker_') === true ||
    str(p.id)?.startsWith('sticker_') === true
  );
}
export function metaStickerId(attachment: unknown, payload: unknown) {
  const a = obj(attachment),
    p = obj(payload);
  const id = metaValueIdentifier(
    p.sticker_id === undefined ? a.sticker_id : p.sticker_id,
  );
  if (id !== null) return id;
  const raw = str(p.id === undefined ? a.id : p.id);
  return raw?.startsWith('sticker_') ? raw.slice(8) : null;
}
export function metaAttachmentMetadata(
  attachment: unknown,
  payload: unknown,
  source: string,
  sticker: boolean,
): ObjectValue {
  const a = obj(attachment),
    p = obj(payload),
    value = (key: string) => (p[key] === undefined ? (a[key] ?? null) : p[key]),
    sprite =
      firstPresent(
        obj(p.sprite_image_2x).uri,
        obj(p.sprite_image).uri,
        obj(a.sprite_image_2x).uri,
        obj(a.sprite_image).uri,
      ) ?? null;
  return {
    providerPayload: payload,
    providerSource: source,
    sticker: sticker
      ? {
          id: metaStickerId(a, p),
          renderAsSticker: true,
          animation: {
            spriteUrl: sprite,
            framesPerRow: value('frames_per_row'),
            framesPerColumn: value('frames_per_column'),
            frameCount: value('frame_count'),
            frameRate: value('frame_rate'),
          },
        }
      : null,
  };
}
export function metaMessageAttachments(raw: unknown): MetaIncomingAttachment[] {
  const attachments = arr(obj(raw).attachments).map((raw) => {
    const a = obj(raw),
      payload = a.payload ?? null,
      p = obj(payload),
      sticker = metaAttachmentIsSticker(a, p);
    return {
      kind: sticker
        ? 'sticker'
        : normalizeAttachmentKind(str(a.type) ?? 'attachment'),
      providerMediaId: metaValueIdentifier(
        p.id === undefined
          ? a.id === undefined
            ? p.sticker_id === undefined
              ? a.sticker_id
              : p.sticker_id
            : a.id
          : p.id,
      ),
      mimeType: str(p.mime_type),
      fileName: str(p.name === undefined ? p.filename : p.name),
      metadata: metaAttachmentMetadata(a, payload, 'webhook', sticker),
    };
  });
  const urls = new Set(
      attachments
        .filter((a) => a.kind === 'sticker')
        .map((a) => str(obj(a.metadata.providerPayload).url))
        .filter((v): v is string => v !== null),
    ),
    retained = new Set<string>();
  return attachments.filter((a) => {
    const url = str(obj(a.metadata.providerPayload).url);
    if (a.kind === 'sticker') {
      if (url === null) return true;
      if (retained.has(url)) return false;
      retained.add(url);
      return true;
    }
    return url === null || !urls.has(url);
  });
}
export function metaGraphMessageAttachments(
  raw: unknown,
): MetaIncomingAttachment[] {
  return arr(obj(obj(raw).attachments).data).map((raw) => {
    const a = obj(raw),
      sticker = metaAttachmentIsSticker(a, a);
    return {
      kind: sticker
        ? 'sticker'
        : normalizeAttachmentKind(
            str(a.mime_type)?.split('/')[0] ?? 'attachment',
          ),
      providerMediaId: str(a.id),
      mimeType: str(a.mime_type),
      fileName: str(a.name === undefined ? a.filename : a.name),
      metadata: metaAttachmentMetadata(a, a, 'graph_message', sticker),
    };
  });
}
export const metaMessageIsEcho = (value: unknown) => {
  const m = obj(value),
    echo = m.is_echo === undefined ? m.is_self : m.is_echo;
  return typeof echo === 'boolean' ? echo : false;
};
export const metaReplyToMid = (value: unknown) =>
  str(obj(obj(value).reply_to).mid)?.trim() || null;
export const metaDeliveryMessageIds = (value: unknown) =>
  arr(obj(value).mids).filter((v): v is string => typeof v === 'string');
export function metaReadMessageIds(value: unknown) {
  const m = obj(value),
    ids = arr(m.mids)
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean),
    id = str(m.mid === undefined ? m.message_id : m.mid)?.trim();
  if (id) ids.push(id);
  return [...new Set(ids)].sort();
}
export function metaReceiptWatermark(value: unknown): bigint | null {
  const v = obj(value).watermark;
  if (
    (typeof v === 'string' && /^[+-]?\d+$/.test(v)) ||
    typeof v === 'bigint' ||
    (typeof v === 'number' && Number.isInteger(v))
  ) {
    const n = BigInt(v);
    return n >= -(1n << 63n) && n < 1n << 63n ? n : null;
  }
  return null;
}
export function metaProfileDisplayName(raw: unknown) {
  const value = obj(raw),
    name = str(value.name)?.trim();
  if (name) return name;
  const full = [str(value.first_name)?.trim(), str(value.last_name)?.trim()]
    .filter(Boolean)
    .join(' ');
  if (full) return full;
  const username = str(value.username)?.trim();
  return username ? '@' + username : null;
}
export function metaGraphMessageRecipientName(value: unknown, id: string) {
  return (
    str(
      arr(obj(obj(value).to).data)
        .map(obj)
        .find((v) => v.id === id)?.name,
    )?.trim() || null
  );
}
export function metaMessageResponderType(row: {
  sender: string;
  provider_metadata: unknown;
}) {
  const metadata = obj(row.provider_metadata);
  if (row.sender === 'customer') return 'customer';
  if (str(metadata._kasitek_agent_idempotency_key)) return 'agent';
  if (metadata._kasitek_inbox_message_kind === 'template') return 'system';
  return 'human';
}
export function sanitizeAttachmentFilename(value: string) {
  return (
    Array.from(value)
      .map((v) => (/^[A-Za-z0-9.\-_ ]$/.test(v) ? v : '_'))
      .join('')
      .trim() || 'attachment.bin'
  );
}
