import type { Pool, PoolClient } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import { ApiError } from '../../error.js';
import * as sql from './inbox-sql.js';
import {
  scopedConversation,
  scopedMetaConversation,
  publishMessageCreated,
  publishMessageUpdated,
  publishConversationUpdated,
} from './read.js';
import {
  sendEmailConversationMessage,
  retryEmailConversationMessage,
  previewText,
} from './email.js';
import { createReference } from './message-domain.js';
import {
  enqueueMessageLifecycle,
  enqueueMetaManifest,
  precedingCustomerResponseTimeMs,
} from './analytics.js';
import {
  sendMetaTextMessage,
  sendMetaMarkSeen,
  isMetaAuthenticationFailure,
  rustErrorDisplay,
} from './meta-provider.js';
import type { InboxOptions, MetaScope, SendMessageInput } from './types.js';
export async function transaction<T>(
  pool: Pool,
  action: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const value = await action(tx);
    await tx.query('COMMIT');
    return value;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}
export async function enqueueMetaSourceManifest(
  tx: PoolClient,
  org: string,
  time: Date,
) {
  if (!org.trim()) return;
  const count = Number(
    (await tx.query(sql.ENQUEUE_META_SOURCE_MANIFEST_0, [org])).rows[0]
      ?.count ?? 0,
  );
  await enqueueMetaManifest(tx, org, count, time);
}
export async function deliverMetaTextMessage(
  pool: Pool,
  user: string,
  org: string,
  scope: MetaScope,
  id: string,
  text: string,
  replyTo: string | null,
  options: InboxOptions,
) {
  try {
    const providerId = await sendMetaTextMessage(scope, text, replyTo, options),
      time = new Date();
    await transaction(pool, async (tx) => {
      await tx.query(sql.TRY_DELIVER_META_TEXT_MESSAGE_0, [
        providerId,
        id,
        scope.id,
      ]);
      await enqueueMessageLifecycle(
        tx,
        org,
        id,
        scope.id,
        scope.channel,
        'delivery_updated',
        'outbound',
        'human',
        'text',
        'sent',
        null,
        time,
      );
      await enqueueMetaSourceManifest(tx, org, time);
    });
    void Promise.resolve()
      .then(async () => {
        await publishMessageCreated(pool, user, id, options);
        await publishConversationUpdated(pool, user, scope.id, options);
      })
      .catch(() => {});
    return {
      success: true,
      messageId: id,
      providerMessageId: providerId,
      status: 'SENT',
    };
  } catch (error) {
    const time = new Date();
    await transaction(pool, async (tx) => {
      await tx.query(sql.DELIVER_META_TEXT_MESSAGE_0, [
        rustErrorDisplay(error),
        id,
      ]);
      await enqueueMessageLifecycle(
        tx,
        org,
        id,
        scope.id,
        scope.channel,
        'delivery_updated',
        'outbound',
        'human',
        'text',
        'failed',
        null,
        time,
      );
      await enqueueMetaSourceManifest(tx, org, time);
    });
    await publishMessageUpdated(pool, id, options);
    throw error;
  }
}
export async function sendConversationMessage(
  pool: Pool,
  user: string,
  org: string,
  id: string,
  input: SendMessageInput,
  options: InboxOptions,
) {
  const conversation = await scopedConversation(pool, org, id);
  if (!conversation)
    throw new ApiError(404, 'not_found', 'Conversation not found');
  if (conversation.channel === 'whatsapp')
    return options.whatsapp.sendConversationMessage(pool, user, org, id, input);
  if (conversation.channel === 'email')
    return sendEmailConversationMessage(pool, org, id, input, options);
  const text = input.text?.trim();
  if (!text) throw new ApiError(400, 'bad_request', 'Reply text is required');
  const scope = await scopedMetaConversation(pool, org, id);
  if (!scope) throw new ApiError(404, 'not_found', 'Conversation not found');
  const replyId = input.replyToMessageId?.trim(),
    target = replyId
      ? (await pool.query(sql.SEND_CONVERSATION_MESSAGE_0, [replyId, scope.id]))
          .rows[0]
      : null;
  if (replyId && !target)
    throw new ApiError(404, 'not_found', 'Reply target not found');
  const providerId = target?.provider_message_id ?? null;
  if (target && providerId === null)
    throw new ApiError(
      400,
      'bad_request',
      'This message cannot be replied to yet. Try again in a few seconds.',
    );
  const messageId = createId(),
    time = new Date();
  await transaction(pool, async (tx) => {
    await tx.query(sql.SEND_CONVERSATION_MESSAGE_1, [
      messageId,
      scope.id,
      text,
      {
        provider: scope.channel,
        channelConnectionId: scope.channel_connection_id,
        replyToMessageId: input.replyToMessageId ?? null,
        _kasitek_inbox_responder_type: 'human',
      },
      time,
    ]);
    const responseTime = await precedingCustomerResponseTimeMs(
      tx,
      scope.id,
      time,
    );
    await enqueueMessageLifecycle(
      tx,
      org,
      messageId,
      scope.id,
      scope.channel,
      'created',
      'outbound',
      'human',
      'text',
      'processing',
      responseTime,
      time,
    );
    await enqueueMetaSourceManifest(tx, org, time);
  });
  if (target)
    await createReference(
      pool,
      messageId,
      target.id,
      providerId,
      previewText(target.content, 180),
      'TEXT',
    );
  return deliverMetaTextMessage(
    pool,
    user,
    org,
    scope,
    messageId,
    text,
    providerId,
    options,
  );
}
export async function retryConversationMessage(
  pool: Pool,
  user: string,
  org: string,
  id: string,
  messageId: string,
  options: InboxOptions,
) {
  const conversation = await scopedConversation(pool, org, id);
  if (!conversation)
    throw new ApiError(404, 'not_found', 'Conversation not found');
  if (conversation.channel === 'whatsapp')
    throw new ApiError(
      400,
      'bad_request',
      'Retry is currently available for Instagram and Messenger messages',
    );
  if (conversation.channel === 'email')
    return retryEmailConversationMessage(pool, org, id, messageId, options);
  const scope = await scopedMetaConversation(pool, org, id);
  if (!scope) throw new ApiError(404, 'not_found', 'Conversation not found');
  const message = await transaction(pool, async (tx) => {
    const row = (
      await tx.query(sql.RETRY_CONVERSATION_MESSAGE_0, [messageId, scope.id])
    ).rows[0];
    if (!row)
      throw new ApiError(
        409,
        'conflict',
        'Only failed outgoing text messages can be retried',
      );
    const time = new Date();
    await enqueueMessageLifecycle(
      tx,
      org,
      row.id,
      scope.id,
      scope.channel,
      'retried',
      'outbound',
      'human',
      'text',
      'processing',
      null,
      time,
    );
    await enqueueMetaSourceManifest(tx, org, time);
    return row;
  });
  const replyTo =
    (await pool.query(sql.RETRY_CONVERSATION_MESSAGE_1, [message.id])).rows[0]
      ?.referencedProviderMessageId ?? null;
  await publishMessageUpdated(pool, message.id, options);
  return deliverMetaTextMessage(
    pool,
    user,
    org,
    scope,
    message.id,
    message.content,
    replyTo,
    options,
  );
}
export async function markConversationRead(
  pool: Pool,
  user: string,
  org: string,
  id: string,
  options: InboxOptions,
) {
  const conversation = await scopedConversation(pool, org, id);
  if (!conversation)
    throw new ApiError(404, 'not_found', 'Conversation not found');
  if (conversation.channel === 'whatsapp')
    return options.whatsapp.markConversationRead(pool, user, org, id);
  let sent = false;
  if (
    conversation.channel === 'facebook' ||
    conversation.channel === 'instagram'
  ) {
    const scope = await scopedMetaConversation(pool, org, id);
    if (scope)
      try {
        await sendMetaMarkSeen(scope, options);
        sent = true;
      } catch {
        /* Local read state remains authoritative when the provider rejects its receipt. */
      }
  }
  await pool.query(sql.MARK_CONVERSATION_READ_0, [conversation.id]);
  await publishConversationUpdated(pool, user, conversation.id, options);
  return {
    success: true,
    conversationId: conversation.id,
    providerReceiptSent: sent,
  };
}
export function validateAgentDeliveryIdempotencyKey(value: string) {
  const key = value.trim();
  if (!key || Buffer.byteLength(key) > 240)
    throw new ApiError(
      400,
      'bad_request',
      'A valid agent delivery idempotency key is required',
    );
  return key;
}
export async function deliverAgentMetaMessage(
  pool: Pool,
  org: string,
  id: string,
  text: string,
  key: string,
  options: InboxOptions,
) {
  key = validateAgentDeliveryIdempotencyKey(key);
  const scope = await scopedMetaConversation(pool, org, id);
  if (!scope)
    throw new ApiError(404, 'not_found', 'Meta conversation not found');
  if (!['facebook', 'instagram'].includes(scope.channel))
    throw new ApiError(
      400,
      'bad_request',
      'Agent delivery is not supported for this Meta conversation',
    );
  const prior = (
    await pool.query(sql.DELIVER_AGENT_META_MESSAGE_0, [scope.id, key])
  ).rows[0];
  if (prior)
    return prior.providerMessageId !== null
      ? {
          providerMessageId: prior.providerMessageId,
          status: 'sent',
          idempotentReplay: true,
        }
      : {
          status: 'unknown',
          idempotentReplay: true,
          providerStatus: prior.providerStatus,
        };
  const messageId = createId(),
    time = new Date();
  await transaction(pool, async (tx) => {
    await tx.query(sql.DELIVER_AGENT_META_MESSAGE_1, [
      messageId,
      scope.id,
      text,
      { _kasitek_agent_idempotency_key: key, _kasitek_responder_type: 'agent' },
      time,
    ]);
    await tx.query(sql.DELIVER_AGENT_META_MESSAGE_2, [scope.id, org]);
    await enqueueMessageLifecycle(
      tx,
      org,
      messageId,
      scope.id,
      scope.channel,
      'created',
      'outbound',
      'agent',
      'text',
      'sending',
      await precedingCustomerResponseTimeMs(tx, scope.id, time),
      time,
    );
    await enqueueMetaSourceManifest(tx, org, time);
  });
  let providerId: string | null = null;
  let failure: unknown;
  try {
    providerId = await sendMetaTextMessage(scope, text, null, options);
  } catch (error) {
    failure = error;
  }
  await transaction(pool, async (tx) => {
    if (failure) {
      const message = rustErrorDisplay(failure);
      await tx.query(sql.DELIVER_AGENT_META_MESSAGE_4, [
        isMetaAuthenticationFailure(message)
          ? 'AGENT_DELIVERY_AUTH_FAILED'
          : 'AGENT_DELIVERY_FAILED',
        message,
        messageId,
        scope.id,
      ]);
    } else
      await tx.query(sql.DELIVER_AGENT_META_MESSAGE_3, [
        providerId,
        messageId,
        scope.id,
      ]);
    await enqueueMessageLifecycle(
      tx,
      org,
      messageId,
      scope.id,
      scope.channel,
      'delivery_updated',
      'outbound',
      'agent',
      'text',
      failure ? 'failed' : 'sent',
      null,
      new Date(),
    );
    await enqueueMetaSourceManifest(tx, org, new Date());
  });
  await publishMessageUpdated(pool, messageId, options);
  await publishConversationUpdated(pool, 'agent-platform', scope.id, options);
  if (failure) throw failure;
  return { providerMessageId: providerId, status: 'sent' };
}
