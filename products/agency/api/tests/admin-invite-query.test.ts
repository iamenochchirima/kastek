import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import type { TenantContext } from '../src/context.js';
import { readConfig } from '../src/config.js';
import { registerAdminInvitesRoutes } from '../src/controllers/admin-invites.js';
import { registerClientAuthRoutes } from '../src/controllers/client-auth.js';
import { tokenHash } from '../src/middleware.js';

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

test('client invite HashMap query keeps the last repeated value', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const context = {
    config: readConfig({
      TENANT_DATABASE_URL: 'postgres://unused',
      TENANT_SERVER_ENVIRONMENT: 'production',
      TENANT_ALLOWED_ORIGINS: 'https://portal.example',
      TENANT_DEFAULT_WORKSPACE_SLUG: 'fixture-workspace',
    }),
    pool: {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes('FROM workspaces WHERE slug=$1'))
          return {
            rows: [
              {
                workspace_id: 'workspace-1',
                workspace_slug: 'fixture-workspace',
                display_name: 'Fixture Workspace',
                status: 'active',
              },
            ],
          };
        return { rows: [] };
      },
    } as unknown as Pool,
  } satisfies TenantContext;
  const app = await buildApp(context, [registerClientAuthRoutes]);
  try {
    const response = await app.inject(
      '/api/client-auth/invite?token=first&token=last&extra=a&extra=b',
    );
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'unauthorized' });
    const inviteLookup = calls.find((call) =>
      call.sql.includes('FROM tenant_client_invites i'),
    );
    assert.deepEqual(inviteLookup?.values, [tokenHash('last'), 'workspace-1']);
  } finally {
    await app.close();
  }
});
