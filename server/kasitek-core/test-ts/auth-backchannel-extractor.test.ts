import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../src-ts/config.js';
import { buildApp } from '../src-ts/app.js';
import type { CoreContext } from '../src-ts/context.js';
import { registerAuthRoutes } from '../src-ts/routes/auth.js';

test('back-channel logout keeps the URL-encoded Form extractor boundary', async () => {
  const config = readConfig({
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'silent',
  });
  const context = { config, pool: {} } as unknown as CoreContext;
  const app = await buildApp(context, [registerAuthRoutes]);
  try {
    const json = await app.inject({
      method: 'POST',
      url: '/api/auth/backchannel-logout',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    assert.equal(json.statusCode, 415);
    assert.equal(json.body, 'Content type error.');

    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/auth/backchannel-logout',
      headers: { 'content-type': 'text/plain' },
      payload: 'logout_token=synthetic',
    });
    assert.equal(unsupported.statusCode, 415);
    assert.equal(unsupported.body, 'Content type error.');

    const missing = await app.inject({
      method: 'POST',
      url: '/api/auth/backchannel-logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'unrelated=value',
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.body, 'Parse error: missing field `logout_token`.');

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/auth/backchannel-logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'logout_token=first&logout_token=second',
    });
    assert.equal(duplicate.statusCode, 400);
    assert.equal(duplicate.body, 'Parse error: duplicate field `logout_token`.');

    const oversized = await app.inject({
      method: 'POST',
      url: '/api/auth/backchannel-logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'x'.repeat(16_385),
    });
    assert.equal(oversized.statusCode, 413);
    assert.equal(
      oversized.body,
      'URL encoded payload is larger (16385 bytes) than allowed (limit: 16384 bytes).',
    );
  } finally {
    await app.close();
  }
});
