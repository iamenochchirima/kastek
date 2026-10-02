import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGoogleMessage,
  normalizeMicrosoftMessage,
  decodeGmailBody,
  parseMailbox,
  syncConnection,
  microsoftSyncWatermark,
} from '../src-ts/services/email/sync.js';
import * as credentials from '../src-ts/integrations/email.js';
import { execute } from '../src-ts/services/email/operations.js';
import {
  sendEmailConversationMessage,
  retryEmailConversationMessage,
} from '../src-ts/services/inbox/email.js';
import { listTimelineMessages } from '../src-ts/services/inbox/message-domain.js';
import { UtcTimestamp } from '../src-ts/db.js';
import { ApiError } from '../src-ts/error.js';
import { inboxFixture } from './inbox-fixture.js';
test('email normalization preserves provider body/direction/labels and malformed mailbox behavior', () => {
  const google = normalizeGoogleMessage(
    {
      id: 'g-1',
      threadId: 't-1',
      internalDate: '1735689600000',
      labelIds: ['INBOX', 'UNREAD'],
      payload: {
        headers: [
          { name: 'from', value: 'Ada <ada@example.test>' },
          { name: 'Subject', value: 'Hello' },
        ],
        body: { data: Buffer.from('Hello').toString('base64url') },
      },
    },
    'me@example.test',
  )!;
  assert.equal(google.body, 'Hello');
  assert.equal(google.fromName, 'Ada');
  assert.equal(google.isRead, false);
  assert.equal(google.occurredAt.toISOString(), '2025-01-01T00:00:00.000Z');
  assert.equal(
    normalizeMicrosoftMessage(
      {
        id: 'm',
        from: { emailAddress: { address: 'ME@example.test' } },
        body: { content: 'html' },
        isRead: true,
      },
      'me@example.test',
    )!.isOutbound,
    true,
  );
  assert.deepEqual(parseMailbox('Ada <bad'), ['Ada', '']);
  assert.equal(
    decodeGmailBody({
      body: { data: '_w' },
      parts: [{ body: { data: 'SGVsbG8' } }],
    }),
    null,
  );
  assert.equal(decodeGmailBody({ body: { data: 'SGVsbG8=' } }), null);
  assert.equal(
    decodeGmailBody({
      parts: [{ mimeType: 'text/html', body: { data: 'SGVsbG8' } }],
    }),
    'Hello',
  );
});
test(
  'isolated email worker deduplicates inbox facts, claims polls, sends/retries and redacts failures',
  { skip: !process.env.CORE_INBOX_TEST_DATABASE_URL },
  async () =>
    inboxFixture(async (pool, options) => {
      const mailbox = await credentials.upsertConnectionFromTokens(
        pool,
        options.config,
        'org',
        'user',
        'google',
        'g-user',
        'me@example.test',
        'Mailbox',
        'token',
        null,
        null,
        [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.send',
        ],
        'fixture',
      );
      let detailCalls = 0,
        failSend = false;
      options.fetch = async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/messages/send')) {
          if (failSend)
            return new Response(
              JSON.stringify({ error: { message: 'SECRET PROVIDER BODY' } }),
              { status: 500 },
            );
          const body = JSON.parse(String(init?.body));
          assert.ok(
            Buffer.from(body.raw, 'base64url')
              .toString()
              .includes('In-Reply-To: <provider-id>'),
          );
          return new Response(JSON.stringify({ id: 'outbound' }));
        }
        if (path.endsWith('/messages')) {
          if (
            detailCalls > 0 &&
            new URL(String(url)).searchParams.get('maxResults') === '50'
          )
            assert.ok(
              new URL(String(url)).searchParams.get('q')?.includes('after:'),
            );
          return new Response(
            JSON.stringify({ messages: [{ id: 'inbound' }] }),
          );
        }
        if (new URL(String(url)).searchParams.get('format') === 'metadata')
          return new Response(
            JSON.stringify({
              threadId: 'thread',
              payload: {
                headers: [
                  { name: 'From', value: 'Ada <ada@example.test>' },
                  { name: 'Subject', value: 'Hello' },
                  { name: 'Message-ID', value: '<provider-id>' },
                ],
              },
            }),
          );
        detailCalls++;
        return new Response(
          JSON.stringify({
            id: 'inbound',
            threadId: 'thread',
            internalDate: '1735689600000',
            labelIds: ['UNREAD'],
            payload: {
              headers: [
                { name: 'From', value: 'Ada <ada@example.test>' },
                { name: 'Subject', value: 'Hello' },
              ],
              body: { data: 'SGVsbG8' },
            },
          }),
        );
      };
      assert.equal(
        await syncConnection(
          pool,
          options.config,
          'org',
          mailbox.id,
          options.fetch,
        ),
        1,
      );
      assert.equal(
        await syncConnection(
          pool,
          options.config,
          'org',
          mailbox.id,
          options.fetch,
        ),
        0,
      );
      const conversation = (
        await pool.query('SELECT id,"unreadCount" FROM "Conversation"')
      ).rows[0]!;
      assert.equal(conversation.unreadCount, 1);
      assert.equal(
        (await pool.query('SELECT count(*) FROM "Message"')).rows[0]!.count,
        '1',
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM analytics_outbox WHERE contract_name='conversation.message.lifecycle@1'",
          )
        ).rows[0]!.count,
        '1',
      );
      const out = await sendEmailConversationMessage(
        pool,
        'org',
        conversation.id,
        { text: 'Reply' },
        options,
      );
      assert.equal(out.status, 'SENT');
      assert.equal(
        (await listTimelineMessages(pool, conversation.id)).at(-1)!
          .reference !== null,
        true,
      );
      await assert.rejects(
        sendEmailConversationMessage(
          pool,
          'other',
          conversation.id,
          { text: 'No' },
          options,
        ),
        (error: unknown) => error instanceof ApiError && error.status === 404,
      );
      failSend = true;
      await assert.rejects(
        sendEmailConversationMessage(
          pool,
          'org',
          conversation.id,
          { text: 'Fail' },
          options,
        ),
      );
      const failed = (
        await pool.query(
          'SELECT id,"errorMessage" FROM "Message" WHERE "providerStatus"=\'FAILED\'',
        )
      ).rows[0]!;
      assert.equal(failed.errorMessage, 'bad_gateway');
      await assert.rejects(
        retryEmailConversationMessage(
          pool,
          'org',
          conversation.id,
          failed.id,
          options,
        ),
      );
      assert.equal(
        (
          await pool.query(
            'SELECT "providerStatus" FROM "Message" WHERE id=$1',
            [failed.id],
          )
        ).rows[0]!.providerStatus,
        'FAILED',
      );
      await pool.query(
        'UPDATE "EmailInboxBinding" SET "inboundStatus"=\'SYNCING\',"updatedAt"=NOW()',
      );
      assert.equal(
        await syncConnection(
          pool,
          options.config,
          'org',
          mailbox.id,
          options.fetch,
        ),
        0,
      );
      assert.equal(detailCalls, 2);
      assert.equal(
        (
          await execute(
            pool,
            options.config,
            'org',
            'search',
            {},
            options.fetch,
          )
        ).provider,
        'google',
      );
      await pool.query(
        `UPDATE "EmailInboxBinding" SET "inboundStatus"='READY'`,
      );
      const failedPoll: typeof fetch = async () =>
        new Response(
          JSON.stringify({ error: { message: 'PRIVATE PROVIDER DETAILS' } }),
          { status: 503 },
        );
      await assert.rejects(
        syncConnection(pool, options.config, 'org', mailbox.id, failedPoll),
      );
      const readiness = (
        await pool.query(
          'SELECT "inboundStatus","lastError" FROM "EmailInboxBinding"',
        )
      ).rows[0]!;
      assert.equal(readiness.inboundStatus, 'RETRYABLE_FAILURE');
      assert.equal(readiness.lastError, 'bad_gateway');
      const microsoft = await credentials.upsertConnectionFromTokens(
        pool,
        options.config,
        'org-ms',
        'user',
        'microsoft',
        'ms-user',
        'ms@example.test',
        'Outlook',
        'ms-token',
        null,
        null,
        ['Mail.Read', 'Mail.Send'],
        'fixture',
      );
      const microsoftCalls: { url: string; body: unknown }[] = [];
      const msFetch: typeof fetch = async (url, init) => {
        microsoftCalls.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(null, { status: 204 });
      };
      assert.equal(
        (
          await execute(
            pool,
            options.config,
            'org-ms',
            'send',
            { body: 'Text', to: ['to@example.test'], subject: 'Subject' },
            msFetch,
          )
        ).messageId,
        null,
      );
      assert.equal(
        microsoftCalls[0]!.url,
        'https://graph.microsoft.com/v1.0/me/sendMail',
      );
      assert.deepEqual(microsoftCalls[0]!.body, {
        message: {
          subject: 'Subject',
          body: { contentType: 'Text', content: 'Text' },
          toRecipients: [{ emailAddress: { address: 'to@example.test' } }],
        },
        saveToSentItems: true,
      });
      await execute(
        pool,
        options.config,
        'org-ms',
        'reply',
        { body: 'Reply', messageId: "id/with'chars" },
        msFetch,
      );
      assert.ok(
        microsoftCalls[1]!.url.endsWith('/me/messages/id%2Fwith%27chars/reply'),
      );
      assert.ok(microsoft.id);
    }),
);
