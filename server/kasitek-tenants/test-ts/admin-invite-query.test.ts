import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { buildApp } from '../src-ts/app.js';
import type { TenantContext } from '../src-ts/context.js';
import { readConfig } from '../src-ts/config.js';
import { registerAdminInvitesRoutes } from '../src-ts/controllers/admin-invites.js';

test('admin invite query preserves Actix typed-query extraction', async () => {
  let databaseCalls = 0;
  const context = {
    config: readConfig({
      TENANT_DATABASE_URL: 'postgres://unused',
      TENANT_SERVER_ENVIRONMENT: 'production',
      TENANT_ALLOWED_ORIGINS: 'https://portal.example',
    }),
    pool: {
      query: async () => {
        databaseCalls += 1;
        return { rows: [] };
      },
    } as unknown as Pool,
  } satisfies TenantContext;
  const app = await buildApp(context, [registerAdminInvitesRoutes]);
  try {
    for (const [url, detail] of [
      ['/api/auth/admin-invite', 'missing field `token`'],
      [
        '/api/auth/admin-invite?token=one&token=two',
        'duplicate field `token`',
      ],
    ]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 400);
      assert.equal(response.body, `Query deserialize error: ${detail}`);
      assert.match(response.headers['content-type']!, /^text\/plain/);
    }

    const unknownFields = await app.inject({
      method: 'GET',
      url: '/api/auth/admin-invite?token=one&extra=a&extra=b',
    });
    assert.equal(unknownFields.statusCode, 404);
    assert.deepEqual(unknownFields.json(), { error: 'not found: invite not found' });
    assert.equal(databaseCalls, 1);
  } finally {
    await app.close();
  }
});
