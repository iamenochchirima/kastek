import { strict as assert } from "node:assert";
import { createServer } from "node:net";
import type { AppConfig } from "../src/config";

async function reserveClosedLoopbackEndpoint(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a loopback port for the unavailable Collector test");

  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });

  return `http://127.0.0.1:${address.port}`;
}

async function main(): Promise<void> {
  const endpoint = await reserveClosedLoopbackEndpoint();
  process.env.OTEL_SDK_DISABLED = "false";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = endpoint;
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = endpoint;
  process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = endpoint;
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
  process.env.OTEL_SERVICE_NAME = "kasitek-agents-collector-unavailable-smoke";
  process.env.OTEL_DEPLOYMENT_ENVIRONMENT = "ci";

  const [{ buildApp }, { shutdownTelemetry }] = await Promise.all([
    import("../src/http/app"),
    import("../src/telemetry"),
  ]);

  const config = {
    NODE_ENV: "test",
    PORT: 0,
    HOST: "127.0.0.1",
    AGENTS_DATABASE_URL: "postgres://unused",
    AGENTS_DATABASE_POOL_MAX: 1,
    TEMPORAL_ENABLED: false,
    TEMPORAL_ADDRESS: "127.0.0.1:7233",
    TEMPORAL_NAMESPACE: "default",
    TEMPORAL_TASK_QUEUE: "collector-unavailable-smoke",
    INTERNAL_AUTH_AUDIENCE: "collector-unavailable-smoke",
    AUTH_MODE: "headers",
    LOG_LEVEL: "silent",
  } as AppConfig;
  const pool = { query: async () => ({ rows: [{ ok: 1 }] }) } as never;
  const eventNotifications = { subscribe: async () => () => undefined, close: async () => undefined };
  const app = buildApp({ config, pool, eventNotifications });

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Agents API did not bind a TCP listener");

    const baseUrl = `http://127.0.0.1:${address.port}`;
    const live = await fetch(`${baseUrl}/health/live`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(live.status, 200, "/health/live should succeed when the Collector is unavailable");
    assert.deepEqual(await live.json(), { status: "ok", service: "kasitek-agents" });

    const ready = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(ready.status, 200, "/health/ready should succeed when the Collector is unavailable");
    assert.deepEqual(await ready.json(), { status: "ready", temporalEnabled: false });

    console.log("Agents API live and ready health checks passed with OTLP configured to an unavailable Collector.");
  } finally {
    await app.close();
    await shutdownTelemetry();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
