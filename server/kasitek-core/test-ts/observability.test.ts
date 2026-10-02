import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  context,
  trace,
  propagation,
  metrics,
  SpanStatusCode,
} from "@opentelemetry/api";
import Fastify from "fastify";
import { installHttpObservability } from "../src-ts/observability/http.js";
import {
  providerSpan,
  workerSpan,
} from "../src-ts/observability/operations.js";
import {
  outboundTraceHeaders,
  currentCorrelationId,
} from "../src-ts/observability/context.js";
import { AgentPlatformClient } from "../src-ts/services/agent-platform/client.js";
import { readConfig } from "../src-ts/config.js";
import { installErrorHandler } from "../src-ts/error.js";
const require = createRequire(
  fileURLToPath(import.meta.resolve("@kasitek/server-support/telemetry")),
);
const {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} = require("@opentelemetry/sdk-trace-base");
const {
  AsyncLocalStorageContextManager,
} = require("@opentelemetry/context-async-hooks");
const { W3CTraceContextPropagator } = require("@opentelemetry/core");
const {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
} = require("@opentelemetry/sdk-metrics");
test("HTTP/provider/worker telemetry preserves W3C context, bounded correlation and error privacy with real counters", async () => {
  const exporter = new InMemorySpanExporter(),
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    }),
    manager = new AsyncLocalStorageContextManager().enable(),
    metricExporter = new InMemoryMetricExporter(),
    reader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60000,
    }),
    meter = new MeterProvider({ readers: [reader] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(manager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  metrics.setGlobalMeterProvider(meter);
  const app = Fastify();
  installErrorHandler(app);
  installHttpObservability(app);
  let seen: Record<string, string> = {};
  const config = readConfig({
    DATABASE_URL: "postgresql://fixture",
    AGENTS_API_URL: "http://127.0.0.1:65500",
    AGENTS_INTERNAL_AUTH_SECRET: "secret-fixture",
  });
  app.get("/fixture/:id", async () => {
    assert.equal(currentCorrelationId(), "fixture-correlation");
    await new AgentPlatformClient(config, {
      fetch: async (_url, init) => {
        seen = Object.fromEntries(new Headers(init?.headers));
        return new Response('{"ok":true}', {
          headers: { "content-type": "application/json" },
        });
      },
    }).forwardTelegramWebhook("connection", null, {});
    return { ok: true };
  });
  app.get("/failed", async () => {
    throw new Error("CUSTOMER EMAIL secret@example.test token=super-secret");
  });
  try {
    const incoming = "00-11111111111111111111111111111111-2222222222222222-01";
    const response = await app.inject({
      method: "GET",
      url: "/fixture/PRIVATE-CUSTOMER-ID?token=super-secret",
      headers: {
        "x-correlation-id": " fixture-correlation ",
        traceparent: incoming,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-correlation-id"], "fixture-correlation");
    assert.equal(seen["x-correlation-id"], "fixture-correlation");
    assert.match(seen.traceparent!, /^00-11111111111111111111111111111111-/);
    const failed = await app.inject({
      method: "GET",
      url: "/failed",
      headers: { "x-correlation-id": "bad unsafe value" },
    });
    assert.equal(failed.statusCode, 500);
    assert.match(String(failed.headers["x-correlation-id"]), /^[a-f0-9-]{36}$/);
    const error = new Error("CUSTOMER-DATA password=super-secret");
    await assert.rejects(
      () =>
        workerSpan("fixture.worker", async () => {
          throw error;
        }),
      (actual) => actual === error,
    );
    await assert.rejects(
      () =>
        providerSpan("fixture", "http.request", async () => {
          throw error;
        }),
      (actual) => actual === error,
    );
    await provider.forceFlush();
    await meter.forceFlush();
    const spans = exporter.getFinishedSpans(),
      serialized = JSON.stringify(
        spans.map((span: any) => ({
          name: span.name,
          attributes: span.attributes,
          status: span.status,
        })),
      );
    for (const secret of [
      "PRIVATE-CUSTOMER-ID",
      "super-secret",
      "secret@example.test",
      "CUSTOMER-DATA",
    ])
      assert(!serialized.includes(secret), serialized);
    const request = spans.find(
        (span: any) => span.name === "GET /fixture/{id}",
      ),
      dependency = spans.find(
        (span: any) =>
          span.name === "kasitek.provider" &&
          span.attributes["peer.service"] === "kasitek-agents",
      );
    assert(request);
    assert(dependency);
    assert.equal(
      request.spanContext().traceId,
      "11111111111111111111111111111111",
    );
    assert.equal(
      dependency.parentSpanContext.spanId,
      request.spanContext().spanId,
    );
    const injected = spans.find(
      (span: any) =>
        span.spanContext().spanId === seen.traceparent!.split("-")[2],
    );
    assert.equal(
      injected.parentSpanContext.spanId,
      dependency.spanContext().spanId,
    );
    assert.equal(
      spans.find((span: any) => span.name === "GET /failed").status.code,
      SpanStatusCode.ERROR,
    );
    const metricJson = JSON.stringify(metricExporter.getMetrics());
    for (const name of [
      "http.server.request.count",
      "http.server.request.duration",
      "http.server.request.error.count",
      "http.server.request.in_flight",
      "kasitek.operation.count",
      "kasitek.operation.error.count",
      "kasitek.dependency.failure.count",
    ])
      assert(metricJson.includes(name), name);
  } finally {
    await app.close();
    await provider.shutdown();
    await meter.shutdown();
    context.disable();
    trace.disable();
    metrics.disable();
    propagation.disable();
  }
});
test("Collector outage leaves actual API health available and telemetry shutdown bounded", () => {
  const code = `import {initTelemetry} from '@kasitek/server-support/telemetry';const telemetry=initTelemetry('kasitek-core');const {buildApp}=await import('./src-ts/app.ts');const {readConfig}=await import('./src-ts/config.ts');const app=await buildApp({config:readConfig({DATABASE_URL:'postgresql://fixture',LOG_LEVEL:'silent'}),pool:{}});const response=await app.inject({url:'/health'});if(response.statusCode!==200||response.json().status!=='ok')throw Error('Health failed');await app.close();await telemetry.shutdown();console.log('outage-health-ok');`;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        OTEL_SDK_DISABLED: "false",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        OTEL_METRICS_EXPORTER: "none",
        OTEL_LOGS_EXPORTER: "none",
        OTEL_EXPORTER_OTLP_TIMEOUT: "100",
        OTEL_BSP_EXPORT_TIMEOUT: "100",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /outage-health-ok/);
});
