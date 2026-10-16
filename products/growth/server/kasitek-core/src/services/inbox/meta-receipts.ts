import type { Pool } from 'pg';
import { apiJson } from '../../json.js';
import { createId } from '@paralleldrive/cuid2';
import { ApiError } from '../../error.js';
import { decryptSocialSecret } from '../../integrations/crypto.js';
import * as sql from './inbox-sql.js';
import { transaction, enqueueMetaSourceManifest } from './send.js';
import { META_GRAPH_BASE, fetchMetaJson } from './meta-provider.js';
import { enqueueMessageLifecycle } from './analytics.js';
import {
  channelName,
  findOrCreateMetaConversation,
  resolveMetaCustomerName,
  enqueueMetaMessageLifecycle,
} from './meta-conversations.js';
import {
  metaDeliveryMessageIds,
  metaReadMessageIds,
  metaReceiptWatermark,
  metaGraphMessageAttachments,
  metaGraphMessageRecipientName,
} from './meta-shapes.js';
import {
  createAttachment,
  upsertReaction,
  recordEvent,
  listActiveReactions,
} from './message-domain.js';
import {
  publishMessageUpdated,
  publishMessageCreated,
  publishConversationUpdated,
  publishEventBestEffort,
} from './read.js';
import { obj, str, type MetaChannel, type InboxOptions } from './types.js';
export async function syncMissingMetaOutboundMessage(
  pool: Pool,
  channel: MetaChannel,
  customer: string,
  providerId: string,
  options: InboxOptions,
) {
  if (channel.access_token === null)
    throw new ApiError(
      400,
      'bad_request',
      'Connected Meta Page is missing an access token',
    );
  const token = decryptSocialSecret(options.config, channel.access_token),
    message = await fetchMetaJson(
      `${META_GRAPH_BASE}/${providerId}?fields=id%2Cmessage%2Cfrom%2Cto%2Ccreated_time%2Cattachments`,
      { headers: { Authorization: `Bearer ${token}` } },
      'Failed to load outbound Meta message',
      options,
    ),
    sender = str(obj(message.from).id);
  if (
    channel.external_account_id !== null &&
    sender !== null &&
    channel.external_account_id !== sender
  )
    return;
  const content = str(message.message)?.trim() ?? '',
    attachments = metaGraphMessageAttachments(message);
  if (!content && !attachments.length) return;
  const name =
      metaGraphMessageRecipientName(message, customer) ??
      (await resolveMetaCustomerName(pool, channel, customer, options)),
    conversation = await findOrCreateMetaConversation(
      pool,
      channel,
      customer,
      name,
    ),
    parsed = new Date(str(message.created_time) ?? ''),
    time = Number.isNaN(parsed.getTime()) ? new Date() : parsed,
    id = createId();
  const inserted = await transaction(pool, async (tx) => {
    const row = (
      await tx.query(sql.SYNC_MISSING_META_OUTBOUND_MESSAGE_0, [
        id,
        conversation.id,
        content,
        attachments.length ? 'MEDIA' : 'TEXT',
        providerId,
        apiJson({
          provider: channel.platform.toLowerCase(),
          source: 'delivery_backfill',
          _kasitek_inbox_responder_type: 'human',
          graphMessage: message,
        }),
        time,
      ])
    ).rows[0];
    if (!row) return false;
    await enqueueMessageLifecycle(
      tx,
      channel.org_id ?? '',
      id,
      conversation.id,
      channelName(channel),
      'created',
      'outbound',
      'human',
      attachments.length ? 'media' : 'text',
      'delivered',
      null,
      time,
    );
    await tx.query(sql.SYNC_MISSING_META_OUTBOUND_MESSAGE_1, [
      conversation.id,
      time,
    ]);
    await enqueueMetaSourceManifest(tx, channel.org_id ?? '', time);
    return true;
  });
  if (!inserted) return;
  for (const a of attachments)
    await createAttachment(
      pool,
      id,
      a.providerMediaId,
      a.kind,
      a.mimeType,
      a.fileName,
      null,
      a.metadata,
    );
  await publishMessageCreated(pool, channel.user_id, id, options);
  await publishConversationUpdated(
    pool,
    channel.user_id,
    conversation.id,
    options,
  );
}
async function applyReceipt(
  pool: Pool,
  channel: MetaChannel,
  customer: string,
  raw: unknown,
  read: boolean,
  options: InboxOptions,
) {
  if (channel.org_id === null) return;
  const ids = read ? metaReadMessageIds(raw) : metaDeliveryMessageIds(raw),
    watermark = metaReceiptWatermark(raw);
  if (!ids.length && watermark === null) return;
  const updated = await transaction(pool, async (tx) => {
    const changed = new Set<string>();
    if (ids.length)
      for (const row of (
        await tx.query(
          read ? sql.APPLY_META_READ_EVENT_0 : sql.APPLY_META_DELIVERY_EVENT_0,
          [channel.org_id, channel.external_connection_id, ids],
        )
      ).rows)
        changed.add(row.id);
    if (watermark !== null && customer)
      for (const row of (
        await tx.query(
          read ? sql.APPLY_META_READ_EVENT_1 : sql.APPLY_META_DELIVERY_EVENT_1,
          [
            channel.org_id,
            channel.external_connection_id,
            channelName(channel),
            `meta:${channel.id}:${customer}`,
            watermark.toString(),
          ],
        )
      ).rows)
        changed.add(row.id);
    await enqueueMetaMessageLifecycle(
      tx,
      changed,
      'delivery_updated',
      read ? 'read' : 'delivered',
      new Date(),
    );
    return changed;
  });
  for (const id of updated) await publishMessageUpdated(pool, id, options);
  if (read) return;
  const known = new Set(
    (
      await pool.query(sql.APPLY_META_DELIVERY_EVENT_2, [
        channel.org_id,
        channel.external_connection_id,
        ids,
      ])
    ).rows.map((v) => v.providerMessageId),
  );
  if (channel.platform === 'FACEBOOK' && customer)
    for (const id of ids.filter((v) => !known.has(v)))
      try {
        await syncMissingMetaOutboundMessage(
          pool,
          channel,
          customer,
          id,
          options,
        );
      } catch {
        /* An unavailable backfill does not reject a durable delivery receipt. */
      }
}
export const applyMetaDeliveryEvent = (
  pool: Pool,
  channel: MetaChannel,
  customer: string,
  raw: unknown,
  options: InboxOptions,
) => applyReceipt(pool, channel, customer, raw, false, options);
export const applyMetaReadEvent = (
  pool: Pool,
  channel: MetaChannel,
  customer: string,
  raw: unknown,
  options: InboxOptions,
) => applyReceipt(pool, channel, customer, raw, true, options);
export async function applyMetaReactionEvent(
  pool: Pool,
  channel: MetaChannel,
  actor: string,
  raw: unknown,
  options: InboxOptions,
) {
  if (channel.org_id === null) return;
  const value = obj(raw),
    providerId = str(
      value.mid === undefined ? value.message_id : value.mid,
    )?.trim();
  if (!providerId)
    throw new ApiError(
      400,
      'bad_request',
      'Meta reaction is missing a message ID',
    );
  actor = actor.trim();
  if (!actor) return;
  const action = (str(value.action) ?? 'react').trim().toLowerCase(),
    active = action !== 'unreact' && action !== 'remove',
    emoji =
      str(
        value.reaction === undefined ? value.emoji : value.reaction,
      )?.trim() || null,
    target = (
      await pool.query(sql.APPLY_META_REACTION_EVENT_0, [
        channel.org_id,
        channel.external_connection_id,
        channelName(channel),
        providerId,
      ])
    ).rows[0];
  if (!target) return;
  const timestamp = value.timestamp,
    eventId =
      str(value.id === undefined ? value.event_id : value.id) ??
      `meta:reaction:${providerId}:${actor}:${action}:${typeof timestamp === 'bigint' || (typeof timestamp === 'number' && Number.isInteger(timestamp)) ? timestamp : 0}`;
  await upsertReaction(
    pool,
    target.id,
    actor,
    active ? emoji : null,
    active,
    eventId,
    { provider: 'meta', payload: raw },
  );
  await recordEvent(
    pool,
    target.conversationId,
    target.id,
    eventId,
    active ? 'REACTION_ADDED' : 'REACTION_REMOVED',
    { provider: 'meta', actor, emoji, action },
  );
  await publishEventBestEffort(pool, options, channel.org_id, {
    type: 'message.reactions_updated',
    conversationId: target.conversationId,
    message: {
      id: target.id,
      reactions: await listActiveReactions(pool, target.id),
    },
  });
}
