import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import pg from 'pg';
import { installPgTimestampParsers } from '../src/db.js';
import { readConfig } from '../src/config.js';
import { encryptSocialSecret } from '../src/integrations/crypto.js';
import * as calls from '../src/services/whatsapp/calls.js';
import { SerdeFloat } from '@kasitek-labs/server-support/json';

test('WhatsApp call statuses preserve source precedence, epoch parsing and SDP line normalization', () => {
  assert.equal(
    calls.mapCallStatus({ event: 'connect', status: 'answered' }),
    'ACTIVE',
  );
  assert.equal(
    calls.mapCallStatus({ event: 'terminate', reason: 'no_answer_timeout' }),
    'MISSED',
  );
  assert.equal(
    calls.mapCallStatus({ event: 'terminate', reason: 'declined' }),
    'REJECTED',
  );
  assert.equal(
    calls.mapCallStatus({ event: 'terminate', reason: 'provider error' }),
    'FAILED',
  );
  assert.equal(
    calls.mapCallDirection({ from: '+27 (111)' }, '+27111'),
    'OUTBOUND',
  );
  assert.equal(
    calls.parseCallTimestamp('1720000000')?.toISOString(),
    '2024-07-03T09:46:40.000Z',
  );
  assert.equal(calls.parseCallTimestamp(new SerdeFloat(1720000000)), null);
  assert.equal(calls.parseCallTimestamp('2026-02-31T00:00:00Z'), null);
  assert.equal(
    calls.normalizeSdp('v=0 \n\na=sendrecv\r'),
    'v=0\r\na=sendrecv\r\n',
  );
  assert.equal(
    calls.metaOfferSession({
      session: null,
      call: { session: { sdp: 'fixture' } },
    }),
    null,
  );
});

