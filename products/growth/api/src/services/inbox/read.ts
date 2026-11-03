import type { Pool } from 'pg';
import { ApiError } from '../../error.js';
import * as sql from './inbox-sql.js';
import {
  channelCapabilities,
  listTimelineMessages,
  recordEvent,
} from './message-domain.js';
import {
  arr,
  obj,
  str,
  type InboxOptions,
  type ConversationRow,
  type MetaScope,
} from './types.js';
export function parseMetaConversationIdentifier(
  id: string,
): [string, string] | null {
  const parts = id.split(':');
  return parts.length >= 3 && parts[0] === 'meta'
    ? [parts[1]!, parts.slice(2).join(':')]
    : null;
}
export const scopedConversation = async (
  pool: Pool,
  orgId: string,
  id: string,
) =>
  (await pool.query<ConversationRow>(sql.SCOPED_CONVERSATION_0, [id, orgId]))
    .rows[0] ?? null;
export const scopedMetaConversation = async (
  pool: Pool,
  orgId: string,
  id: string,
) =>
  (await pool.query<MetaScope>(sql.SCOPED_META_CONVERSATION_0, [id, orgId]))
    .rows[0] ?? null;
export const loadConversationById = async (pool: Pool, id: string) =>
  (await pool.query<ConversationRow>(sql.LOAD_CONVERSATION_BY_ID_0, [id]))
    .rows[0] ?? null;
