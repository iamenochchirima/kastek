import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import type { AnalyticsContext } from '../src/context.js';
import { readConfig } from '../src/config.js';
import type { RegistrySnapshot } from '../src/registry-types.js';
import { ProcessMetrics } from '../src/metrics.js';

test('typed query routes preserve extractor errors and authorization order', async () => {
  const context = {
    pool: {} as Pool,
    config: readConfig({ ANALYTICS_DATABASE_URL: 'postgres://unused' }),
    registry: {} as RegistrySnapshot,
    metrics: new ProcessMetrics(),
  } satisfies AnalyticsContext;
  const app = await buildApp(context);
  try {
    const cases: Array<[string, number, string?]> = [
      [
        '/v1/metrics/catalog',
        400,
        'Query deserialize error: missing field `reporting_scope_id`',
      ],
      [
        '/v1/metrics/catalog?reporting_scope_id=1&reporting_scope_id=2',
        400,
        'Query deserialize error: duplicate field `reporting_scope_id`',
      ],
      [
        '/v1/metrics/catalog?reporting_scope_id=9223372036854775808',
        400,
        'Query deserialize error: number too large to fit in target type',
      ],
      [
        '/v1/metrics/catalog?reporting_scope_id=1&extra=one',
        400,
        'Query deserialize error: unknown field `extra`, expected `reporting_scope_id`',
      ],
      [
        '/internal/reporting/scopes/resolve?scope_kind=workspace',
        400,
        'Query deserialize error: missing field `external_source_id`',
      ],
      [
        '/internal/reporting/scopes/resolve?scope_kind=workspace&scope_kind=agency&external_source_id=42',
        400,
        'Query deserialize error: duplicate field `scope_kind`',
      ],
      [
        '/internal/reporting/scopes/resolve?scope_kind=workspace&external_source_id=42&extra=one&extra=two',
        401,
      ],
      [
        '/internal/rollouts/v1/evaluate',
        400,
        'Query deserialize error: missing field `control_key`',
      ],
      [
        '/internal/rollouts/v1/evaluate?control_key=ui&control_key=report',
        400,
        'Query deserialize error: duplicate field `control_key`',
      ],
      [
        '/internal/rollouts/v1/evaluate?control_key=ui&control_kind=future',
        400,
        'Query deserialize error: unknown variant `future`, expected `rollout` or `kill_switch`',
      ],
      [
        '/internal/rollouts/v1/evaluate?control_key=ui&reporting_scope_id=9223372036854775808',
        400,
        'Query deserialize error: number too large to fit in target type',
      ],
      [
        '/internal/rollouts/v1/evaluate?control_key=ui&extra=one',
        400,
        'Query deserialize error: unknown field `extra`, expected one of `control_key`, `control_kind`, `source_service`, `source_domain`, `reporting_scope_id`, `cohort_key`',
      ],
      ['/internal/rollouts/v1/evaluate?control_key=ui', 401],
      ['/internal/rollouts/v1/evaluate?control_key=ui&control_kind=rollout', 401],
    ];

    for (const [url, statusCode, body] of cases) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, statusCode, url);
      if (body !== undefined) assert.equal(response.body, body, url);
    }
  } finally {
    await app.close();
  }
});
