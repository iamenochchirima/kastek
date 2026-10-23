import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { registerInboxRoutes } from '../src/routes/inbox.js';
import { ApiError } from '../src/error.js';
import { upsertMetaConnectionsForOrg } from '../src/integrations/social-provider-connections.js';
import { syncOrgConnections } from '../src/services/connections.js';
import { processMetaWebhookPayload } from '../src/services/inbox/meta-webhook.js';
import {
  sendConversationMessage,
  retryConversationMessage,
  markConversationRead,
} from '../src/services/inbox/send.js';
import {
  listInboxConversations,
  listConversationMessages,
  scopedConversation,
} from '../src/services/inbox/read.js';
import {
  verifyMetaWebhookSignature,
  verifyMetaWebhookRequest,
} from '../src/services/inbox/meta-provider.js';
import {
  metaMessageAttachments,
  metaReadMessageIds,
  metaReceiptWatermark,
  metaProfileDisplayName,
  metaMessageResponderType,
} from '../src/services/inbox/meta-shapes.js';
import { downloadMessageAttachment } from '../src/services/inbox/attachments.js';
import { inboxFixture } from './inbox-fixture.js';
import { readConfig } from '../src/config.js';
test('Meta raw signature, exact sticker deduplication, receipt and attribution contracts', () => {
  const config = readConfig({
      DATABASE_URL: 'postgres://unused',
      AUTH_META_APP_SECRET: ' raw secret ',
      META_WEBHOOK_VERIFY_TOKEN: 'test',
    }),
    raw = Buffer.from('{"object":"page","entry":[]}'),
    signature =
      'sha256=' +
      createHmac('sha256', ' raw secret ').update(raw).digest('hex');
  assert.doesNotThrow(() => verifyMetaWebhookSignature(config, signature, raw));
  assert.throws(() =>
    verifyMetaWebhookSignature(config, signature, Buffer.from('{}')),
  );
  assert.equal(
    verifyMetaWebhookRequest(config, {
      'hub.mode': 'subscribe',
      'hub.verify_token': 'test',
      'hub.challenge': '123',
    }),
    '123',
  );
  assert.deepEqual(
    metaReadMessageIds({ mids: [' a ', 'b', 'a'], mid: ' b ' }),
    ['a', 'b'],
  );
  assert.equal(
    metaReceiptWatermark({ watermark: '9223372036854775807' }),
    9223372036854775807n,
  );
  assert.equal(
    metaMessageResponderType({
      sender: 'bot',
      provider_metadata: { _kasitek_inbox_message_kind: 'template' },
    }),
    'system',
  );
  assert.equal(
    metaProfileDisplayName({ first_name: ' Ada ', last_name: ' Lovelace ' }),
    'Ada Lovelace',
  );
  const attachments = metaMessageAttachments({
    attachments: [
      { type: 'image', payload: { url: 'https://cdninstagram.com/sticker' } },
      {
        type: 'sticker',
        payload: {
          url: 'https://cdninstagram.com/sticker',
          sticker_id: 9223372036854775807n,
        },
      },
      { type: 'sticker', payload: { url: 'https://cdninstagram.com/sticker' } },
    ],
  });
  assert.equal(attachments.length, 1);
  assert.equal(
    (attachments[0]!.metadata.sticker as { id: string }).id,
    '9223372036854775807',
  );
});
test(
  'isolated Meta inbox webhook, echo, replies, receipt ordering, reactions, attachments, retry without agent forwarding',
  { skip: !process.env.CORE_INBOX_TEST_DATABASE_URL },
  async () =>
    inboxFixture(async (pool, options) => {
      const channels = await upsertMetaConnectionsForOrg(
        pool,
        options.config,
        'user',
        'org',
        { access_token: 'user-token' },
        [{ id: 'page', name: 'Page', access_token: 'page-token' }],
        ['pages_messaging'],
        true,
        false,
        async () => null,
      );
      await syncOrgConnections(pool, 'org');
      const channel = channels[0]!;
      const events: unknown[] = [];
      options.publishEvent = async (_org, event) => {
        events.push(event);
      };
      let sendNumber = 0,
        failSend = false;
      options.fetch = async (url, init) => {
        const address = String(url);
        if (address.startsWith('https://cdninstagram.com/')) {
          assert.equal(new Headers(init?.headers).has('authorization'), false);
          assert.equal(init?.redirect, 'manual');
          return new Response('image-data', {
            headers: { 'content-type': 'image/png' },
          });
        }
        if (address.endsWith('/messages')) {
          const input = JSON.parse(String(init?.body));
          if (input.sender_action === 'mark_seen') return new Response('{}');
          assert.equal(input.recipient.id, 'customer');
          if (failSend)
            return new Response(
              JSON.stringify({
                error: { message: 'Invalid OAuth access token' },
              }),
              { status: 401 },
            );
          sendNumber++;
          return new Response(
            JSON.stringify({ message_id: `out-${sendNumber}` }),
          );
        }
        return new Response(
          JSON.stringify({ first_name: 'Ada', last_name: 'Lovelace' }),
        );
      };
      const envelope = (event: unknown) => ({
          object: 'page',
          entry: [{ id: 'page', messaging: [event] }],
        }),
        incoming = {
          sender: { id: 'customer' },
          recipient: { id: 'page' },
          timestamp: 9223372036854775807n,
          message: {
            mid: 'in-1',
            text: 'Hello',
            attachments: [
              {
                type: 'image',
                payload: { id: 'media', url: 'https://cdninstagram.com/image' },
              },
            ],
          },
        };
      await processMetaWebhookPayload(pool, envelope(incoming), options);
      await processMetaWebhookPayload(pool, envelope(incoming), options);
      assert.equal(
        (await pool.query('SELECT count(*) FROM "Message"')).rows[0]!.count,
        '1',
      );
      const conversation = (
        await pool.query(
          'SELECT id,"unreadCount","customerId" FROM "Conversation"',
        )
      ).rows[0]!;
      assert.ok(conversation.customerId);
      assert.equal(conversation.unreadCount, 1);
      assert.equal(
        await scopedConversation(pool, 'other', conversation.id),
        null,
      );
      assert.equal(
        (await listInboxConversations(pool, 'org', options)).conversations
          .length,
        1,
      );
      const messages = (
        await listConversationMessages(pool, 'org', conversation.id, options)
      ).messages as Record<string, unknown>[];
      const incomingId = String(messages[0]!.id),
        attachment = (messages[0]!.attachments as { id: string }[])[0]!;
      const downloaded = await downloadMessageAttachment(
        pool,
        'org',
        incomingId,
        attachment.id,
        options,
      );
      assert.equal(downloaded.contentType, 'image/png');
      assert.equal(downloaded.mediaSource, 'webhook_payload');
      await assert.rejects(
        downloadMessageAttachment(
          pool,
          'other',
          incomingId,
          attachment.id,
          options,
        ),
        (error: unknown) => error instanceof ApiError && error.status === 404,
      );
      const sent = await sendConversationMessage(
        pool,
        'user',
        'org',
        conversation.id,
        { text: ' Reply ', replyToMessageId: incomingId },
        options,
      );
      assert.equal(sent.status, 'SENT');
      await processMetaWebhookPayload(
        pool,
        envelope({
          sender: { id: 'customer' },
          recipient: { id: 'page' },
          delivery: { mids: ['out-1'] },
        }),
        options,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT "providerStatus" FROM "Message" WHERE id=$1',
            [sent.messageId],
          )
        ).rows[0]!.providerStatus,
        'DELIVERED',
      );
      await processMetaWebhookPayload(
        pool,
        envelope({
          sender: { id: 'customer' },
          recipient: { id: 'page' },
          read: { mid: 'out-1' },
        }),
        options,
      );
      await processMetaWebhookPayload(
        pool,
        envelope({
          sender: { id: 'customer' },
          recipient: { id: 'page' },
          delivery: { mids: ['out-1'] },
        }),
        options,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT "providerStatus" FROM "Message" WHERE id=$1',
            [sent.messageId],
          )
        ).rows[0]!.providerStatus,
        'READ',
      );
      await processMetaWebhookPayload(
        pool,
        envelope({
          sender: { id: 'customer' },
          recipient: { id: 'page' },
          reaction: { mid: 'out-1', reaction: '❤', timestamp: 1 },
        }),
        options,
      );
      assert.equal(
        (await pool.query('SELECT emoji FROM "MessageReaction"')).rows[0]!
          .emoji,
        '❤',
      );
      assert.equal(
        (
          await markConversationRead(
            pool,
            'user',
            'org',
            conversation.id,
            options,
          )
        ).providerReceiptSent,
        true,
      );
      failSend = true;
      await assert.rejects(
        sendConversationMessage(
          pool,
          'user',
          'org',
          conversation.id,
          { text: 'Fail' },
          options,
        ),
      );
      const failed = (
        await pool.query(
          'SELECT id FROM "Message" WHERE "providerStatus"=\'FAILED\'',
        )
      ).rows[0]!;
      failSend = false;
      assert.equal(
        (
          await retryConversationMessage(
            pool,
            'user',
            'org',
            conversation.id,
            failed.id,
            options,
          )
        ).status,
        'SENT',
      );
      assert.equal(sendNumber, 2);
      const app = await buildApp({ pool, config: options.config }, [
        (app, context) => registerInboxRoutes(app, context, options),
      ]);
      try {
        const raw = '{"object":"page","entry":[]}',
          signature =
            'sha256=' +
            createHmac('sha256', options.config.rawEnv.AUTH_META_APP_SECRET!)
              .update(raw)
              .digest('hex');
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/api/webhooks/meta',
              headers: {
                'content-type': 'application/json',
                'x-hub-signature-256': signature,
              },
              payload: raw,
            })
          ).statusCode,
          200,
        );
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/api/webhooks/meta',
              headers: {
                'content-type': 'application/json',
                'x-hub-signature-256': signature,
              },
              payload: '{}',
            })
          ).statusCode,
          403,
        );
      } finally {
        await app.close();
      }
      assert.ok(
        events.some(
          (event) =>
            (event as { type: string }).type === 'message.reactions_updated',
        ),
      );
      assert.equal(
        JSON.stringify(
          (
            await pool.query(
              "SELECT envelope FROM analytics_outbox WHERE source_domain='inbox'",
            )
          ).rows,
        ).includes('page-token'),
        false,
      );
      assert.ok(channel.id);
    }),
);
