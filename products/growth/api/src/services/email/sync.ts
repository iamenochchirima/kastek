import type { Pool } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import type { CoreConfig } from '../../config.js';
import { ApiError } from '../../error.js';
import {
  providerRequest,
  resolveEmailCredentialById,
  type EmailCredentialRow,
  type HttpFetch,
} from '../../integrations/email.js';
import { syncOrgConnections } from '../connections.js';
import { enqueueMessageLifecycle } from '../inbox/analytics.js';
import * as sql from './email-sql.js';
const encodeUrl = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
export interface NormalizedEmailMessage {
  providerMessageId: string;
  threadId: string;
  subject: string;
  fromAddress: string;
  fromName: string | null;
  body: string;
  occurredAt: Date;
  isRead: boolean;
  isOutbound: boolean;
}
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export function parseMailbox(raw: string): [string | null, string] {
  const value = raw.trim(),
    start = value.lastIndexOf('<');
  if (start >= 0) {
    const end = value.indexOf('>', start + 1),
      address = end < 0 ? '' : value.slice(start + 1, end).trim(),
      name = value
        .slice(0, start)
        .trim()
        .replace(/^"+|"+$/g, '')
        .trim();
    return [name || null, address];
  }
  return [null, value.replace(/^"+|"+$/g, '')];
}
export function decodeGmailBody(payload: unknown): string | null {
  const value = obj(payload),
    data = str(obj(value.body).data);
  if (data !== null && /^[A-Za-z0-9_-]*$/.test(data) && data.length % 4 !== 1) {
    const bytes = Buffer.from(data, 'base64url');
    if (bytes.toString('base64url') === data) {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return null;
      }
    }
  }
  for (const part of arr(value.parts)) {
    if (obj(part).mimeType === 'text/plain') {
      const body = decodeGmailBody(part);
      if (body !== null) return body;
    }
    const body = decodeGmailBody(part);
    if (body !== null) return body;
  }
  return null;
}
export function normalizeGoogleMessage(
  raw: unknown,
  ownAddress: string,
  now = new Date(),
): NormalizedEmailMessage | null {
  const value = obj(raw),
    id = str(value.id);
  if (id === null) return null;
  const payload = obj(value.payload),
    headers = arr(payload.headers).map(obj),
    header = (name: string) =>
      str(
        headers.find((v) => str(v.name)?.toLowerCase() === name.toLowerCase())
          ?.value,
      ),
    [fromName, fromAddress] = parseMailbox(header('From') ?? '');
  if (!fromAddress) return null;
  const rawTime = str(value.internalDate);
  let time = now;
  if (rawTime !== null && /^[+-]?\d+$/.test(rawTime)) {
    const n = BigInt(rawTime);
    if (n >= -(1n << 63n) && n < 1n << 63n) {
      const d = new Date(Number(n));
      if (!Number.isNaN(d.getTime())) time = d;
    }
  }
  return {
    providerMessageId: id,
    threadId: str(value.threadId) ?? id,
    subject: header('Subject') ?? '',
    fromAddress,
    fromName,
    body: decodeGmailBody(payload) ?? str(value.snippet) ?? '',
    occurredAt: time,
    isRead: Array.isArray(value.labelIds)
      ? !value.labelIds.includes('UNREAD')
      : false,
    isOutbound: fromAddress.toLowerCase() === ownAddress.toLowerCase(),
  };
}
export function normalizeMicrosoftMessage(
  raw: unknown,
  ownAddress: string,
  now = new Date(),
): NormalizedEmailMessage | null {
  const value = obj(raw),
    id = str(value.id),
    from = obj(obj(value.from).emailAddress),
    address = str(from.address);
  if (id === null || address === null) return null;
  const date = str(value.receivedDateTime),
    parsed =
      date && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(date)
        ? new Date(date)
        : now;
  return {
    providerMessageId: id,
    threadId: str(value.conversationId) ?? id,
    subject: str(value.subject) ?? '',
    fromAddress: address,
    fromName: str(from.name),
    body: str(obj(value.body).content) ?? str(value.bodyPreview) ?? '',
    occurredAt: Number.isNaN(parsed.getTime()) ? now : parsed,
    isRead: typeof value.isRead === 'boolean' ? value.isRead : false,
    isOutbound: address.toLowerCase() === ownAddress.toLowerCase(),
  };
}
export function microsoftSyncWatermark(time: Date): string {
  const fraction = time.toISOString().match(/\.(\d+)Z$/)?.[1],
    seconds = new Date(Math.floor(time.getTime() / 1000) * 1000 - 120000)
      .toISOString()
      .replace(/\.000Z$/, '');
  return `${seconds}${fraction && !/^0+$/.test(fraction) ? '.' + fraction : ''}+00:00`;
}
export async function fetchMessagesForSync(
  pool: Pool,
  config: CoreConfig,
  credential: EmailCredentialRow,
  lastSyncedAt: Date | null,
  http: HttpFetch = fetch,
): Promise<NormalizedEmailMessage[]> {
  const request = async (path: string) =>
      obj(
        await providerRequest(
          pool,
          config,
          credential,
          'GET',
          path,
          undefined,
          http,
        ),
      ),
    messages: NormalizedEmailMessage[] = [];
  if (credential.provider === 'GOOGLE') {
    const query = lastSyncedAt
        ? `in:anywhere after:${Math.floor(lastSyncedAt.getTime() / 1000) - 120}`
        : 'in:anywhere newer_than:30d',
      list = await request(
        `/users/me/messages?maxResults=50&q=${encodeUrl(query)}`,
      );
    for (const item of arr(list.messages)) {
      const id = str(obj(item).id);
      if (id === null) continue;
      const detail = await request(
          `/users/me/messages/${encodeUrl(id)}?format=full`,
        ),
        message = normalizeGoogleMessage(detail, credential.email_address);
      if (message) messages.push(message);
    }
  } else {
    const filter = lastSyncedAt
        ? `&$filter=receivedDateTime%20ge%20${encodeUrl(
            microsoftSyncWatermark(lastSyncedAt),
          )}`
        : '',
      list = await request(
        `/me/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime%20desc&$select=id,conversationId,subject,from,toRecipients,receivedDateTime,body,bodyPreview,isRead${filter}`,
      );
    for (const item of arr(list.value)) {
      const message = normalizeMicrosoftMessage(item, credential.email_address);
      if (message) messages.push(message);
    }
  }
  return messages;
}
export async function persistInboxMessage(
  pool: Pool,
  orgId: string,
  connectionId: string,
  credential: EmailCredentialRow,
  message: NormalizedEmailMessage,
): Promise<boolean> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const conversationId = (
      await tx.query<{ id: string }>(sql.PERSIST_INBOX_MESSAGE_0, [
        createId(),
        `email:${connectionId}:${message.threadId}`,
        message.fromName?.trim() ? message.fromName : message.fromAddress,
        message.occurredAt,
        orgId,
        `ext_${connectionId}`,
      ])
    ).rows[0]!.id;
    const inserted = (
      await tx.query<{ id: string }>(sql.PERSIST_INBOX_MESSAGE_1, [
        createId(),
        conversationId,
        message.isOutbound ? 'bot' : 'customer',
        message.body,
        message.providerMessageId,
        message.isOutbound ? 'SENT' : 'RECEIVED',
        {
          provider: credential.provider.toLowerCase(),
          threadId: message.threadId,
          subject: message.subject,
          from: message.fromAddress,
          fromName: message.fromName,
          inboxRead: message.isRead,
        },
        message.occurredAt,
      ])
    ).rows[0];
    if (!inserted) {
      await tx.query('ROLLBACK');
      return false;
    }
    await tx.query(sql.PERSIST_INBOX_MESSAGE_2, [
      message.occurredAt,
      !message.isOutbound && !message.isRead ? 1 : 0,
      conversationId,
    ]);
    await enqueueMessageLifecycle(
      tx,
      orgId,
      inserted.id,
      conversationId,
      'email',
      'created',
      message.isOutbound ? 'outbound' : 'inbound',
      message.isOutbound ? 'human' : 'customer',
      'text',
      message.isOutbound ? 'sent' : 'received',
      null,
      message.occurredAt,
    );
    await tx.query('COMMIT');
    return true;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}
