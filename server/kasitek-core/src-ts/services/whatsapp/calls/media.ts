import type { Pool } from 'pg';
import { STATUS_CODES } from 'node:http';
import { parseCanonicalJson } from '@kasitek/server-support/json';
import type { CoreConfig } from '../../../config.js';
import { decryptSocialSecret } from '../../../integrations/crypto.js';
import { SQL } from './sql.js';
import {
  object,
  text,
  bad,
  internal,
  missing,
  json,
  type CallRow,
  type CallsOptions,
} from './types.js';
export function metaOfferSession(payload: unknown): unknown | null {
  const p = object(payload),
    session = p.session !== undefined ? p.session : object(p.call).session;
  return text(object(session).sdp)?.trim() ? session : null;
}
export async function loadMetaOffer(pool: Pool, call: CallRow) {
  const existing = metaOfferSession(call.raw_payload);
  if (existing !== null) return existing;
  const payload = (
    await pool.query(SQL.load_meta_offer_session![0]!, [call.id])
  ).rows[0]?.payload;
  return metaOfferSession(payload);
}
export function normalizeSdp(sdp: string) {
  const lines = sdp
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map((s) => s.trimEnd())
    .filter((s) => s !== '');
  return lines.length ? lines.join('\r\n') + '\r\n' : '';
}
export function directMediaSession(call: CallRow, session: unknown) {
  const s = object(session),
    sdp = typeof s.sdp === 'string' ? normalizeSdp(s.sdp) : '';
  if (!sdp) bad('Incoming Meta call SDP offer is empty');
  return {
    provider: 'meta-direct-webrtc',
    callId: call.id,
    waCallId: call.wa_call_id,
    conversationId: call.conversation_id,
    agentRole: 'agent',
    canAccept: ['RINGING', 'CONNECTING'].includes(call.status),
    canEnd: ['ACTIVE', 'CONNECTING', 'RINGING'].includes(call.status),
    webrtc: { sdpType: text(s.sdp_type) ?? 'offer', sdp },
  };
}
export async function manageMetaCall(
  pool: Pool,
  config: CoreConfig,
  call: CallRow,
  action: string,
  session: unknown | null,
  options: CallsOptions,
) {
  const id = call.wa_call_id?.trim();
  if (!id) bad('WhatsApp call id is missing');
  const auth =
      (
        await pool.query(SQL.load_call_connection_auth![0]!, [
          call.connection_id,
        ])
      ).rows[0] ?? missing('WhatsApp connection not found for call'),
    token = decryptSocialSecret(config, auth.access_token_encrypted),
    payload = {
      messaging_product: 'whatsapp',
      call_id: id,
      action,
      ...(session === null ? {} : { session }),
    };
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(
      `${options.graphBase ?? 'https://graph.facebook.com/v19.0'}/${auth.phone_number_id}/calls`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: json(payload),
      },
    );
  } catch {
    internal('External request failed');
  }
  let body: unknown = null;
  try {
    body = parseCanonicalJson(await response.text());
  } catch {}
  if (!response.ok)
    bad(
      `Meta Calling API request failed (${response.status} ${response.statusText || STATUS_CODES[response.status] || ''}): ${text(object(object(body).error).message) ?? text(object(body).message) ?? 'Unknown error'}`,
    );
  return body;
}
