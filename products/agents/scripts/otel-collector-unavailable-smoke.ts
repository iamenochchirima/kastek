import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { diag, DiagLogLevel, type DiagLogger } from "@opentelemetry/api";
import type { AppConfig } from "../src/config";

type Scenario = "http-503" | "connection-refused";

interface UnavailableCollector {
  endpoint: string;
  firstRejectedTrace?: Promise<{ path: string; bodyBytes: number }>;
  close(): Promise<void>;
}

async function listen(server: ReturnType<typeof createTcpServer> | ReturnType<typeof createHttpServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind the local Collector fixture");
  return address.port;
}

async function close(server: ReturnType<typeof createTcpServer> | ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function startUnavailableCollector(scenario: Scenario): Promise<UnavailableCollector> {
  if (scenario === "connection-refused") {
    const server = createTcpServer();
    const port = await listen(server);
    await close(server);
    return {
      endpoint: `http://127.0.0.1:${port}`,
      close: async () => undefined,
    };
  }

  let resolveFirstTrace!: (request: { path: string; bodyBytes: number }) => void;
  let rejectFirstTrace!: (error: Error) => void;
  const firstRejectedTrace = new Promise<{ path: string; bodyBytes: number }>((resolve, reject) => {
    resolveFirstTrace = resolve;
    rejectFirstTrace = reject;
  });
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("error", (error) => rejectFirstTrace(error));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/traces") {
        rejectFirstTrace(new Error(`Unexpected Collector request: ${request.method ?? "?"} ${request.url ?? "?"}`));
        response.writeHead(404).end();
        return;
      }
      const bodyBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      if (bodyBytes < 1) {
        rejectFirstTrace(new Error("OTLP trace export had an empty request body"));
        response.writeHead(400).end();
        return;
      }
      response.writeHead(503, { connection: "close" }).end("collector unavailable", () => {
        resolveFirstTrace({ path: request.url ?? "", bodyBytes });
      });
    });
  });
  const port = await listen(server);
  return {
    endpoint: `http://127.0.0.1:${port}`,
    firstRejectedTrace,
    close: () => close(server),
  };
}

function waitFor<T>(promise: Promise<T>, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage)), 3_000);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function waitForConnectionRefused(errors: string[]): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = Date.now() + 3_000;
  try {
    while (Date.now() < deadline) {
      if (errors.some((error) => error.includes("ECONNREFUSED"))) return;
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 25);
      });
      if (timer) clearTimeout(timer);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  throw new Error("OTLP export did not report the expected ECONNREFUSED failure");
}

async function main(): Promise<void> {
  const scenario = process.argv[2] ?? "http-503";
  assert.ok(scenario === "http-503" || scenario === "connection-refused", `Unknown scenario: ${scenario}`);
  const collector = await startUnavailableCollector(scenario);
  const diagnosticErrors: string[] = [];
  const collectError: DiagLogger["error"] = (message, ...args) => {
    diagnosticErrors.push([message, ...args].map((value) => String(value)).join(" "));
  };
  const diagLogger: DiagLogger = {
    error: collectError,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
  };
  diag.setLogger(diagLogger, DiagLogLevel.ERROR);

  let closeApp: (() => Promise<void>) | undefined;
  let closeTelemetry: (() => Promise<void>) | undefined;
  let healthChecksPassed = false;

  try {
    process.env.OTEL_SDK_DISABLED = "false";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.endpoint;
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `${collector.endpoint}/v1/traces`;
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = `${collector.endpoint}/v1/metrics`;
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `${collector.endpoint}/v1/logs`;
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT = "1000";
    process.env.OTEL_BSP_SCHEDULE_DELAY = "100";
    process.env.OTEL_SERVICE_NAME = "kasitek-agents-collector-unavailable-smoke";
    process.env.OTEL_DEPLOYMENT_ENVIRONMENT = "ci";

    const { shutdownTelemetry } = await import("../src/telemetry");
    closeTelemetry = shutdownTelemetry;
    const { buildApp } = await import("../src/http/app");

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
    closeApp = () => app.close();

    await app.listen({ host: config.HOST, port: config.PORT });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Agents API did not bind a TCP listener");

    const baseUrl = `http://127.0.0.1:${address.port}`;
    const live = await fetch(`${baseUrl}/health/live`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(live.status, 200, "/health/live should succeed while the Collector is unavailable");
    assert.deepEqual(await live.json(), { status: "ok", service: "kasitek-agents" });

    if (scenario === "http-503") {
      const rejectedTrace = await waitFor(
        collector.firstRejectedTrace!,
        "Health request did not produce an OTLP trace export rejected with HTTP 503",
      );
      assert.equal(rejectedTrace.path, "/v1/traces");
      assert.ok(rejectedTrace.bodyBytes > 0, "the rejected OTLP request should include a trace payload");
    } else {
      await waitForConnectionRefused(diagnosticErrors);
    }

    const liveAfterFailure = await fetch(`${baseUrl}/health/live`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(liveAfterFailure.status, 200, "/health/live should stay healthy after an OTLP export failure");
    assert.deepEqual(await liveAfterFailure.json(), { status: "ok", service: "kasitek-agents" });

    const ready = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(ready.status, 200, "/health/ready should stay healthy after an OTLP export failure");
    assert.deepEqual(await ready.json(), { status: "ready", temporalEnabled: false });
    healthChecksPassed = true;
  } finally {
    try {
      await closeApp?.();
    } finally {
      try {
        await closeTelemetry?.();
      } finally {
        await collector.close();
      }
    }
  }

  if (healthChecksPassed) {
    console.log(`Agents live and ready health checks passed after Collector scenario: ${scenario}.`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