async function setSyncState(
  pool: Pool,
  org: string,
  id: string,
  status: string,
  inbound: string,
  error: string | null,
) {
  await pool.query(sql.SET_SYNC_STATE_0, [inbound, error, org, id]);
  await pool.query(sql.SET_SYNC_STATE_1, [status, error, org, id]);
}
export async function syncConnection(
  pool: Pool,
  config: CoreConfig,
  orgId: string,
  connectionId: string,
  http: HttpFetch = fetch,
): Promise<number> {
  const credential = await resolveEmailCredentialById(
      pool,
      orgId,
      connectionId,
    ),
    binding = (
      await pool.query<{ status: string; timezone: Date | null }>(
        sql.SYNC_CONNECTION_0,
        [orgId, connectionId],
      )
    ).rows[0];
  if (!binding)
    throw new ApiError(404, 'not_found', 'Email Inbox binding not found');
  if (binding.status !== 'ACTIVE') return 0;
  if (
    !(await pool.query(sql.SYNC_CONNECTION_1, [orgId, connectionId])).rows
      .length
  )
    return 0;
  await setSyncState(pool, orgId, connectionId, 'SYNCING', 'SYNCING', null);
  let messages: NormalizedEmailMessage[];
  try {
    messages = await fetchMessagesForSync(
      pool,
      config,
      credential,
      binding.timezone,
      http,
    );
  } catch (error) {
    await setSyncState(
      pool,
      orgId,
      connectionId,
      'RETRYABLE_FAILURE',
      'RETRYABLE_FAILURE',
      error instanceof ApiError ? error.code : 'internal_error',
    );
    await syncOrgConnections(pool, orgId);
    throw error;
  }
  let inserted = 0;
  for (const message of messages)
    if (
      await persistInboxMessage(pool, orgId, connectionId, credential, message)
    )
      inserted++;
  await setSyncState(pool, orgId, connectionId, 'READY', 'READY', null);
  await syncOrgConnections(pool, orgId);
  return inserted;
}
export async function syncAllConnections(
  pool: Pool,
  config: CoreConfig,
  batchSize: number,
  http: HttpFetch = fetch,
): Promise<number> {
  const rows = (
    await pool.query<{ orgId: string; emailConnectionId: string }>(
      sql.SYNC_ALL_CONNECTIONS_0,
      [Math.min(100, Math.max(1, batchSize))],
    )
  ).rows;
  let processed = 0;
  for (const row of rows) {
    try {
      processed += await syncConnection(
        pool,
        config,
        row.orgId,
        row.emailConnectionId,
        http,
      );
    } catch {
      /* Source worker continues polling other mailboxes after a failed connection. */
    }
  }
  return processed;
}