test(
  'WhatsApp calls ingest, customer binding, duplicate events, SDP signalling, scoped access, provider failure and summary',
  { skip: !process.env.CORE_WHATSAPP_CALLS_TEST_DATABASE_URL },
  async () => {
    installPgTimestampParsers();
    const url = process.env.CORE_WHATSAPP_CALLS_TEST_DATABASE_URL!,
      schema = `wa_calls_test_${randomUUID().replaceAll('-', '')}`,
      admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
        connectionString: url,
        options: `-c search_path=${schema} -c timezone=UTC`,
      }),
      config = readConfig({
        DATABASE_URL: url,
        SOCIAL_TOKEN_ENCRYPTION_KEY: 'fixture-call-encryption',
      }),
      providerCalls: Record<string, unknown>[] = [],
      events: unknown[] = [],
      pushes: unknown[] = [];
    let providerStatus = 200;
    const server = createServer((request, response) => {
      let chunks = '';
      request.on('data', (c) => (chunks += c));
      request.on('end', () => {
        assert.equal(request.url, '/phone-id/calls');
        assert.equal(request.headers.authorization, 'Bearer fixture-token');
        providerCalls.push(JSON.parse(chunks));
        response.writeHead(providerStatus, {
          'content-type': 'application/json',
        });
        response.end(
          providerStatus === 200
            ? '{"success":true}'
            : '{"error":{"message":"Fixture provider rejection"}}',
        );
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const options: calls.CallsOptions = {
      graphBase: `http://127.0.0.1:${address.port}`,
      publishEvent: async (org, event) => {
        assert.equal(org, 'org-a');
        events.push(event);
      },
      sendPush: async (user, payload) => {
        assert.equal(user, 'fixture-user');
        pushes.push(payload);
      },
    };
    try {
      const migrations = resolve(
          process.cwd(),
          '../../../kasitek-growth/client/packages/database/prisma/migrations',
        ),
        initial = readFileSync(
          resolve(
            migrations,
            '20260301000000_initial_client_schema/migration.sql',
          ),
          'utf8',
        );
      for (const sql of initial.match(/CREATE TYPE [\s\S]*?;/g) ?? [])
        await pool.query(sql);
      for (const table of ['WhatsappConnection', 'Conversation'])
        await pool.query(
          initial.match(new RegExp(`CREATE TABLE "${table}"[\\s\\S]*?;`))![0],
        );
      await pool.query(
        `ALTER TABLE "WhatsappConnection" ADD COLUMN "orgId" text;ALTER TABLE "Conversation" ADD COLUMN "orgId" text,ADD COLUMN "customerId" text,ADD COLUMN "externalConnectionId" text;CREATE TABLE "ExternalConnection"(id text,"orgId" text,"sourceType" text,"sourceId" text);CREATE TABLE "User"(id text PRIMARY KEY);INSERT INTO "User" VALUES('fixture-user');`,
      );
      const customerMigration = readFileSync(
        resolve(
          migrations,
          '20260717170000_add_canonical_customers/migration.sql',
        ),
        'utf8',
      );
      for (const sql of customerMigration.match(
        /CREATE (?:TYPE|TABLE|UNIQUE INDEX|INDEX)[\s\S]*?;/g,
      ) ?? [])
        if (!sql.includes('WhatsappContact')) await pool.query(sql);
      const callMigration = readFileSync(
        resolve(
          migrations,
          '20260331093000_add_whatsapp_call_sessions/migration.sql',
        ),
        'utf8',
      );
      for (const sql of callMigration.match(
        /CREATE (?:TYPE|TABLE|UNIQUE INDEX|INDEX)[\s\S]*?;/g,
      ) ?? [])
        await pool.query(sql);
      await pool.query(
        `INSERT INTO "WhatsappConnection"(id,"userId","orgId","phoneNumberId","phoneDisplayNumber","accessTokenEncrypted","wabaId","updatedAt")VALUES('connection','fixture-user','org-a','phone-id','+27111',$1,'fixture-waba',NOW());`,
        [encryptSocialSecret(config, 'fixture-token')],
      );
      await pool.query(
        `INSERT INTO "ExternalConnection" VALUES('external','org-a','WHATSAPP','connection')`,
      );
      const offer = {
        metadata: { phone_number_id: 'phone-id' },
        contacts: [{ wa_id: '+27222', profile: { name: 'Fixture Caller' } }],
        calls: [
          {
            id: 'wa-call-1',
            event: 'connect',
            from: '+27222',
            to: '+27111',
            timestamp: '2026-10-02T10:00:00Z',
            session: { sdp_type: 'offer', sdp: 'v=0\na=sendrecv\n' },
          },
        ],
      };
      await calls.ingestWebhookCalls(pool, config, offer, options);
      const row = (await calls.listCalls(pool, 'org-a')).calls[0]!;
      assert.equal(row.user_id, 'fixture-user');
      assert.equal(row.status, 'RINGING');
      assert.ok(row.conversationId);
      assert.equal(pushes.length, 1);
      assert.equal((pushes[0] as any).body, 'Fixture Caller is calling you');
      assert.equal(
        (
          await pool.query(
            `SELECT "customerId","externalConnectionId" FROM "Conversation"`,
          )
        ).rows[0].externalConnectionId,
        'external',
      );
      await calls.ingestWebhookCalls(pool, config, offer, options);
      assert.equal((await calls.listCalls(pool, 'org-a')).calls.length, 1);
      assert.equal(pushes.length, 1);
      assert.equal(
        (await calls.getCall(pool, 'org-a', String(row.id))).events.length,
        2,
      );
      assert.equal((await calls.listCalls(pool, 'org-b')).calls.length, 0);
      await assert.rejects(
        calls.getCall(pool, 'org-b', String(row.id)),
        /Call session not found/,
      );
      const media = await calls.getCallMediaSession(
        pool,
        'org-a',
        String(row.id),
      );
      assert.equal(media.mediaSession.webrtc.sdp, 'v=0\r\na=sendrecv\r\n');
      const accepted = await calls.applyCallAction(
        pool,
        config,
        'org-a',
        String(row.id),
        { action: 'accept' },
        options,
      );
      assert.equal(accepted.call.status, 'CONNECTING');
      assert.equal((accepted.providerAction as any).awaitingLocalAnswer, true);
      assert.equal(providerCalls.length, 0);
      await assert.rejects(
        calls.applyCallAction(
          pool,
          config,
          'org-a',
          String(row.id),
          { action: 'accept' },
          options,
        ),
        /Only ringing calls/,
      );
      const answer = await calls.postCallSignal(
        pool,
        config,
        'org-a',
        String(row.id),
        {
          kind: ' ANSWER ',
          payload: { type: 'answer', sdp: 'v=0\na=recvonly' },
        },
        options,
      );
      assert.equal(answer.providerResult.action, 'accept');
      assert.deepEqual(providerCalls[0], {
        messaging_product: 'whatsapp',
        call_id: 'wa-call-1',
        action: 'accept',
        session: { sdp_type: 'answer', sdp: 'v=0\r\na=recvonly\r\n' },
      });
      const ignored = await calls.postCallSignal(
        pool,
        config,
        'org-a',
        String(row.id),
        { kind: 'ice', payload: { candidate: 'fixture' } },
        options,
      );
      assert.equal(ignored.providerResult.ignored, true);
      assert.equal(providerCalls.length, 1);
      assert.equal(
        (await calls.listCallSignals(pool, 'org-a', String(row.id))).signals
          .length,
        2,
      );
      await calls.ingestWebhookCalls(
        pool,
        config,
        {
          metadata: offer.metadata,
          calls: [
            {
              id: 'wa-call-1',
              event: 'answer',
              from: '+27222',
              to: '+27111',
              timestamp: 1720000000,
              answered_at: '2026-10-02T11:00:00Z',
            },
          ],
        },
        options,
      );
      assert.equal(
        (await calls.getCall(pool, 'org-a', String(row.id))).call.status,
        'ACTIVE',
      );
      assert.equal(
        (await calls.getCallMediaSession(pool, 'org-a', String(row.id)))
          .mediaSession.webrtc.sdp,
        'v=0\r\na=sendrecv\r\n',
      );
      providerStatus = 400;
      await assert.rejects(
        calls.applyCallAction(
          pool,
          config,
          'org-a',
          String(row.id),
          { action: 'end' },
          options,
        ),
        /Meta Calling API request failed \(400 Bad Request\): Fixture provider rejection/,
      );
      assert.equal(
        (await calls.getCall(pool, 'org-a', String(row.id))).call.status,
        'COMPLETED',
      );
      const summary = await calls.callSummary(pool, 'org-a', 999n);
      assert.equal(summary.days, 90);
      assert.equal(summary.summary.totalCalls, 1n);
      assert.equal(summary.summary.completedCalls, 1n);
      assert.ok(summary.trend.length);
      assert.equal(
        (await pool.query(`SELECT COUNT(*) FROM "CustomerIdentity"`)).rows[0]
          .count,
        '1',
      );
      assert.ok(events.length >= 6);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      await new Promise<void>((done, reject) =>
        server.close((e) => (e ? reject(e) : done())),
      );
    }
  },
);
