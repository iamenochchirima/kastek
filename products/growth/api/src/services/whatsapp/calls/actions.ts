import type { Pool } from 'pg';
import type { CoreConfig } from '../../../config.js';
import { SQL } from './sql.js';
import { scopedCall, appendCallEvent } from './read.js';
import {
  loadMetaOffer,
  directMediaSession,
  normalizeSdp,
  manageMetaCall,
} from './media.js';
import {
  object,
  text,
  bad,
  callView,
  publish,
  json,
  type CallsOptions,
} from './types.js';
export interface CallSignalInput {
  kind?: string | null;
  payload?: unknown;
  source?: string | null;
}
export interface CallActionInput {
  action?: string | null;
}
export async function getCallMediaSession(pool: Pool, org: string, id: string) {
  const call = await scopedCall(pool, org, id),
    session = await loadMetaOffer(pool, call);
  if (session === null) bad('Incoming Meta call SDP offer is unavailable');
  return {
    call: callView(call),
    mediaSession: directMediaSession(call, session),
  };
}
export async function postCallSignal(
  pool: Pool,
  config: CoreConfig,
  org: string,
  id: string,
  input: CallSignalInput,
  options: CallsOptions = {},
) {
  const kind = input.kind?.trim().toLowerCase();
  if (!kind) bad('Signal kind is required');
  const existing = await scopedCall(pool, org, id),
    source = input.source?.trim() || 'agent-ui',
    payload = input.payload ?? null;
  await appendCallEvent(
    pool,
    existing.id,
    `call.signal.${kind}`,
    existing.status,
    { kind, source, payload },
  );
  await publish(
    pool,
    config,
    org,
    {
      type: 'call.signal',
      callId: existing.id,
      kind,
      source,
      signal: payload,
      call: callView(existing),
    },
    options,
  );
  if ((await loadMetaOffer(pool, existing)) === null)
    bad('Incoming Meta call SDP offer is unavailable');
  if (kind === 'answer') {
    if (input.payload == null) bad('Answer payload is required');
    const signal = object(input.payload),
      sdp = typeof signal.sdp === 'string' ? normalizeSdp(signal.sdp) : '';
    if (!sdp) bad('Answer SDP is required');
    const response = await manageMetaCall(
      pool,
      config,
      existing,
      'accept',
      { sdp_type: text(signal.type) ?? 'answer', sdp },
      options,
    );
    return {
      ok: true,
      callId: id,
      kind,
      providerResult: {
        provider: 'meta-direct-webrtc',
        action: 'accept',
        graphResponse: response,
      },
    };
  }
  return {
    ok: true,
    callId: id,
    kind,
    providerResult: {
      provider: 'meta-direct-webrtc',
      ignored: true,
      note: 'Only the SDP answer is sent back to Meta in the direct WebRTC flow.',
    },
  };
}
export async function applyCallAction(
  pool: Pool,
  config: CoreConfig,
  org: string,
  id: string,
  input: CallActionInput,
  options: CallsOptions = {},
) {
  const action = input.action?.trim();
  if (!action) bad('Call action is required');
  const existing = await scopedCall(pool, org, id),
    offer = await loadMetaOffer(pool, existing);
  if (offer === null) bad('Incoming Meta call SDP offer is unavailable');
  if (action === 'accept' && existing.status !== 'RINGING')
    bad('Only ringing calls can be accepted');
  if (
    action === 'reject' &&
    !['RINGING', 'CONNECTING'].includes(existing.status)
  )
    bad('Only ringing or connecting calls can be rejected');
  if (
    action === 'end' &&
    !['RINGING', 'CONNECTING', 'ACTIVE'].includes(existing.status)
  )
    bad('Only ringing, connecting, or active calls can be ended');
  const now = new Date();
  let status: string,
    ended: Date | null,
    duration: number | null,
    event: string;
  switch (action) {
    case 'accept':
      status = 'CONNECTING';
      ended = null;
      duration = null;
      event = 'call.accept.requested';
      break;
    case 'reject':
      status = 'REJECTED';
      ended = now;
      duration = 0;
      event = 'call.rejected';
      break;
    case 'end':
      status = existing.answered_at ? 'COMPLETED' : 'CANCELLED';
      ended = now;
      duration = existing.answered_at
        ? Number(
            BigInt.asIntN(
              32,
              BigInt(
                Math.max(0, Math.trunc((+now - +existing.answered_at) / 1000)),
              ),
            ),
          )
        : null;
      event = 'call.ended';
      break;
    default:
      bad('Unsupported call action. Use accept, reject, or end');
  }
  await pool.query(SQL.apply_call_action![0]!, [
    status,
    existing.answered_at,
    ended,
    duration,
    id,
    org,
  ]);
  await appendCallEvent(pool, id, event, status, { action, appliedAt: now });
  const call = await scopedCall(pool, org, id);
  let providerAction: unknown;
  switch (action) {
    case 'accept':
      providerAction = {
        provider: 'meta-direct-webrtc',
        action,
        mediaSession: directMediaSession(call, offer),
        awaitingLocalAnswer: true,
        note: 'Browser must create an SDP answer and post it back before Meta considers the call accepted.',
      };
      break;
    case 'reject':
      providerAction = {
        provider: 'meta-direct-webrtc',
        action,
        graphResponse: await manageMetaCall(
          pool,
          config,
          call,
          'reject',
          null,
          options,
        ),
      };
      break;
    case 'end':
      providerAction = {
        provider: 'meta-direct-webrtc',
        action,
        graphResponse: await manageMetaCall(
          pool,
          config,
          call,
          'terminate',
          null,
          options,
        ),
      };
      break;
  }
  await publish(
    pool,
    config,
    org,
    {
      type: 'call.updated',
      callId: call.id,
      call: callView(call),
      action,
      provider: object(providerAction).provider ?? null,
    },
    options,
  );
  return { call: callView(call), providerAction };
}
