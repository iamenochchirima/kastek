import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { generateKeyPair, exportSPKI, CompactSign } from 'jose';
import { randomUUID, createHash } from 'node:crypto';
import { analyticsFixture } from './database-fixture.js';
import { readConfig } from '../src/config.js';
import { apiJson, parseSerdeValueJson } from '../src/json.js';
import { transaction } from '../src/db.js';
import { loadRegistry } from '../src/registry.js';
import { ScopeCatalog, type ReportingGrant } from '../src/scope.js';
import { encodeScopeIds } from '../src/authorization.js';
import {
  ReportingAuthenticator,
  ReportingCache,
  decodeReportRequest,
  expectedPoints,
  registerReportingRoutes,
  reportCacheKey,
  type CacheBackend,
  type ReportResponse,
} from '../src/reporting.js';
import {
  ScopeResolverAuthenticator,
  registerScopeResolutionRoutes,
} from '../src/scope-resolution.js';
const now = () => Math.floor(Date.now() / 1000);
const enabled = !!process.env.ANALYTICS_TEST_DATABASE_URL;
async function signing() {
  const keys = await generateKeyPair('ES256', { extractable: true });
  const pem = await exportSPKI(keys.publicKey);
  const sign = async (
    claims: Record<string, unknown>,
    kid: string | null = 'fixture',
  ) =>
    new CompactSign(Buffer.from(apiJson(claims)))
      .setProtectedHeader({
        alg: 'ES256',
        ...(kid === null ? {} : { kid }),
      })
      .sign(keys.privateKey);
  return { ...keys, pem, sign };
}
const claims = (extra: Record<string, unknown> = {}) => ({
  iat: now(),
  nbf: now(),
  exp: now() + 90,
  iss: 'kasitek-core',
  sub: 'fixture-user',
  jti: randomUUID(),
  aud: 'kasitek-analytics-reporting',
  principal_type: 'user',
  scope_id: 1,
  root_scope_id: 1,
  descendant_mode: 'none',
  policy_version: 'fixture-policy',
  permissions: ['analytics:read'],
  ...extra,
});
test('signed reporting grants enforce key selection, typed claims, exact lifetime/audience and scope boundaries', async () => {
  const keys = await signing();
  const config = readConfig({
    ANALYTICS_DATABASE_URL: 'postgres://fixture/fixture',
    ANALYTICS_REPORTING_PUBLIC_KEY: keys.pem,
    ANALYTICS_REPORTING_PUBLIC_KEYS_JSON: JSON.stringify({ fixture: keys.pem }),
  });
  const access = await ReportingAuthenticator.fromConfig(config);
  const grant = await access.authenticateToken(
    await keys.sign(
      claims({ scope_id: 9007199254740993n, root_scope_id: 9007199254740993n }),
    ),
  );
  assert.equal(grant.scope_id, 9007199254740993n);
  await access.authenticateToken(await keys.sign(claims(), null));
  for (const invalid of [
    { aud: 'wrong' },
    { iss: 'other' },
    { exp: now() + 121 },
    { nbf: now() + 1 },
    { exp: now() },
    { iat: now() - 121, nbf: now() - 121, exp: now() + 1 },
    { permissions: null },
    { nbf: null },
    { scope_id: '1' },
    { principal_type: 'admin' },
    { descendant_mode: 'explicit' },
    { policy_version: '' },
    { aud: ['kasitek-analytics-reporting', 5] },
  ])
    await assert.rejects(
      access.authenticateToken(await keys.sign(claims(invalid))),
    );
  await assert.rejects(
    access.authenticateToken(await keys.sign(claims(), 'unknown')),
  );
  await assert.rejects(
    access.authenticateToken(' ' + (await keys.sign(claims()))),
  );
  const catalog = new ScopeCatalog([
    {
      scope_id: 1n,
      root_scope_id: 1n,
      parent_scope_id: null,
      kind: 'tenant_workspace',
      status: 'active',
    },
    {
      scope_id: 2n,
      root_scope_id: 1n,
      parent_scope_id: 1n,
      kind: 'tenant_client',
      status: 'active',
    },
    {
      scope_id: 3n,
      root_scope_id: 1n,
      parent_scope_id: 1n,
      kind: 'tenant_client',
      status: 'suspended',
    },
    {
      scope_id: 4n,
      root_scope_id: 4n,
      parent_scope_id: null,
      kind: 'core_organization',
      status: 'active',
    },
  ]);
  const explicit: ReportingGrant = {
    ...(await access.authenticateToken(await keys.sign(claims()))),
    descendant_mode: 'explicit',
    explicit_descendant_scope_ids: [2n],
  };
  assert.deepEqual(
    catalog.authorize(
      explicit,
      explicit.audience,
      new Date(),
      2n,
      'analytics:read',
    ).authorized_scope_ids,
    [1n, 2n],
  );
  assert.throws(() =>
    catalog.authorize(
      explicit,
      explicit.audience,
      new Date(),
      1n,
      'analytics:read',
    ),
  );
  assert.throws(() =>
    catalog.authorize(
      explicit,
      explicit.audience,
      new Date(),
      3n,
      'analytics:read',
    ),
  );
  assert.throws(() =>
    catalog.authorize(
      explicit,
      explicit.audience,
      new Date(),
      4n,
      'analytics:read',
    ),
  );
  assert.equal(
    encodeScopeIds([2n, 9007199254740993n, 2n, 1n]),
    '{1,2,9007199254740993}',
  );
  assert.throws(() => encodeScopeIds([]));
  const resolver = new ScopeResolverAuthenticator([
    {
      source_service: 'core',
      token_sha256: createHash('sha256').update('secret').digest('hex'),
    },
  ]);
  assert.equal(
    resolver.authenticate({
      headers: {
        'x-source-service': ' core ',
        authorization: 'Bearer secret ',
      },
    }),
    'core',
  );
  assert.equal(
    resolver.authenticate({
      headers: {
        'x-source-service': 'tenant-platform',
        authorization: 'Bearer secret',
      },
    }),
    null,
  );
});
test('report typed decoder rejects unknown/null defaulted fields and retains i64/fractional timestamps', () => {
  const body = {
    reporting_scope_id: 9007199254740993n,
    range_start: '2026-08-22T10:00:00.000001Z',
    range_end: '2026-08-22T11:00:00Z',
    timezone: 'UTC',
  };
  const decoded = decodeReportRequest(body);
  assert.equal(decoded.reporting_scope_id, 9007199254740993n);
  assert.equal(
    decoded.range_start.toISOString(),
    '2026-08-22T10:00:00.000001Z',
  );
  const leapSecond = decodeReportRequest({
    ...body,
    range_start: '2015-02-18T23:59:60.234567+05:00',
  });
  const sameInstant = decodeReportRequest({
    ...body,
    range_start: '2015-02-18T19:00:00.234567Z',
  });
  assert.equal(leapSecond.range_start.getTime(), sameInstant.range_start.getTime());
  assert.equal(
    leapSecond.range_start.toISOString(),
    '2015-02-18T18:59:60.234567Z',
  );
  assert.equal(
    expectedPoints(decoded.range_start, decoded.range_end, 'hour'),
    1,
  );
  for (const field of [
    'metrics',
    'breakdowns',
    'filters',
    'include_descendants',
  ])
    assert.throws(() => decodeReportRequest({ ...body, [field]: null }));
  assert.throws(() => decodeReportRequest({ ...body, unknown: true }));
  assert.throws(() =>
    decodeReportRequest({
      ...body,
      comparison: { kind: 'previous_period', extra: 1 },
    }),
  );
});
class MemoryCache implements CacheBackend {
  readonly values = new Map<string, string>();
  writes = 0;
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string, _ttl: number) {
    this.values.set(key, value);
    this.writes++;
  }
}
async function addScope(
  pool: import('pg').Pool,
  kind: string,
  external: string,
  parent: bigint | null = null,
) {
  return BigInt(
    (
      await pool.query(
        `INSERT INTO analytics.reporting_scope(scope_kind,owning_source_service,external_source_id,parent_scope_id,status,reporting_timezone) VALUES($1,$2,$3,$4,'active','UTC') RETURNING scope_id`,
        [
          kind,
          kind === 'core_organization' ? 'core' : 'tenant-platform',
          external,
          parent,
        ],
      )
    ).rows[0].scope_id,
  );
}
test(
  'native reporting preserves promoted math/coverage, descendants, persisted grants, cache authorization and private resolution',
  { skip: !enabled },
  async () => {
    const keys = await signing(),
      f = await analyticsFixture({
        ANALYTICS_REPORTING_PUBLIC_KEYS_JSON: JSON.stringify({
          fixture: keys.pem,
        }),
        ANALYTICS_REPORTING_RESOLVER_CREDENTIALS_JSON: JSON.stringify([
          { source_service: 'core', token: 'resolver-fixture' },
        ]),
      });
    const app = Fastify();
    try {
      const registry = await loadRegistry(),
        org = await addScope(f.pool, 'core_organization', 'reporting-org'),
        other = await addScope(f.pool, 'core_organization', 'other-org'),
        workspace = await addScope(f.pool, 'tenant_workspace', 'agency'),
        child = await addScope(f.pool, 'tenant_client', 'client', workspace);
      const metricKeys = [
        'campaign.recipients.sent',
        'campaign.delivery_rate',
        'campaign.delivery_delay_ms',
      ];
      const metrics = metricKeys.map((key) =>
        registry.metrics.find((metric) => metric.key === key)!,
      );
      assert.ok(metrics.every(Boolean));
      const generation = BigInt(
        (
          await f.pool.query(
            `INSERT INTO analytics.analytics_projection_generation(projection_name,projection_version,reporting_scope_id,root_scope_id,shard_key,generation_number,generation_status,metric_registry_sha256,created_by_type,created_by_id) VALUES('typed_domain_facts','1',$1,$1,'default',1,'promoted',$2,'user','fixture') RETURNING generation_id`,
            [org, registry.sha256],
          )
        ).rows[0].generation_id,
      );
      await f.pool.query(
        `INSERT INTO analytics.analytics_projection_checkpoint(projection_name,projection_version,reporting_scope_id,root_scope_id,shard_key,generation_id,processing_status) VALUES('typed_domain_facts','1',$1,$1,'default',$2,'idle')`,
        [org, generation],
      );
      const start = '2026-08-22T10:00:00Z',
        end = '2026-08-22T11:00:00Z';
      for (const metric of metrics) {
        const coverage = JSON.stringify({
          coverage_state: 'observed',
          required_sources: metric.coverage.required_sources,
        });
        if (metric.default_aggregation === 'distinct_count') {
          for (const [i, dedup] of [
            'recipient-a',
            'recipient-a',
            'recipient-b',
          ].entries())
            await f.pool.query(
              `INSERT INTO analytics.analytics_projection_contribution(generation_id,projection_name,projection_version,metric_key,metric_version,source_kind,source_storage_id,target_scope_id,source_scope_id,root_scope_id,bucket_start,bucket_end,source_high_watermark,coverage,deduplication_key) VALUES($1,'typed_domain_facts','1',$2,$3,'event',$4,$5,$5,$5,$6,$7,1,$8,$9)`,
              [
                generation,
                metric.key,
                metric.version,
                i + 1,
                org,
                start,
                end,
                coverage,
                dedup,
              ],
            );
        } else
          await f.pool.query(
            `INSERT INTO analytics.analytics_projection_rollup(generation_id,projection_name,projection_version,metric_key,metric_version,target_scope_id,source_scope_id,root_scope_id,interval,bucket_start,bucket_end,value_count,value_sum,numerator,denominator,source_high_watermark,coverage) VALUES($1,'typed_domain_facts','1',$2,$3,$4,$4,$4,'hour',$5,$6,4,500,3,4,1,$7)`,
            [generation, metric.key, metric.version, org, start, end, coverage],
          );
        await f.pool.query(
          `INSERT INTO analytics.analytics_source_state(producer_id,source_service,source_domain,source_stream_key,reporting_scope_id,root_scope_id,metric_scope,availability_state,latest_source_timestamp) VALUES('core-customer-analytics','core','campaigns',$1,$2,$2,$3,'available',NOW())`,
          [metric.key, org, metric.key],
        );
      }
      await f.pool.query(
        `INSERT INTO analytics.analytics_coverage_checkpoint(producer_id,source_service,source_domain,reporting_scope_id,root_scope_id,coverage_layer,window_start,window_end,included_count,coverage_state,complete_through,observed_at) VALUES('core-customer-analytics','core','campaigns',$1,$1,'temporal',$2,$3,1,'available',$3,NOW())`,
        [org, start, end],
      );
      const memory = new MemoryCache(),
        cache = new ReportingCache(memory);
      const context = {
        pool: f.pool,
        config: f.config,
        registry,
        metrics: new (await import('../src/metrics.js')).ProcessMetrics(),
      };
      await registerReportingRoutes(app, context, { cache });
      registerScopeResolutionRoutes(app, context);
      const signed = claims({
          scope_id: org,
          root_scope_id: org,
          metric_keys: metrics.map(
            (metric) => `${metric.key}@${metric.version}`,
          ),
        }),
        token = await keys.sign(signed),
        headers = { authorization: `Bearer ${token}` };
      const catalog = await app.inject({
        url: `/v1/metrics/catalog?reporting_scope_id=${org}`,
        headers,
      });
      assert.equal(catalog.statusCode, 200, catalog.body);
      assert.equal(catalog.json().metrics.length, 3);
      for (const dimension of catalog.json().dimensions) {
        assert.equal(typeof dimension.type, 'string');
        assert.equal('value_type' in dimension, false);
      }
      const payload = {
        reporting_scope_id: Number(org),
        range_start: start,
        range_end: end,
        timezone: 'UTC',
        metrics: metrics.map((metric) => `${metric.key}@${metric.version}`),
        interval: 'hour',
        comparison: { kind: 'previous_period' },
      };
      const report = await app.inject({
        method: 'POST',
        url: '/v1/reports/query',
        headers,
        payload,
      });
      assert.equal(report.statusCode, 200, report.body);
      const results = report.json().metrics;
      assert.equal(
        results.find((metric: { key: string }) => metric.key === metricKeys[0])
          .series[0].value,
        2,
      );
      assert.equal(
        results.find((metric: { key: string }) => metric.key === metricKeys[1])
          .series[0].value,
        0.75,
      );
      assert.equal(
        results.find((metric: { key: string }) => metric.key === metricKeys[2])
          .series[0].value,
        125,
      );
      for (const metric of results) {
        assert.equal(metric.availability.state, 'available');
        assert.equal(metric.coverage.projection_source_state, 'available');
        assert.equal(metric.coverage.state, 'available');
        assert.equal(metric.coverage.included_points, 1);
        assert.equal(metric.freshness.state, 'fresh');
      }
      assert.equal(report.json().comparison.metrics.length, 3);
      assert.ok(
        report
          .json()
          .comparison.metrics.every(
            (metric: { series: unknown[] }) => metric.series.length === 0,
          ),
      );
      assert.equal(memory.writes, 1);
      const again = await app.inject({
        method: 'POST',
        url: '/v1/reports/query',
        headers,
        payload,
      });
      assert.equal(again.statusCode, 200);
      assert.equal(again.json().generated_at, report.json().generated_at);
      assert.equal(memory.writes, 1);
      assert.equal(
        (
          await app.inject({
            url: `/v1/metrics/catalog?reporting_scope_id=${other}`,
            headers,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/reports/query',
            headers,
            payload: { ...payload, timezone: 'Asia/Tokyo' },
          })
        ).statusCode,
        422,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/reports/query',
            headers,
            payload: { ...payload, metrics: ['unknown@1'] },
          })
        ).statusCode,
        403,
      );
      await f.pool.query(
        `UPDATE analytics.reporting_grant SET revoked_at=NOW() WHERE grant_id=$1`,
        [signed.jti],
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/reports/query',
            headers,
            payload,
          })
        ).statusCode,
        401,
        'cache must not bypass persisted revocation',
      );
      const conflict = await keys.sign({ ...signed, jti: randomUUID() });
      const conflictHeaders = { authorization: `Bearer ${conflict}` };
      assert.equal(
        (
          await app.inject({
            url: `/v1/metrics/catalog?reporting_scope_id=${org}`,
            headers: conflictHeaders,
          })
        ).statusCode,
        200,
      );
      const altered = await keys.sign({
        ...signed,
        jti: parseSerdeValueJson(
          Buffer.from(conflict.split('.')[1]!, 'base64url').toString(),
        )['jti'],
        policy_version: 'changed',
      });
      assert.equal(
        (
          await app.inject({
            url: `/v1/metrics/catalog?reporting_scope_id=${org}`,
            headers: { authorization: `Bearer ${altered}` },
          })
        ).statusCode,
        401,
      );
      const tenant = await keys.sign(
        claims({
          iss: 'kasitek-tenant-platform',
          scope_id: workspace,
          root_scope_id: workspace,
          descendant_mode: 'explicit',
          explicit_descendant_scope_ids: [child],
        }),
      );
      assert.equal(
        (
          await app.inject({
            url: `/v1/metrics/catalog?reporting_scope_id=${child}`,
            headers: { authorization: `Bearer ${tenant}` },
          })
        ).statusCode,
        200,
      );
      const noCompare = await keys.sign(
        claims({
          iss: 'kasitek-tenant-platform',
          scope_id: workspace,
          root_scope_id: workspace,
          descendant_mode: 'all',
        }),
      );
      assert.equal(
        (
          await app.inject({
            url: `/v1/metrics/catalog?reporting_scope_id=${child}`,
            headers: { authorization: `Bearer ${noCompare}` },
          })
        ).statusCode,
        403,
      );
      const fallback = await app.inject({
        method: 'POST',
        url: '/v1/reports/query',
        headers: conflictHeaders,
        payload: { ...payload, reporting_scope_id: Number(other) },
      });
      assert.equal(fallback.statusCode, 403);
      const otherToken = await keys.sign(
        claims({ scope_id: other, root_scope_id: other }),
      );
      const noGeneration = await app.inject({
        method: 'POST',
        url: '/v1/reports/query',
        headers: { authorization: `Bearer ${otherToken}` },
        payload: { ...payload, reporting_scope_id: Number(other) },
      });
      assert.equal(noGeneration.statusCode, 200, noGeneration.body);
      assert.equal(noGeneration.json().generation_id, null);
      assert.ok(
        noGeneration
          .json()
          .metrics.every(
            (metric: { series: unknown[]; warnings: string[] }) =>
              !metric.series.length &&
              metric.warnings.includes(
                'no promoted projection generation is available',
              ),
          ),
      );
      const resolverHeaders = {
        'x-source-service': 'core',
        authorization: 'Bearer resolver-fixture',
      };
      assert.equal(
        (
          await app.inject({
            url: '/internal/reporting/scopes/resolve?scope_kind=core_organization&external_source_id=reporting-org',
            headers: resolverHeaders,
          })
        ).json().scope_id,
        Number(org),
      );
      assert.equal(
        (
          await app.inject({
            url: '/internal/reporting/scopes/resolve?scope_kind=tenant_workspace&external_source_id=agency',
            headers: resolverHeaders,
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            url: '/internal/reporting/scopes/resolve?scope_kind=core_organization&external_source_id=reporting-org',
            headers: {
              ...resolverHeaders,
              'x-source-service': 'tenant-platform',
            },
          })
        ).statusCode,
        401,
      );
      const malformed = await app.inject({
        method: 'POST',
        url: '/v1/reports/query',
        headers,
        payload: { ...payload, extra: true },
      });
      assert.equal(malformed.statusCode, 400);
      await transaction(f.pool, async (tx) => {
        await tx.query(
          'SELECT analytics.set_authorization_context($1::bigint[],$2)',
          [[org], 'fixture'],
        );
        assert.equal(
          (
            await tx.query(
              `SELECT current_setting('analytics.authorized_scope_ids') AS value`,
            )
          ).rows[0].value,
          `{${org}}`,
        );
      });
      const setting = await f.pool.query(
        `SELECT current_setting('analytics.authorized_scope_ids',true) AS value`,
      );
      assert.ok(setting.rows[0].value === null || setting.rows[0].value === '');
    } finally {
      await app.close();
      await f.close();
    }
  },
);
test('report caching preserves source TTL, typed corruption rejection and dependency fallback', async () => {
  const backend = new MemoryCache(),
    cache = new ReportingCache(backend),
    t = new Date('2026-08-22T00:00:00Z');
  const response: ReportResponse = {
    scope_id: 9007199254740993n,
    scope_kind: 'core_organization',
    range_start: t,
    range_end: new Date(+t + 3600000),
    interval: 'hour',
    timezone: 'UTC',
    generated_at: t,
    data_as_of: null,
    generation_id: null,
    projection_version: '1',
    registry_sha256: 'a'.repeat(64),
    metrics: [],
    comparison: null,
  };
  await cache.write('key', response, 30);
  assert.equal((await cache.read('key')).state, 'hit');
  backend.values.set(
    'key',
    apiJson({ cached_at: new Date(Date.now() - 30000), response }),
  );
  assert.equal((await cache.read('key')).state, 'stale');
  backend.values.set(
    'key',
    apiJson({
      cached_at: new Date(),
      response: { ...response, scope_id: 'wrong' },
    }),
  );
  assert.equal((await cache.read('key')).state, 'unavailable');
  const unavailable = new ReportingCache({
    get: async () => {
      throw Error('fixture unavailable');
    },
    set: async () => {
      throw Error('fixture unavailable');
    },
  });
  assert.equal((await unavailable.read('key')).state, 'unavailable');
  await unavailable.write('key', response, 30);
  const keys = await signing(),
    config = readConfig({
      ANALYTICS_DATABASE_URL: 'postgres://fixture/db',
      ANALYTICS_REPORTING_PUBLIC_KEY: keys.pem,
    }),
    access = await ReportingAuthenticator.fromConfig(config),
    grant = await access.authenticateToken(await keys.sign(claims(), null)),
    scope = {
      requested_scope_id: 1n,
      authorized_scope_ids: [1n],
      scope_kind: 'core_organization',
      timezone: 'UTC',
    },
    request = decodeReportRequest({
      reporting_scope_id: 1,
      range_start: '2026-08-22T00:00:00Z',
      range_end: '2026-08-22T01:00:00Z',
      timezone: 'UTC',
    });
  assert.notEqual(
    reportCacheKey(grant, scope, request, null, '1', 'a'),
    reportCacheKey(
      { ...grant, policy_version: 'other' },
      scope,
      request,
      null,
      '1',
      'a',
    ),
  );
  assert.notEqual(
    reportCacheKey(grant, scope, request, null, '1', 'a'),
    reportCacheKey(grant, scope, request, 2n, '1', 'a'),
  );
});
test(
  'transaction-local reporting scope context enforces PostgreSQL RLS under a limited disposable role',
  { skip: !enabled },
  async () => {
    const f = await analyticsFixture(),
      role = `analytics_fixture_read_${randomUUID().replaceAll('-', '')}`;
    let created = false;
    try {
      const own = await addScope(f.pool, 'core_organization', 'rls-own'),
        other = await addScope(f.pool, 'core_organization', 'rls-other');
      await f.pool.query(`CREATE ROLE "${role}" NOLOGIN`);
      created = true;
      await f.pool.query(`GRANT USAGE ON SCHEMA analytics TO "${role}"`);
      await f.pool.query(
        `GRANT SELECT ON analytics.reporting_scope TO "${role}"`,
      );
      await transaction(f.pool, async (tx) => {
        await tx.query(`SET LOCAL ROLE "${role}"`);
        assert.equal(
          (await tx.query('SELECT scope_id FROM analytics.reporting_scope'))
            .rowCount,
          0,
        );
        await tx.query(
          'SELECT analytics.set_authorization_context($1::bigint[],$2)',
          [[own], 'fixture-grant'],
        );
        const visible = (
          await tx.query('SELECT scope_id FROM analytics.reporting_scope')
        ).rows.map((row) => BigInt(row.scope_id));
        assert.deepEqual(visible, [own]);
        assert.ok(!visible.includes(other));
        await tx.query('SELECT analytics.clear_authorization_context()');
        assert.equal(
          (await tx.query('SELECT scope_id FROM analytics.reporting_scope'))
            .rowCount,
          0,
        );
      });
      await transaction(f.pool, async (tx) => {
        await tx.query(`SET LOCAL ROLE "${role}"`);
        assert.equal(
          (await tx.query('SELECT scope_id FROM analytics.reporting_scope'))
            .rowCount,
          0,
        );
      });
    } finally {
      if (created) {
        await f.pool.query(
          `REVOKE ALL ON analytics.reporting_scope FROM "${role}"`,
        );
        await f.pool.query(`REVOKE ALL ON SCHEMA analytics FROM "${role}"`);
        await f.pool.query(`DROP ROLE "${role}"`);
      }
      await f.close();
    }
  },
);
