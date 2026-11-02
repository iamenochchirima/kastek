import type { Pool } from 'pg';
import { apiJson } from '../../json.js';
import { createId } from '@paralleldrive/cuid2';
import { sendPushNotificationToUser } from '../notifications.js';
import * as sql from './inbox-sql.js';
import { transaction, enqueueMetaSourceManifest } from './send.js';
import { enqueueMessageLifecycle } from './analytics.js';
import { previewText } from './email.js';
import {
  resolveMetaChannel,
  resolveMetaCustomerName,
  findOrCreateMetaConversation,
  channelName,
} from './meta-conversations.js';
import {
  metaMessageAttachments,
  metaMessageIsEcho,
  metaReplyToMid,
} from './meta-shapes.js';
import {
  applyMetaDeliveryEvent,
  applyMetaReadEvent,
  applyMetaReactionEvent,
} from './meta-receipts.js';
import { createAttachment, createReference } from './message-domain.js';
import { publishMessageCreated, publishConversationUpdated } from './read.js';
import { obj, arr, str, type MetaChannel, type InboxOptions } from './types.js';
export async function processMetaWebhookPayload(
  pool: Pool,
  raw: unknown,
  options: InboxOptions,
): Promise<void> {
  const payload = obj(raw),
    object = str(payload.object) ?? '';
  for (const entryRaw of arr(payload.entry)) {
    const entry = obj(entryRaw),
      entryId = str(entry.id)?.trim() || null;
    for (const eventRaw of arr(entry.messaging)) {
      const event = obj(eventRaw),
        sender = str(obj(event.sender).id)?.trim() ?? '',
        recipient = str(obj(event.recipient).id)?.trim() ?? '',
        asset = entryId ?? recipient;
      if (!asset) continue;
      const channel = await resolveMetaChannel(pool, object, asset);
      if (!channel) continue;
      if (event.delivery !== undefined) {
        await applyMetaDeliveryEvent(
          pool,
          channel,
          sender,
          event.delivery,
          options,
        );
        continue;
      }
      if (event.read !== undefined) {
        await applyMetaReadEvent(pool, channel, sender, event.read, options);
        continue;
      }
      if (event.reaction !== undefined) {
        await applyMetaReactionEvent(
          pool,
          channel,
          sender,
          event.reaction,
          options,
        );
        continue;
      }
      if (event.message === undefined) continue;
      const message = obj(event.message),
        echo = metaMessageIsEcho(message),
        customer = echo ? recipient : sender;
      if (!customer) continue;
      const content = str(message.text)?.trim() ?? '',
        attachments = metaMessageAttachments(message);
      if (!content && !attachments.length) continue;
      const providerId = str(message.mid),
        name = await resolveMetaCustomerName(pool, channel, customer, options),
        conversation = await findOrCreateMetaConversation(
          pool,
          channel,
          customer,
          name,
        ),
        replyTo = metaReplyToMid(message),
        target = replyTo
          ? (
              await pool.query(sql.PROCESS_META_WEBHOOK_PAYLOAD_0, [
                conversation.id,
                replyTo,
              ])
            ).rows[0]
          : null,
        id = createId(),
        time = new Date(),
        status = echo ? 'SENT' : 'RECEIVED';
      const inserted = await transaction(pool, async (tx) => {
        const row = (
          await tx.query(sql.PROCESS_META_WEBHOOK_PAYLOAD_1, [
            id,
            conversation.id,
            echo ? 'bot' : 'customer',
            content,
            attachments.length ? 'MEDIA' : 'TEXT',
            providerId,
            status,
            apiJson({
              provider: channel.platform.toLowerCase(),
              object,
              isEcho: echo,
              event,
              _kasitek_inbox_responder_type: echo ? 'human' : 'customer',
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
          echo ? 'outbound' : 'inbound',
          echo ? 'human' : 'customer',
          attachments.length ? 'media' : 'text',
          status.toLowerCase(),
          null,
          time,
        );
        await tx.query(sql.PROCESS_META_WEBHOOK_PAYLOAD_2, [
          time,
          echo ? 0 : 1,
          conversation.id,
        ]);
        await enqueueMetaSourceManifest(tx, channel.org_id ?? '', time);
        return true;
      });
      if (!inserted) continue;
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
      if (target)
        await createReference(
          pool,
          id,
          target.id,
          replyTo,
          previewText(target.content, 180),
          'TEXT',
        );
      await publishMessageCreated(pool, channel.user_id, id, options);
      await publishConversationUpdated(
        pool,
        channel.user_id,
        conversation.id,
        options,
      );
      if (echo) continue;
      try {
        await sendPushNotificationToUser(
          { pool, config: options.config },
          channel.user_id,
          {
            title:
              channel.platform === 'INSTAGRAM'
                ? 'New Instagram message'
                : 'New Facebook message',
            body: `${name ?? sender}: ${previewText(content, 120)}`,
            url: '/inbox',
            tag: `conversation:${conversation.id}`,
          },
        );
      } catch {
        /* A failed push does not cause provider retries after persistence. */
      }
    }
  }
}
