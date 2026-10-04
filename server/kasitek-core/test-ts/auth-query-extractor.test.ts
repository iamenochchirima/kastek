import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../src-ts/config.js';
import { buildApp } from '../src-ts/app.js';
import type { CoreContext } from '../src-ts/context.js';
import { registerAuthRoutes } from '../src-ts/routes/auth.js';

test('OIDC query extractors reject repeated typed fields before side effects', async () => {
  const config = readConfig({
      DATABASE_URL: 'postgres://unused',
      FRONTEND_URL: 'http://localhost:3000',
      LOG_LEVEL: 'silent',
    }),
    context = {
      config,
      pool: {
        query: () => {
          throw new Error('query extraction must run before database access');
        },
      },
    } as unknown as CoreContext,
    app = await buildApp(context, [registerAuthRoutes]);

  try {
    for (const [url, field] of [
      ['/api/auth/login?returnTo=%2F&returnTo=%2Felsewhere', 'returnTo'],
      ['/api/auth/login?screen=login&screen=signup', 'screen'],
      ['/api/auth/callback?state=first&state=second', 'state'],
      ['/api/auth/callback?error=denied&error=other', 'error'],
    ] as const) {
      const response = await app.inject({ url });
      assert.equal(response.statusCode, 400);
      assert.equal(
        response.headers['content-type'],
        'text/plain; charset=utf-8',
      );
      assert.equal(
        response.body,
        'Query deserialize error: duplicate field `' + field + '`',
      );
    }
  } finally {
    await app.close();
  }
});
