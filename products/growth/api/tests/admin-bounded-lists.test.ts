import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { adminPage } from '../src/services/admin/pagination.js';
import { listWebServices } from '../src/services/admin/web-services.js';
import { listCampaigns, listOutreachLeads, listDeliveryLogs } from '../src/services/admin/outreach.js';

function recordingPool() {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const pool = { async query(sql: string, args: unknown[] = []) {
    calls.push({ sql, args });
    return { rows: sql.includes('COUNT(*)') ? [{ total: '501', sent: '490', failed: '11', uncertain: '2' }] : [] };
  } } as unknown as Pool;
  return { pool, calls };
}

test('admin paging validates integers and bounds page size and offset', () => {
  assert.deepEqual(adminPage({ page: '3', limit: '10000' }), { page: 3, limit: 200, offset: 400 });
  for (const value of ['0', '-1', 'NaN', '1.5', '9007199254740992']) {
    assert.throws(() => adminPage({ page: value }));
    assert.throws(() => adminPage({ limit: value }));
  }
  assert.throws(() => adminPage({ page: '10000001' }));
});

test('Web service filtering runs in SQL and count stays independent of page', async () => {
  const { pool, calls } = recordingPool();
  const result = await listWebServices(pool, { paginate: 'true', page: '3', limit: '50', search: "O'Reilly", callStatus: 'pending' });
  assert.deepEqual(result, { items: [], total: 501, page: 3, limit: 50 });
  assert.match(calls[0]!.sql, /"callStatus"=\$1/);
  assert.match(calls[1]!.sql, /ILIKE \$2/);
  assert.ok(!calls[1]!.sql.includes("O'Reilly"));
  assert.deepEqual(calls[1]!.args, ['pending', "%O'Reilly%", 50, 100]);
  assert.match(calls[1]!.sql, /ORDER BY "createdAt" DESC, id ASC LIMIT \$3 OFFSET \$4/);
});

test('campaign and lead queries page in SQL with deterministic order', async () => {
  const first = recordingPool();
  assert.deepEqual(await listCampaigns(first.pool, { paginate: 'true', page: '2' }), { items: [], total: 501, page: 2, limit: 50 });
  assert.deepEqual(first.calls[1]!.args, [50, 50]);
  const second = recordingPool();
  assert.deepEqual(await listOutreachLeads(second.pool, 'campaign-1', { paginate: 'true', emailStatus: 'pending', search: 'acme', limit: '25', page: '2' }), { items: [], total: 501, page: 2, limit: 25 });
  assert.deepEqual(second.calls[1]!.args, ['campaign-1', 'pending', '%acme%', 25, 25]);
  assert.match(second.calls[1]!.sql, /ORDER BY "createdAt" DESC, id ASC LIMIT/);
});

test('delivery totals aggregate all filtered rows while records remain bounded', async () => {
  const { pool, calls } = recordingPool();
  const result = await listDeliveryLogs(pool, { paginate: 'true', recipient: 'someone@example.com', page: '4', limit: '100' });
  assert.deepEqual(result, { items: [], total: 501, sent: 490, failed: 11, uncertain: 2, page: 4, limit: 100 });
  assert.match(calls[0]!.sql, /FILTER \(WHERE l.status IN \('failed','rejected','not_submitted'\)\)/);
  assert.deepEqual(calls[1]!.args, ['%someone@example.com%', 100, 300]);
  assert.match(calls[1]!.sql, /ORDER BY l."attemptedAt" DESC, l.id ASC/);
});

test('CSV export remains explicitly capped, uses no page count, and rejects negative limits', async () => {
  const { pool, calls } = recordingPool();
  const csv = await listDeliveryLogs(pool, { format: 'csv', limit: '999999' });
  assert.equal(typeof csv, 'string');
  assert.deepEqual(calls[0]!.args, [20000, 0]);
  await assert.rejects(listDeliveryLogs(pool, { limit: -1n }));
});
