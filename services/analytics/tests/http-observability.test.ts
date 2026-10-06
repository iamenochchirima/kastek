import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {Pool} from 'pg';
import test from 'node:test';
import type {AnalyticsContext} from '../src/context.js';
import type {RegistrySnapshot} from '../src/registry-types.js';
import {readConfig} from '../src/config.js';
import {ProcessMetrics} from '../src/metrics.js';
import {initTelemetry} from '@kasitek-labs/server-support/telemetry';

test('Analytics HTTP requests export bounded spans and request metrics', async (t) => {
  const payloads = new Map<string, string[]>();
  const collector = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = new URL(request.url ?? '/', 'http://collector').pathname;
      const entries = payloads.get(path) ?? [];
      entries.push(Buffer.concat(chunks).toString('utf8'));
      payloads.set(path, entries);
      response.writeHead(200, {'content-type': 'application/json'}).end('{}');
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      collector.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const address = collector.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const env = {
    OTEL_SDK_DISABLED: 'false',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${endpoint}/v1/traces`,
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${endpoint}/v1/metrics`,
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${endpoint}/v1/logs`,
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_NODE_ENABLED_INSTRUMENTATIONS: 'pino',
  };
  const prior = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const telemetry = initTelemetry('kasitek-analytics-http-fixture');
  const {buildApp} = await import('../src/app.js');
  const context = {
    pool: {} as Pool,
    config: readConfig({ANALYTICS_DATABASE_URL: 'postgres://unused'}),
    registry: {} as RegistrySnapshot,
    metrics: new ProcessMetrics(),
  } satisfies AnalyticsContext;
  const app = await buildApp(context);
  app.get('/fixture/failure', async () => {
    throw new Error('private failure detail');
  });

  try {
    const live = await app.inject({
      method: 'GET',
      url: '/health/live?access_token=private-query-value',
      headers: {
        'x-correlation-id': 'caller-123',
        traceparent:
          '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    });
    assert.equal(live.statusCode, 200);
    assert.equal(live.headers['x-correlation-id'], 'caller-123');

    const failed = await app.inject({
      method: 'GET',
      url: '/fixture/failure?access_token=private-query-value',
    });
    assert.equal(failed.statusCode, 500);
  } finally {
    await app.close();
    await telemetry.shutdown();
  }

  const traceText = (payloads.get('/v1/traces') ?? []).join('\n');
  const metricText = (payloads.get('/v1/metrics') ?? []).join('\n');
  const logText = (payloads.get('/v1/logs') ?? []).join('\n');
  assert.ok(traceText.length > 0, 'HTTP spans reached the local OTLP collector');
  assert.ok(metricText.length > 0, 'HTTP metrics reached the local OTLP collector');
  assert.ok(logText.length > 0, 'HTTP logs reached the local OTLP collector');
  assert.ok(!traceText.includes('private-query-value'));
  assert.ok(!logText.includes('private-query-value'));
  assert.ok(logText.includes('http.request.completed'));
  assert.ok(logText.includes('caller-123'));

  const tracePayload = JSON.parse(traceText) as {
    resourceSpans?: {scopeSpans?: {spans?: {
      name?: string;
      traceId?: string;
      parentSpanId?: string;
      attributes?: {key: string; value: Record<string, string | number>}[];
      status?: {code?: number};
    }[]}[]}[];
  };
  const spans = (tracePayload.resourceSpans ?? []).flatMap((resource) =>
    (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
  );
  const healthSpan = spans.find((span) =>
    span.attributes?.some(
      (attribute) =>
        attribute.key === 'http.route' &&
        attribute.value.stringValue === '/health/live',
    ),
  );
  assert.ok(healthSpan, 'health route span is exported');
  assert.equal(healthSpan.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(healthSpan.parentSpanId, '00f067aa0ba902b7');
  assert.equal(
    healthSpan.attributes?.find((attribute) => attribute.key === 'http.target')
      ?.value.stringValue,
    '/health/live',
  );
  assert.ok(
    healthSpan.attributes?.some(
      (attribute) =>
        attribute.key === 'correlation_id' &&
        attribute.value.stringValue === 'caller-123',
    ),
  );
  const failedSpan = spans.find((span) =>
    span.attributes?.some(
      (attribute) =>
        attribute.key === 'http.route' &&
        attribute.value.stringValue === '/fixture/failure',
    ),
  );
  assert.ok(failedSpan, 'failed route span is exported');
  assert.equal(failedSpan.status?.code, 2, 'server failure marks the span as error');
  assert.ok(
    failedSpan.attributes?.some(
      (attribute) =>
        attribute.key === 'otel.status_code' &&
        attribute.value.stringValue === 'ERROR',
    ),
  );
  assert.equal(
    String(
      failedSpan.attributes?.find(
        (attribute) => attribute.key === 'http.response.status_code',
      )?.value.intValue,
    ),
    '500',
  );

  const metricPayload = JSON.parse(metricText) as {
    resourceMetrics?: {scopeMetrics?: {metrics?: {
      name?: string;
      sum?: {dataPoints?: {asInt?: string | number; asDouble?: number}[]};
    }[]}[]}[];
  };
  const metrics = (metricPayload.resourceMetrics ?? []).flatMap((resource) =>
    (resource.scopeMetrics ?? []).flatMap((scope) =>
      scope.metrics ?? [],
    ),
  );
  const names = metrics.map((metric) => metric.name);
  assert.ok(names.includes('http.server.request.count'));
  assert.ok(names.includes('http.server.request.duration'));
  assert.ok(names.includes('http.server.request.error.count'));
  assert.ok(names.includes('http.server.request.in_flight'));
  const errorCount = metrics.find(
    (metric) => metric.name === 'http.server.request.error.count',
  );
  assert.ok(
    Number(
      errorCount?.sum?.dataPoints?.[0]?.asInt ??
        errorCount?.sum?.dataPoints?.[0]?.asDouble,
    ) >= 1,
    `server failure increments the HTTP error counter: ${JSON.stringify(errorCount)}`,
  );
});
