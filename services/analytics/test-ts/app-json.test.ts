import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { buildApp } from '../src-ts/app.js';
import type { AnalyticsContext } from '../src-ts/context.js';
import { readConfig } from '../src-ts/config.js';
import type { RegistrySnapshot } from '../src-ts/registry-types.js';
import { ProcessMetrics } from '../src-ts/metrics.js';
import { MAX_BATCH_BYTES } from '../src-ts/ingestion.js';

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

test('Analytics DTO JSON rejects repeated typed fields but preserves Value-map duplicates', async () => {
  const context = {
    pool: {} as Pool,
    config: readConfig({ ANALYTICS_DATABASE_URL: 'postgres://unused' }),
    registry: {} as RegistrySnapshot,
    metrics: new ProcessMetrics(),
  } satisfies AnalyticsContext;
  const app = await buildApp(context);
  try {
    const duplicateDtoField = await app.inject({
      method: 'POST',
      url: '/internal/ingest/v1/batch',
      headers: { 'content-type': 'application/json' },
      payload: '{"records":[{"producer_id":"first","producer_id":"second"}]}',
    });
    assert.equal(duplicateDtoField.statusCode, 400);
    assert.match(duplicateDtoField.body, /duplicate field `producer_id`/);

    for (const [url, payload, field] of [
      [
        '/internal/reconciliation/v1/summary',
        '{"reconciliation_run_id":"first","reconciliation_run_id":"second"}',
        'reconciliation_run_id',
      ],
      [
        '/internal/rollouts/v1/controls',
        '{"control_key":"first","control_key":"second"}',
        'control_key',
      ],
      [
        '/v1/reports/query',
        '{"reporting_scope_id":1,"reporting_scope_id":2}',
        'reporting_scope_id',
      ],
    ]) {
      const duplicateField = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload,
      });
      assert.equal(duplicateField.statusCode, 400, url);
      assert.ok(duplicateField.body.includes("duplicate field `" + field + "`"));
    }

    const duplicateValueMapKey = await app.inject({
      method: 'POST',
      url: '/internal/ingest/v1/batch',
      headers: { 'content-type': 'application/json' },
      payload: '{"records":[{"producer_id":"producer","source_stream_key":"stream","source_sequence":1,"record_category":"event","record_id":"record","contract_name":"contract","schema_version":1,"scope_kind":"agency","scope_external_id":"workspace","payload_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","envelope":{"data":{"key":"first","key":"last"}}}]}',
    });
    assert.equal(duplicateValueMapKey.statusCode, 401);
    assert.equal(duplicateValueMapKey.headers['www-authenticate'], 'Bearer');
  } finally {
    await app.close();
  }
});

test('bodyless rollout expiry does not inherit the JSON extractor size cap', async () => {
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
      url: '/internal/rollouts/v1/expire',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(MAX_BATCH_BYTES + 1, 0x78),
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'unauthorized' });
  } finally {
    await app.close();
  }
});
