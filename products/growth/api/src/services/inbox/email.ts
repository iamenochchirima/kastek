import type { Pool } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import { ApiError } from '../../error.js';
import { execute } from '../email/operations.js';
import * as sql from './inbox-sql.js';
import { createReference } from './message-domain.js';
import { enqueueMessageLifecycle } from './analytics.js';
import { obj, str, type SendMessageInput, type InboxOptions } from './types.js';
interface Scope {
  id: string;
  provider: string;
  email_address: string;
  customer_identifier: string;
  outbound_status: string;
}
interface Target {
  id: string;
  content: string;
  provider_message_id: string | null;
  provider_metadata: unknown;
}
export function previewText(value: string, limit: number) {
  const text = value.trim(),
    chars = Array.from(text);
  return chars.length <= limit
    ? text
    : chars.slice(0, Math.max(0, limit - 1)).join('') + '…';
}
async function scope(pool: Pool, org: string, id: string): Promise<Scope> {
  const row = (
    await pool.query<Scope>(sql.SCOPED_EMAIL_CONVERSATION_0, [id, org])
  ).rows[0];
  if (!row)
    throw new ApiError(404, 'not_found', 'Email conversation not found');
  if (row.outbound_status !== 'READY')
    throw new ApiError(
      409,
      'conflict',
      'This mailbox is not ready to send email. Reconnect it or grant send access first.',
    );
  return row;
}
async function deliver(
  pool: Pool,
  org: string,
  row: Scope,
  id: string,
  target: Target | null,
  text: string,
  threadId: string,
  subject: string,
  to: string[],
  retry: boolean,
  options: InboxOptions,
) {
  try {
    const result = await execute(
        pool,
        options.config,
        org,
        target?.provider_message_id !== null &&
          target?.provider_message_id !== undefined
          ? 'reply'
          : 'send',
        {
          provider: row.provider.toLowerCase(),
          account: row.email_address,
          body: text,
          subject,
          threadId,
          messageId: target?.provider_message_id ?? null,
          to,
        },
        options.fetch,
      ),
      providerId = str(result.messageId),
      time = new Date(),
      tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(
        retry
          ? sql.RETRY_EMAIL_CONVERSATION_MESSAGE_1
          : sql.SEND_EMAIL_CONVERSATION_MESSAGE_3,
        retry ? [providerId, id] : [providerId, id, row.id],
      );
      if (!retry)
        await tx.query(sql.SEND_EMAIL_CONVERSATION_MESSAGE_4, [row.id, org]);
      await enqueueMessageLifecycle(
        tx,
        org,
        id,
        row.id,
        'email',
        'delivery_updated',
        'outbound',
        'human',
        'text',
        'sent',
        null,
        time,
      );
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
    return {
      success: true,
      messageId: id,
      providerMessageId: providerId,
      status: 'SENT',
    };
  } catch (error) {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(sql.SEND_EMAIL_CONVERSATION_MESSAGE_5, [
        error instanceof ApiError ? error.code : 'internal_error',
        id,
      ]);
      await enqueueMessageLifecycle(
        tx,
        org,
        id,
        row.id,
        'email',
        'delivery_updated',
        'outbound',
        'human',
        'text',
        'failed',
        null,
        new Date(),
      );
      await tx.query('COMMIT');
    } catch (analyticsError) {
      await tx.query('ROLLBACK');
      throw analyticsError;
    } finally {
      tx.release();
    }
    throw error;
  }
}
export async function sendEmailConversationMessage(
  pool: Pool,
  org: string,
  conversationId: string,
  input: SendMessageInput,
  options: InboxOptions,
) {
  const text = input.text?.trim();
  if (!text) throw new ApiError(400, 'bad_request', 'Reply text is required');
  const row = await scope(pool, org, conversationId),
    targetId = input.replyToMessageId?.trim(),
    target = targetId
      ? ((
          await pool.query<Target>(sql.SEND_EMAIL_CONVERSATION_MESSAGE_0, [
            targetId,
            row.id,
          ])
        ).rows[0] ?? null)
      : ((
          await pool.query<Target>(sql.SEND_EMAIL_CONVERSATION_MESSAGE_1, [
            row.id,
          ])
        ).rows[0] ?? null);
  if (targetId && !target)
    throw new ApiError(404, 'not_found', 'Reply target not found');
  const metadata = obj(target?.provider_metadata),
    threadId =
      str(metadata.threadId) ?? row.customer_identifier.split(':').at(-1) ?? '',
    subject = str(metadata.subject) ?? 'Re:',
    from = str(metadata.from),
    id = createId(),
    time = new Date(),
    tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(sql.SEND_EMAIL_CONVERSATION_MESSAGE_2, [
      id,
      row.id,
      text,
      null,
      {
        provider: row.provider.toLowerCase(),
        threadId,
        subject,
        replyToMessageId: input.replyToMessageId ?? null,
        _kasitek_inbox_responder_type: 'human',
      },
      time,
    ]);
    await enqueueMessageLifecycle(
      tx,
      org,
      id,
      row.id,
      'email',
      'created',
      'outbound',
      'human',
      'text',
      'sending',
      null,
      time,
    );
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
  if (target)
    await createReference(
      pool,
      id,
      target.id,
      target.provider_message_id,
      previewText(target.content, 180),
      'TEXT',
    );
  return deliver(
    pool,
    org,
    row,
    id,
    target,
    text,
    threadId,
    subject,
    from === null ? [] : [from],
    false,
    options,
  );
}
export async function retryEmailConversationMessage(
  pool: Pool,
  org: string,
  conversationId: string,
  id: string,
  options: InboxOptions,
) {
  const row = await scope(pool, org, conversationId),
    message = (
      await pool.query<Target>(sql.RETRY_EMAIL_CONVERSATION_MESSAGE_0, [
        id,
        conversationId,
      ])
    ).rows[0];
  if (!message)
    throw new ApiError(
      409,
      'conflict',
      'Only failed email messages can be retried',
    );
  const reference = (
    await pool.query<{ referencedProviderMessageId: string | null }>(
      'SELECT "referencedProviderMessageId" FROM "MessageReference" WHERE "messageId"=$1 LIMIT 1',
      [id],
    )
  ).rows[0];
  if (
    message.provider_message_id === null &&
    reference?.referencedProviderMessageId
  )
    message.provider_message_id = reference.referencedProviderMessageId;
  const metadata = obj(message.provider_metadata),
    from = str(metadata.from);
  return deliver(
    pool,
    org,
    row,
    id,
    message,
    message.content,
    str(metadata.threadId) ?? '',
    str(metadata.subject) ?? 'Re:',
    from === null ? [] : [from],
    true,
    options,
  );
}