export async function listInboxConversations(
  pool: Pool,
  orgId: string,
  options: InboxOptions,
) {
  const conversations = arr(
    (await options.whatsapp.listInboxConversations(pool, orgId,options.captureReadSource)).conversations,
  ).map(obj);
  const socialSql=options.captureReadSource?sql.LIST_INBOX_CONVERSATIONS_0.replace("last_message.content AS last_message_content", "last_message.content AS last_message_content, last_message.id AS access_message_id, connection.id AS access_external_connection_id")
    .replace("SELECT m.content", "SELECT m.id, m.content"):sql.LIST_INBOX_CONVERSATIONS_0;
  for (const row of (await pool.query(socialSql, [orgId]))
    .rows)
    {
    options.captureReadSource?.({conversationId:row.id,messageId:row.access_message_id??null,connectionId:row.channel_connection_id??null,connectionKind:"social",externalConnectionId:row.access_external_connection_id??null});
    conversations.push({
      id: row.id,
      channel: row.channel,
      customerName: row.customer_name,
      phone:
        parseMetaConversationIdentifier(row.customer_identifier)?.[1] ??
        row.customer_identifier,
      status: row.status,
      lastMessageAt: row.last_message_at,
      lastReadAt: row.last_read_at,
      unreadCount: row.unread_count,
      starred: false,
      connectionId: row.channel_connection_id,
      connectionLabel: row.channel_label,
      lastMessage: row.last_message_content ?? 'No messages yet',
    });
    }
  const emailSql=options.captureReadSource?sql.LIST_INBOX_CONVERSATIONS_1.replace("last_message.content AS last_message_content,", "last_message.content AS last_message_content, last_message.id AS access_message_id, source.id AS access_external_connection_id,")
    .replace("SELECT m.content,", "SELECT m.id, m.content,"):sql.LIST_INBOX_CONVERSATIONS_1;
  for (const row of (await pool.query(emailSql, [orgId]))
    .rows)
    {
    options.captureReadSource?.({conversationId:row.id,messageId:row.access_message_id??null,connectionId:row.access_external_connection_id??null,connectionKind:"external"});
    conversations.push({
      id: row.id,
      channel: 'email',
      customerName: row.customer_name,
      phone: row.customer_identifier.startsWith('email:')
        ? row.customer_identifier.split(':').at(-1)
        : row.customer_identifier,
      status: row.status,
      lastMessageAt: row.last_message_at,
      lastReadAt: row.last_read_at,
      unreadCount: row.unread_count,
      starred: false,
      connectionId: row.email_connection_id,
      connectionLabel: row.connection_label.replace(/(?: · )+$/, ''),
      lastMessage: row.last_message_content ?? 'No messages yet',
      subject: row.last_message_subject ?? '(no subject)',
      from: row.last_message_from,
    });
    }
  const time = (value: unknown) =>
    value instanceof Date ? value.toISOString() : (str(value) ?? '');
  conversations.sort((a, b) => {
    const left = time(a.lastMessageAt),
      right = time(b.lastMessageAt);
    return right < left ? -1 : right > left ? 1 : 0;
  });
  return { conversations };
}
export async function listInboxConversationsBounded(
  pool: Pool,
  org: string,
  limit: number,
  options: InboxOptions,
) {
  const { conversations } = await listInboxConversations(pool, org, options),
    total = conversations.length;
  return {
    conversations: conversations.slice(0, limit),
    total,
    hasMore: total > limit,
  };
}
export async function listConversationMessages(
  pool: Pool,
  org: string,
  id: string,
  options: InboxOptions,
) {
  const row = await scopedConversation(pool, org, id);
  if (!row) throw new ApiError(404, 'not_found', 'Conversation not found');
  if (row.channel === 'whatsapp')
    return options.whatsapp.listConversationMessages(pool, org, id);
  return {
    messages: await listTimelineMessages(pool, row.id),
    capabilities: channelCapabilities(row.channel),
  };
}
export async function listConversationMessagesBounded(
  pool: Pool,
  org: string,
  id: string,
  limit: number,
  options: InboxOptions,
) {
  const payload = await listConversationMessages(pool, org, id, options),
    messages = arr(payload.messages),
    total = messages.length;
  return {
    ...payload,
    messages: total > limit ? messages.slice(total - limit) : messages,
    total,
    hasMore: total > limit,
  };
}
export async function conversationChannelContext(
  pool: Pool,
  row: ConversationRow,
): Promise<[string | null, string | null, string]> {
  if (row.channel === 'whatsapp') {
    const parts = row.customer_identifier.split(':'),
      id = parts[1] ?? null,
      handle =
        parts.length >= 3 ? parts.slice(2).join(':') : row.customer_identifier,
      label = id
        ? ((await pool.query(sql.CONVERSATION_CHANNEL_CONTEXT_0, [id])).rows[0]
            ?.coalesce ?? null)
        : null;
    return [id, label, handle];
  }
  if (row.channel === 'facebook' || row.channel === 'instagram') {
    const [id, handle] = parseMetaConversationIdentifier(
        row.customer_identifier,
      ) ?? ['', row.customer_identifier],
      label = id
        ? ((await pool.query(sql.CONVERSATION_CHANNEL_CONTEXT_1, [id])).rows[0]
            ?.displayName ?? null)
        : null;
    return [id, label, handle];
  }
  if (row.channel === 'email') {
    const id = row.customer_identifier.startsWith('email:')
        ? (row.customer_identifier.slice(6).split(':')[0] ?? null)
        : null,
      source = id
        ? (await pool.query(sql.CONVERSATION_CHANNEL_CONTEXT_2, [id])).rows[0]
        : null;
    return [
      id,
      source?.displayName ?? null,
      source ? (source.handle ?? '') : row.customer_identifier,
    ];
  }
  return [null, null, row.customer_identifier];
}
export async function publishEventBestEffort(
  pool: Pool,
  options: InboxOptions,
  org: string,
  event: unknown,
) {
  try {
    if (options.publishEvent) await options.publishEvent(org, event);
    else {
      const { publishInboxEvent } = await import('../realtime.js');
      await publishInboxEvent({ pool, config: options.config }, org, event);
    }
  } catch {
    /* Realtime transport failure does not roll back a persisted inbox mutation. */
  }
}
export async function publishConversationUpdated(
  pool: Pool,
  userId: string,
  id: string,
  options: InboxOptions,
) {
  const row = await loadConversationById(pool, id),
    org = (await pool.query(sql.CONVERSATION_ORG_ID_0, [id])).rows[0]?.orgId;
  if (!row || !org) return;
  const [connectionId, connectionLabel, phone] =
    await conversationChannelContext(pool, row);
  await publishEventBestEffort(pool, options, org, {
    type: 'conversation.updated',
    conversationId: id,
    conversation: {
      id: row.id,
      channel: row.channel,
      customerName: row.customer_name,
      phone,
      unreadCount: row.unread_count,
      lastMessageAt: row.last_message_at,
      starred: row.starred,
      connectionId,
      connectionLabel,
    },
  });
}
export async function publishMessageUpdated(
  pool: Pool,
  id: string,
  options: InboxOptions,
) {
  const message = (await pool.query(sql.PUBLISH_MESSAGE_UPDATED_0, [id]))
    .rows[0];
  if (!message) return;
  const org = (
    await pool.query(sql.CONVERSATION_ORG_ID_0, [message.conversation_id])
  ).rows[0]?.orgId;
  if (!org) return;
  if (message.provider_status !== null)
    await recordEvent(
      pool,
      message.conversation_id,
      message.id,
      message.provider_message_id === null
        ? null
        : `meta:status:${message.provider_message_id}:${message.provider_status}`,
      `STATUS_${message.provider_status}`,
      { provider: 'meta', status: message.provider_status },
    );
  await publishEventBestEffort(pool, options, org, {
    type: 'message.updated',
    conversationId: message.conversation_id,
    message: {
      id: message.id,
      providerStatus: message.provider_status,
      providerMessageId: message.provider_message_id,
      errorCode: message.error_code,
      errorMessage: message.error_message,
    },
  });
}
export async function publishMessageCreated(
  pool: Pool,
  userId: string,
  id: string,
  options: InboxOptions,
) {
  const row = (await pool.query(sql.PUBLISH_MESSAGE_CREATED_0, [id])).rows[0];
  if (!row) return;
  const conversation = await loadConversationById(pool, row.conversation_id),
    org = (await pool.query(sql.CONVERSATION_ORG_ID_0, [row.conversation_id]))
      .rows[0]?.orgId;
  if (!conversation || !org) return;
  const message = (await listTimelineMessages(pool, row.conversation_id)).find(
      (v) => v.id === id,
    ),
    [connectionId, connectionLabel, phone] = await conversationChannelContext(
      pool,
      conversation,
    );
  if (!message) return;
  await publishEventBestEffort(pool, options, org, {
    type: 'message.created',
    conversationId: conversation.id,
    conversation: {
      channel: conversation.channel,
      customerName: conversation.customer_name,
      phone,
      connectionId,
      connectionLabel,
      unreadCount: conversation.unread_count,
      lastMessageAt: conversation.last_message_at,
    },
    message,
  });
}
