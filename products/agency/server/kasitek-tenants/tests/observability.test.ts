import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Fastify from "fastify";
import { context, trace } from "@opentelemetry/api";
import { installHttpObservability } from "../src/observability/http.js";

const require = createRequire(
  import.meta.resolve("@kasitek-labs/server-support/telemetry"),
);
const { BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } =
  require("@opentelemetry/sdk-trace-base");
const { AsyncLocalStorageContextManager } = require(
  "@opentelemetry/context-async-hooks",
);

test("tenant HTTP spans preserve safe route, correlation and HTTP status fields", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const manager = new AsyncLocalStorageContextManager().enable();
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(manager);

  const app = Fastify({ logger: false });
  installHttpObservability(app);
  app.get("/fixture/:id", async () => ({ ok: true }));

  try {
    const response = await app.inject({
      url: "/fixture/private-customer-id?token=private-token",
      headers: { "x-correlation-id": "tenant-fixture" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-correlation-id"], "tenant-fixture");
    await provider.forceFlush();

    const request = exporter
      .getFinishedSpans()
      .find((span: any) => span.name === "GET /fixture/{id}");
    assert(request);
    assert.equal(request.attributes["http.flavor"], "1.1");
    assert.equal(request.attributes["http.target"], "/fixture/{id}");
    assert.equal(request.attributes.correlation_id, "tenant-fixture");
    assert.equal(request.attributes["otel.status_code"], "OK");
    assert(!JSON.stringify(request.attributes).includes("private-customer-id"));
    assert(!JSON.stringify(request.attributes).includes("private-token"));
  } finally {
    await app.close();
    await provider.shutdown();
    context.disable();
    trace.disable();
  }
});
