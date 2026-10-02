import type { Pool } from 'pg';
import type { CoreConfig } from '../../../config.js';
import { parseOptionalDatetime } from '../../social/common.js';
import { SerdeFloat } from '@kasitek/server-support/json';
import { createId } from '@paralleldrive/cuid2';
import { ensureWhatsappCustomer } from '../../customers.js';
import { SQL } from './sql.js';
import { appendCallEvent, existingCall, scopedCall } from './read.js';
import {
  object,
  text,
  bad,
  callView,
  json,
  publish,
  push,
  type Row,
  type CallsOptions,
} from './types.js';
const first = (row: Row, key: string, alt: string) =>
  row[key] !== undefined ? row[key] : row[alt];
export const normalizeCallPhone = (raw: string) => raw.replace(/[^0-9+]/g, '');
function i64(value: unknown): bigint | null {
  if (value instanceof SerdeFloat) return null;
  if (typeof value === 'bigint')
    return value >= -(1n << 63n) && value < 1n << 63n ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value))
    return BigInt(value);
  return null;
}
export function parseCallTimestamp(value: unknown): Date | null {
  if (typeof value === 'string') {
    if (/^\d{4}-\d\d-\d\d[Tt].*(?:[Zz]|[+-]\d\d:\d\d)$/.test(value)) {
      try {
        return parseOptionalDatetime(value);
      } catch {}
    }
    if (/^[+-]?\d+$/.test(value)) value = BigInt(value);
  }
  const seconds = i64(value);
  if (seconds == null) return null;
  const milliseconds = Number(seconds) * 1000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date : null;
}
export function mapCallDirection(value: unknown, businessPhone: string) {
  const call = object(value),
    direction = text(call.direction)?.trim().toUpperCase();
  if (direction === 'OUTBOUND' || direction === 'INBOUND') return direction;
  return businessPhone &&
    normalizeCallPhone(text(call.from) ?? '') === businessPhone
    ? 'OUTBOUND'
    : 'INBOUND';
}
export function mapCallStatus(value: unknown) {
  const call = object(value),
    event = (text(call.event) ?? '').trim().toLowerCase(),
    status = (text(first(call, 'call_status', 'status')) ?? '')
      .trim()
      .toLowerCase(),
    reason = (text(first(call, 'reason', 'termination_reason')) ?? '')
      .trim()
      .toLowerCase();
  if (
    status.includes('active') ||
    status.includes('answered') ||
    event === 'accept' ||
    event === 'answer'
  )
    return 'ACTIVE';
  if (event === 'connect' || status.includes('ring')) return 'RINGING';
  if (status.includes('connect')) return 'CONNECTING';
  if (
    event === 'terminate' ||
    status.includes('end') ||
    status.includes('terminat')
  ) {
    if (reason.includes('reject') || reason.includes('declin'))
      return 'REJECTED';
    if (
      reason.includes('miss') ||
      reason.includes('timeout') ||
      reason.includes('no_answer')
    )
      return 'MISSED';
    if (reason.includes('fail') || reason.includes('error')) return 'FAILED';
    return 'COMPLETED';
  }
  return 'RINGING';
}
async function conversation(
  pool: Pool,
  org: string,
  connection: string,
  phone: string,
  name: string | null,
) {
  const identifier = `wa:${connection}:${phone}`,
    customer = await ensureWhatsappCustomer(pool, org, phone, name, null),
    existing = (
      await pool.query(SQL.find_or_create_conversation![0]!, [org, identifier])
    ).rows[0]?.id;
  if (existing) {
    if (name?.trim())
      await pool.query(SQL.find_or_create_conversation![1]!, [
        name,
        customer,
        existing,
        org,
      ]);
    else
      await pool.query(SQL.find_or_create_conversation![2]!, [
        customer,
        existing,
        org,
      ]);
    return existing as string;
  }
  const id = createId();
  await pool.query(SQL.find_or_create_conversation![3]!, [
    id,
    org,
    identifier,
    name,
    new Date(),
    connection,
    customer,
  ]);
  return id;
}
export async function ingestWebhookCalls(
  pool: Pool,
  config: CoreConfig,
  value: unknown,
  options: CallsOptions = {},
) {
  const payload = object(value),
    calls = Array.isArray(payload.calls) ? payload.calls : [];
  if (!calls.length) return;
  const phoneId = text(object(payload.metadata).phone_number_id);
  if (phoneId === null) {
    options.logger?.warn(
      {
        event: 'provider.call.failed',
        provider: 'whatsapp',
        operation: 'call.webhook.receive',
        reason: 'missing_phone_number_id',
      },
      'WhatsApp call webhook missing phone number ID',
    );
    return;
  }
  const connection = (
    await pool.query(SQL.ingest_webhook_calls![0]!, [phoneId])
  ).rows[0];
  if (!connection) {
    options.logger?.warn(
      {
        event: 'provider.call.failed',
        provider: 'whatsapp',
        operation: 'call.webhook.resolve_connection',
        reason: 'connection_not_found',
      },
      'WhatsApp call webhook connection not found',
    );
    return;
  }
  const businessPhone = normalizeCallPhone(
    connection.phoneDisplayNumber ?? connection.phoneNumberId,
  );
  for (const rawCall of calls) {
    const call = object(rawCall),
      waId = text(first(call, 'id', 'call_id'))?.trim();
    if (!waId) bad('Missing WhatsApp call id in webhook payload');
    const direction = mapCallDirection(call, businessPhone),
      from = normalizeCallPhone(text(call.from) ?? ''),
      to = normalizeCallPhone(text(call.to) ?? ''),
      customerPhone = direction === 'OUTBOUND' ? to : from;
    let name = text(object(call.customer).name);
    if (name === null && Array.isArray(payload.contacts))
      for (const contactRaw of payload.contacts) {
        const contact = object(contactRaw);
        if (normalizeCallPhone(text(contact.wa_id) ?? '') === customerPhone) {
          const profile = text(object(contact.profile).name);
          if (profile !== null) {
            name = profile;
            break;
          }
        }
      }
    const status = mapCallStatus(call),
      started =
        parseCallTimestamp(call.timestamp) ??
        parseCallTimestamp(call.started_at) ??
        parseCallTimestamp(call.start_time),
      answered =
        parseCallTimestamp(call.answered_at) ??
        (status === 'ACTIVE' ? (started ?? new Date()) : null),
      ended =
        parseCallTimestamp(call.ended_at) ??
        (['COMPLETED', 'REJECTED', 'MISSED', 'FAILED', 'CANCELLED'].includes(
          status,
        )
          ? new Date()
          : null),
      rawDuration = i64(first(call, 'duration', 'duration_seconds')),
      duration =
        rawDuration !== null
          ? Number(BigInt.asIntN(32, rawDuration < 0n ? 0n : rawDuration))
          : answered && ended
            ? Number(
                BigInt.asIntN(
                  32,
                  BigInt(Math.max(0, Math.trunc((+ended - +answered) / 1000))),
                ),
              )
            : null,
      error = object(call.error),
      errorCode = text(error.code),
      errorMessage = text(first(error, 'message', 'title')),
      eventType =
        typeof call.event === 'string'
          ? `call.webhook.${call.event.trim().toLowerCase()}`
          : 'call.webhook.update',
      rawPayload = {
        source: 'whatsapp-webhook',
        metadata: payload.metadata ?? null,
        call: rawCall,
      };
    const existing = await existingCall(pool, waId),
      conversationId = existing
        ? existing.conversation_id
        : customerPhone
          ? await conversation(
              pool,
              connection.orgId,
              connection.id,
              customerPhone,
              name,
            )
          : null;
    let id: string;
    if (existing) {
      id = existing.id;
      await pool.query(SQL.ingest_webhook_calls![1]!, [
        conversationId,
        direction,
        status,
        from,
        to,
        started,
        answered,
        ended,
        duration,
        errorCode,
        errorMessage,
        json(rawPayload),
        id,
      ]);
    } else {
      id = createId();
      await pool.query(SQL.ingest_webhook_calls![2]!, [
        id,
        connection.userId,
        connection.id,
        conversationId,
        direction,
        status,
        waId,
        from,
        to,
        json(rawPayload),
        started,
        answered,
        ended,
        duration,
        errorCode,
        errorMessage,
      ]);
    }
    await appendCallEvent(pool, id, eventType, status, rawCall);
    const row = await scopedCall(pool, connection.orgId, id);
    await publish(
      pool,
      config,
      connection.orgId,
      {
        type: existing ? 'call.updated' : 'call.created',
        callId: row.id,
        call: callView(row),
      },
      options,
    );
    if (!existing && direction === 'INBOUND' && status === 'RINGING') {
      const label = name?.trim() ? name : customerPhone;
      await push(
        pool,
        config,
        connection.userId,
        {
          title: 'Incoming WhatsApp call',
          body: label ? `${label} is calling you` : 'Open KasiTek to answer',
          url: row.conversation_id
            ? `/inbox?conversation=${row.conversation_id}`
            : '/inbox',
          tag: `call:${row.id}`,
        },
        options,
      );
    }
  }
}
