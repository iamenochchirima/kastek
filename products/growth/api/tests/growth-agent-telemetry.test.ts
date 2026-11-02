import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { context, trace, propagation } from "@opentelemetry/api";
import { exportPKCS8, generateKeyPair } from "jose";
import { GrowthAgentClient } from "../src/agents/client.js";
import { withCorrelationId } from "../src/observability/context.js";
import { readConfig } from "../src/config.js";
const require = createRequire(fileURLToPath(import.meta.resolve("@kasitek-labs/server-support/telemetry")));
const { BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } = require("@opentelemetry/sdk-trace-base");
const { AsyncLocalStorageContextManager } = require("@opentelemetry/context-async-hooks");
const { W3CTraceContextPropagator } = require("@opentelemetry/core");
test("Growth's actual agent command fetch carries its provider span and caller correlation", async () => {
  const exporter = new InMemorySpanExporter(), provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const manager = new AsyncLocalStorageContextManager().enable();
  trace.setGlobalTracerProvider(provider); context.setGlobalContextManager(manager); propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  const keys = await generateKeyPair("RS256", { extractable: true });
  const config = readConfig({ DATABASE_URL: "postgres://unused", LOG_LEVEL: "silent", AGENTS_PRODUCT_API_URL: "https://agents.example.test", GROWTH_AGENTS_SIGNING_PRIVATE_KEY: await exportPKCS8(keys.privateKey) });
  let seen: Headers | undefined, physicalSpanId: string | undefined;
  const client = new GrowthAgentClient(config, { fetch: (async (_url, init) => {
    seen = new Headers(init?.headers); physicalSpanId = trace.getActiveSpan()?.spanContext().spanId;
    return Response.json({ tasks: [], nextCursor: null });
  }) as typeof fetch });
  try {
    await withCorrelationId("growth-caller-correlation", () => trace.getTracer("fixture").startActiveSpan("fixture.request", async span => {
      try { await client.command({ tenantId: "PRIVATE-BUSINESS", actor: { issuer: "https://growth.kasitek.co.za/identity", subject: "PRIVATE-USER" } }, "tasks.list", {}, "stable-command-id"); }
      finally { span.end(); }
    }));
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans(), request = spans.find((span: any) => span.name === "fixture.request");
    const dependency = spans.find((span: any) => span.name === "kasitek.provider" && span.attributes["peer.service"] === "kasitek-agents");
    assert(request); assert(dependency); assert.equal(dependency.parentSpanContext.spanId, request.spanContext().spanId);
    assert.equal(physicalSpanId, dependency.spanContext().spanId);
    assert.equal(seen?.get("traceparent")?.split("-")[2], dependency.spanContext().spanId);
    assert.equal(seen?.get("x-correlation-id"), "growth-caller-correlation");
    const attributes = JSON.stringify(spans.map((span: any) => span.attributes));
    for (const privateValue of ["PRIVATE-BUSINESS", "PRIVATE-USER", "Bearer", "stable-command-id"]) assert(!attributes.includes(privateValue));
  } finally {
    await provider.shutdown(); manager.disable(); context.disable(); trace.disable(); propagation.disable();
  }
});
