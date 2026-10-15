import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { agentWorkspaceReport } from '../src/services/workspace-reporting.js';
import { apiJson } from '../src/json.js';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { registerInternalWorkspaceRoutes } from '../src/routes/internal-workspace.js';

test('internal workspace HTTP rejects browser credentials before reading data and serializes authorized aggregate counts', async () => {
  let reads = 0;
  const pool = { query: async (query: string, parameters: unknown[]) => {
    reads += 1;
    assert.deepEqual(parameters, ['one']);
    return { rows: query.includes('GROUP BY') ? [] : [{ count: '0' }] };
  } } as unknown as pg.Pool;
  const config = readConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent',
    KASITEK_AGENTS_INTERNAL_TOKEN: 'synthetic-internal-token' });
  const app = await buildApp({ pool, config }, [registerInternalWorkspaceRoutes]);
  try {
    const url = '/api/internal/agents/v1/workspace/report';
    assert.equal((await app.inject({ url, headers: { cookie: 'kasitek_session=browser-cookie' } })).statusCode, 401);
    assert.equal(reads, 0);
    assert.equal((await app.inject({ url, headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
    assert.equal(reads, 0);
    const headers = { authorization: 'Bearer synthetic-internal-token', 'x-organization-id': 'one' };
    const result = await app.inject({ url, headers });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().organizationId, 'one');
    assert.equal(result.json().content.postCount, 0);
    assert.equal(reads, 10);
  } finally { await app.close(); }
});

test('private workspace aggregates preserve exact i64 counts and propagate database failures', async () => {
  const value = '9007199254740993';
  const pool = { query: async (query: string, parameters: unknown[]) => {
    assert.deepEqual(parameters, ['organization']);
    return { rows: query.includes('GROUP BY') ? [{ status: 'ACTIVE', count: value }] : [{ count: value }] };
  } } as unknown as pg.Pool;
  const report = await agentWorkspaceReport(pool, 'organization');
  assert.equal(report.connections.total, 9007199254740993n);
  assert.equal(report.contacts.optedIn, 9007199254740993n);
  assert.ok(apiJson(report).includes('"postCount":9007199254740993'));
  const failed = { query: async () => { throw new Error('synthetic database failure'); } } as unknown as pg.Pool;
  await assert.rejects(agentWorkspaceReport(failed, 'organization'), /synthetic database failure/);
});

test('private workspace report isolates organizations and distinct list memberships in PostgreSQL',
  { skip: !process.env.CORE_WORKSPACE_TEST_DATABASE_URL }, async () => {
    const url = process.env.CORE_WORKSPACE_TEST_DATABASE_URL!;
    const schema = `workspace_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    try {
      for (const table of ['ExternalConnection', 'SocialPost', 'WhatsappContact', 'Booking', 'WhatsappCampaign', 'WhatsappTemplate']) {
        await pool.query(`CREATE TABLE "${table}"("orgId" text, status text)`);
        await pool.query(`INSERT INTO "${table}" VALUES ('one','ACTIVE'),('other','PRIVATE_STATUS')`);
      }
      await pool.query(`CREATE TABLE "WhatsappContactListMembership"("orgId" text,"contactId" text,"optIn" boolean,excluded boolean);
        INSERT INTO "WhatsappContactListMembership" VALUES ('one','same',true,false),('one','same',true,false),('other','secret',true,true);
        CREATE TABLE "Conversation"("orgId" text,"unreadCount" integer);
        INSERT INTO "Conversation" VALUES ('one',2),('one',0),('other',1)`);
      const report = await agentWorkspaceReport(pool, 'one');
      assert.deepEqual(report.contacts, { total: 1n, optedIn: 1n, excluded: 0n });
      assert.deepEqual(report.inbox, { conversationCount: 2n, unreadConversationCount: 1n });
      assert.deepEqual(report.connections, { total: 1n, byStatus: [{ status: 'ACTIVE', count: 1n }] });
      assert.equal(report.bookings.total, 1n);
      assert.equal(report.campaigns.total, 1n);
      assert.equal(report.templates.total, 1n);
      assert.ok(!apiJson(report).includes('PRIVATE_STATUS'));
      const empty = await agentWorkspaceReport(pool, 'absent');
      assert.deepEqual(empty.connections, { total: 0n, byStatus: [] });
      assert.equal(empty.content.postCount, 0n);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });
