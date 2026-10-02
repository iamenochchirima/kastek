import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { readConfig } from '../src-ts/config.js';
import { buildApp } from '../src-ts/app.js';
import { transaction } from '../src-ts/db.js';
import { ApiError } from '../src-ts/error.js';

test('CORS preserves loopback boundaries without accepting staging, credentials or lookalikes', async () => {
  for (const environment of ['development', 'staging']) {
    const config = readConfig({ DATABASE_URL: 'postgres://unused', ENVIRONMENT: environment, LOG_LEVEL: 'silent' });
    const app = await buildApp({ config, pool: {} as Pool });
    try {
      for (const [origin, allowed] of [
        ['http://127.10.20.30:5173', environment === 'development'],
        ['http://localhost:5173/path', false],
        ['http://user@localhost:5173', false],
        ['http://localhost.example.com:5173', false],
        ['http://localhost:3000', true],
      ] as const) {
        const response = await app.inject({ method: 'OPTIONS', url: '/health', headers: {
          origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'idempotency-key',
        } });
        assert.equal(response.headers['access-control-allow-origin'], allowed ? origin : undefined);
      }
    } finally { await app.close(); }
  }
});

test('public failures preserve stable codes and never expose PostgreSQL row values', async () => {
  const config = readConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' });
  const app = await buildApp({ config, pool: {} as Pool }, [(server) => {
    server.get('/limit', () => { throw new ApiError(429, 'rate_limited', 'Provider rate limit exceeded'); });
    server.get('/db-error', () => { throw Object.assign(new Error('secret account token in row'), {
      severity: 'ERROR', code: '23505', table: 'User', constraint: 'User_email_key',
    }); });
  }]);
  try {
    const limited = await app.inject('/limit');
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers['retry-after'], '60');
    assert.deepEqual(limited.json(), { error: 'Provider rate limit exceeded', code: 'rate_limited' });
    const failed = await app.inject('/db-error');
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(failed.json(), { error: 'Database operation failed', code: 'internal_error' });
    assert.ok(!failed.body.includes('secret'));
  } finally { await app.close(); }
});

test('a failed transaction rolls back on its checked-out client before release', async () => {
  const calls: string[] = [];
  const cause = new Error('failed statement');
  const client = { query: async (sql: string) => { calls.push(sql); }, release: () => calls.push('release') };
  const pool = { connect: async () => client, query: () => { throw new Error('pool query inside transaction'); } };
  await assert.rejects(transaction(pool as unknown as Pool, async (connection) => {
    assert.equal(connection, client);
    await connection.query('UPDATE protected_row');
    throw cause;
  }), (error) => error === cause);
  assert.deepEqual(calls, ['BEGIN', 'UPDATE protected_row', 'ROLLBACK', 'release']);
});
