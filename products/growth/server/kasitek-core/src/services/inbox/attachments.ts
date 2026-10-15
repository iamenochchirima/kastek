import type { Pool } from 'pg';
import { ApiError } from '../../error.js';
import { decryptSocialSecret } from '../../integrations/crypto.js';
import * as sql from './inbox-sql.js';
import { META_GRAPH_BASE, INSTAGRAM_GRAPH_BASE } from './meta-provider.js';
import {
  metaAttachmentIsSticker,
  sanitizeAttachmentFilename,
} from './meta-shapes.js';
import {
  obj,
  firstPresent,
  arr,
  str,
  type InboxOptions,
  type AttachmentDownload,
} from './types.js';
export function selectMetaAttachmentUrl(
  payload: unknown,
  mediaId: string | null,
  sticker: boolean,
): string | null {
  const p = obj(payload),
    attachments = arr(firstPresent(obj(p.attachments).data, p.data)).map(obj),
    selected =
      attachments.find((a) => mediaId !== null && a.id === mediaId) ??
      (sticker
        ? attachments.find((a) => metaAttachmentIsSticker(a, a))
        : undefined) ??
      (sticker && attachments.length === 1 ? attachments[0] : undefined);
  return str(firstPresent(obj(selected?.image_data).url, selected?.url));
}
async function fetchLookup(url: string, token: string, options: InboxOptions) {
  try {
    const response = await (options.fetch ?? fetch)(url, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      payload = await response.json();
    return response.ok ? payload : null;
  } catch {
    return null;
  }
}
async function resolveMetaMessageAttachmentUrl(
  base: string,
  token: string,
  messageId: string | null,
  mediaId: string | null,
  sticker: boolean,
  options: InboxOptions,
) {
  if (messageId === null) return null;
  const node = await fetchLookup(
      `${base}/${messageId}?fields=attachments`,
      token,
      options,
    ),
    url = selectMetaAttachmentUrl(node, mediaId, sticker);
  if (url !== null) return url;
  return selectMetaAttachmentUrl(
    await fetchLookup(
      `${base}/${messageId}/attachments?fields=id%2Curl%2Cimage_data`,
      token,
      options,
    ),
    mediaId,
    sticker,
  );
}
export async function downloadMessageAttachment(
  pool: Pool,
  org: string,
  messageId: string,
  id: string,
  options: InboxOptions,
): Promise<AttachmentDownload> {
  const row = (
    await pool.query(sql.DOWNLOAD_MESSAGE_ATTACHMENT_0, [id, messageId, org])
  ).rows[0];
  if (!row) throw new ApiError(404, 'not_found', 'Attachment not found');
  if (row.accessToken === null)
    throw new ApiError(
      400,
      'bad_request',
      'Connected channel is missing an access token',
    );
  const token = decryptSocialSecret(options.config, row.accessToken),
    base =
      row.channel === 'instagram' &&
      obj(row.channel_metadata).authMethod === 'instagram_login'
        ? INSTAGRAM_GRAPH_BASE
        : META_GRAPH_BASE,
    payload = obj(obj(row.attachment_metadata).providerPayload),
    payloadUrl = str(
      firstPresent(
        obj(payload.image_data).url,
        payload.url,
        payload.attachment_url,
      ),
    ),
    metadata = obj(row.providerMetadata),
    message = obj(
      metadata.graphMessage === undefined
        ? metadata.event
        : metadata.graphMessage,
    ),
    providerMessageId = str(
      message.id === undefined ? obj(message.message).mid : message.id,
    );
  let url: string | null = null,
    source = 'graph_message_attachment';
  if (row.kind === 'sticker')
    url = await resolveMetaMessageAttachmentUrl(
      base,
      token,
      providerMessageId,
      row.providerMediaId,
      true,
      options,
    );
  if (url === null && payloadUrl !== null) {
    url = payloadUrl;
    source = 'webhook_payload';
  }
  if (url === null && row.providerMediaId !== null) {
    url = await resolveMetaMessageAttachmentUrl(
      base,
      token,
      providerMessageId,
      row.providerMediaId,
      false,
      options,
    );
    if (url === null) {
      url = str(
        obj(
          await fetchLookup(
            `${base}/${row.providerMediaId}?fields=url`,
            token,
            options,
          ),
        ).url,
      );
      source = 'graph_media_node';
    }
  }
  if (url === null)
    throw new ApiError(
      400,
      'bad_request',
      'Attachment download is not available from this channel',
    );
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(
      400,
      'bad_request',
      'Provider returned an invalid attachment URL',
    );
  }
  if (
    parsed.protocol !== 'https:' ||
    ![
      'facebook.com',
      'fbcdn.net',
      'fbsbx.com',
      'instagram.com',
      'cdninstagram.com',
    ].some((suffix) => parsed.hostname.endsWith(suffix))
  )
    throw new ApiError(
      400,
      'bad_request',
      'Provider returned an untrusted attachment URL',
    );
  const response = await (options.fetch ?? fetch)(parsed, {
    redirect: 'manual',
  });
  if (!response.ok)
    throw new ApiError(
      400,
      'bad_request',
      `Provider attachment download failed (${response.status} ${response.statusText})`,
    );
  const max = 25 * 1024 * 1024,
    length = response.headers.get('content-length');
  if (length !== null && Number(length) > max)
    throw new ApiError(
      400,
      'bad_request',
      'Attachment exceeds the 25 MB download limit',
    );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > max)
    throw new ApiError(
      400,
      'bad_request',
      'Attachment exceeds the 25 MB download limit',
    );
  const contentType =
      response.headers.get('content-type') ??
      row.mimeType ??
      'application/octet-stream',
    extension = contentType.split('/')[1] ?? 'bin';
  return {
    bytes,
    contentType,
    fileName: sanitizeAttachmentFilename(
      row.fileName ??
        `${row.platform.toLowerCase()}-attachment-${id}.${extension}`,
    ),
    cacheControl: 'private, max-age=60',
    mediaSource: source,
  };
}
