import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { buildApp } from '../src-ts/app.js';
import type { AnalyticsContext } from '../src-ts/context.js';
import { readConfig } from '../src-ts/config.js';
import type { RegistrySnapshot } from '../src-ts/registry-types.js';
import { ProcessMetrics } from '../src-ts/metrics.js';

test('Analytics API maps malformed JSON syntax to the shared Serde-style detail', async () => {
  const context = {
    pool: {} as Pool,
    config: readConfig({ ANALYTICS_DATABASE_URL: 'postgres://unused' }),
    registry: {} as RegistrySnapshot,
    metrics: new ProcessMetrics(),
  } satisfies AnalyticsContext;
  const app = await buildApp(context);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/ingest/v1/batch',
      headers: { 'content-type': 'application/json' },
      payload: '[1,]',
    });
    assert.equal(response.statusCode, 400);
    assert.equal(
      response.body,
      'Json deserialize error: trailing comma at line 1 column 4',
    );
  } finally {
    await app.close();
  }
});
