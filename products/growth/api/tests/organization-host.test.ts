import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { registerOrganizationRoutes } from '../src/routes/orgs.js';

test('organization switching accepts configured frontend/API hosts without trusting forwarded hosts', async () => {
  const pool = new pg.Pool({ connectionString: 'postgres://unused' });
  const config = readConfig({ DATABASE_URL: 'postgres://unused', FRONTEND_URL: 'https://app.example', KASITEK_CORE_PUBLIC_URL: 'https://api.example' });
  const app = await buildApp({ pool, config }, [registerOrganizationRoutes]);
  try {
    for (const host of ['app.example', 'api.example']) {
      const response = await app.inject({ method: 'POST', url: '/api/orgs/set-active', headers: { host, origin: 'https://app.example' }, payload: { orgId: 'fixture' } });
      assert.equal(response.statusCode, 401, `${host} must still require its session cookie`);
      assert.equal(response.json().error, 'Sign in required');
      const wrongOrigin = await app.inject({ method: 'POST', url: '/api/orgs/set-active', headers: { host, origin: 'https://attacker.example' }, payload: { orgId: 'fixture' } });
      assert.equal(wrongOrigin.statusCode, 403);
    }
    for (const host of ['unknown.example', 'api.example.attacker.example', 'app.example:444']) {
      const response = await app.inject({ method: 'POST', url: '/api/orgs/set-active', headers: { host, origin: 'https://app.example', 'x-forwarded-host': 'app.example' }, payload: { orgId: 'fixture' } });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error, 'Invalid request host');
    }
    const missingOrigin = await app.inject({ method: 'POST', url: '/api/orgs/set-active', headers: { host: 'api.example' }, payload: { orgId: 'fixture' } });
    assert.equal(missingOrigin.statusCode, 403);
  } finally {
    await app.close();
    await pool.end();
  }
});
