import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { CoreContext } from '../src/context.js';
import { registerOrganizationRoutes } from '../src/routes/orgs.js';

async function fixture(frontend = 'https://growth.test') {
  let memberships = [{ id: 'first' }, { id: 'second' }];
  let sessionValid = true;
  let verified = true;
  const pool = {
    async connect() {
      return {
        async query(sql: string) {
          if (sql.includes('SELECT "userId","refreshToken"'))
            return { rows: sessionValid ? [{ userId: 'user', check: false, refresh: false }] : [] };
          return { rows: [] };
        },
        release() {},
      };
    },
    async query(sql: string) {
      if (sql.includes('FROM "User"')) return { rows: [{ id: 'user', emailVerified: verified ? new Date() : null }] };
      if (sql.includes('FROM "Organization" o JOIN "OrganizationMember"')) return { rows: memberships };
      throw Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = await buildApp({ pool, config: readConfig({ DATABASE_URL: 'postgres://unused', FRONTEND_URL: frontend, LOG_LEVEL: 'silent' }) } as CoreContext, [registerOrganizationRoutes]);
  return { app, setMemberships(value: typeof memberships) { memberships = value; }, invalidateSession() { sessionValid = false; }, unverify() { verified = false; } };
}

test('active organization selection requires exact public Host, Origin, current cookie session and membership', async () => {
  const { app, invalidateSession, unverify } = await fixture();
  const headers = { host: 'growth.test', origin: 'https://growth.test', cookie: 'kasitek_session=fixture' };
  const submit = (changes = {}, payload: unknown = { orgId: 'second' }) => app.inject({ method: 'POST', url: '/api/orgs/set-active', headers: Object.fromEntries(Object.entries({ ...headers, ...changes }).filter(([, value]) => value !== undefined)) as Record<string, string>, payload });
  try {
    for (const change of [
      { host: 'api.internal', 'x-forwarded-host': 'growth.test' },
      { origin: 'https://evil.test' },
      { origin: undefined },
      { cookie: undefined, authorization: 'Bearer fixture' },
    ]) {
      const response = await submit(change);
      assert.equal(response.statusCode, change.cookie === undefined && 'cookie' in change ? 401 : 403);
      assert.equal(response.headers['set-cookie'], undefined);
    }
    for (const payload of [{}, { orgId: 42 }, { orgId: '' }]) assert.equal((await submit({}, payload)).statusCode, 400);
    assert.equal((await submit({}, { orgId: 'foreign' })).statusCode, 403);
    const accepted = await submit();
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(accepted.json(), { ok: true });
    assert.equal(accepted.headers['cache-control'], 'no-store');
    const cookie = String(accepted.headers['set-cookie']);
    for (const part of ['kasitek_active_org=second', 'Max-Age=31536000', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(cookie.includes(part), cookie);
    unverify();
    assert.equal((await submit()).statusCode, 403);
    invalidateSession();
    assert.equal((await submit()).statusCode, 401);
  } finally { await app.close(); }
});

test('organization bootstrap validates the preference and clears revoked membership cookies', async () => {
  const { app, setMemberships } = await fixture();
  const read = (preference?: string) => app.inject({ method: 'GET', url: '/api/orgs', headers: { cookie: `kasitek_session=fixture${preference ? `; kasitek_active_org=${preference}` : ''}` } });
  try {
    assert.equal((await read()).json().activeOrgId, 'first');
    assert.equal((await read('second')).json().activeOrgId, 'second');
    setMemberships([{ id: 'first' }]);
    const revoked = await read('second');
    assert.deepEqual(revoked.json(), { orgs: [{ id: 'first' }], activeOrgId: 'first' });
    assert.equal(revoked.headers['cache-control'], 'no-store');
    assert.match(String(revoked.headers['set-cookie']), /kasitek_active_org=;.*Path=\/;.*Expires=Thu, 01 Jan 1970/);
    setMemberships([]);
    assert.deepEqual((await read()).json(), { orgs: [], activeOrgId: null });
  } finally { await app.close(); }
});

test('local HTTP selection keeps the cookie host-only without requiring Secure', async () => {
  const { app } = await fixture('http://localhost:3000');
  try {
    const response = await app.inject({ method: 'POST', url: '/api/orgs/set-active', headers: { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: 'kasitek_session=fixture' }, payload: { orgId: 'first' } });
    assert.equal(response.statusCode, 200);
    assert.doesNotMatch(String(response.headers['set-cookie']), /Secure|Domain=/);
  } finally { await app.close(); }
});
