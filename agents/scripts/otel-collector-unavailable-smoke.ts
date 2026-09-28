import { strict as assert } from "node:assert";
import { createServer } from "node:net";
import type { AppConfig } from "../src/config";

interface UnavailableCollector {
  endpoint: string;
  firstRejectedTrace: Promise<{ path: string; bodyBytes: number }>;
  close(): Promise<void>;
}

async function startUnavailableCollector(): Promise<UnavailableCollector> {
  let resolveFirstTrace!: (request: { path: string; bodyBytes: number }) => void;
  const firstRejectedTrace = new Promise<{ path: string; bodyBytes: number }>((resolve) => { resolveFirstTrace = resolve; });
  const server = createServer((socket) => {
    let request = "";
    let handled = false;
    socket.setTimeout(2_000, () => socket.destroy());
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      if (handled) return;
      request += chunk.toString("latin1");
      const headerEnd = request.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const lines = request.slice(0, headerEnd).split("\r\n");
      const [method, path] = (lines[0] ?? "").split(" ");
      const contentLengthHeader = lines.slice(1).find((line) => /^content-length:/i.test(line));
      const transferEncodingHeader = lines.slice(1).find((line) => /^transfer-encoding:/i.test(line));
      let bodyBytes: number | undefined;
      if (contentLengthHeader) {
        const contentLength = Number(contentLengthHeader.split(":", 2)[1]?.trim());
        if (!Number.isSafeInteger(contentLength) || contentLength < 1) return socket.destroy();
        if (request.length < headerEnd + 4 + contentLength) return;
        bodyBytes = contentLength;
      } else if (transferEncodingHeader?.toLowerCase().includes("chunked")) {
        const chunkStart = headerEnd + 4;
        const chunkSizeEnd = request.indexOf("\r\n", chunkStart);
        if (chunkSizeEnd < 0) return;
        const chunkBytes = Number.parseInt(request.slice(chunkStart, chunkSizeEnd).split(";", 1)[0] ?? "", 16);
        if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) return socket.destroy();
        if (request.length < chunkSizeEnd + 2 + chunkBytes + 2) return;
        bodyBytes = chunkBytes;
      } else {
        return socket.destroy();
      }
      if (method !== "POST" || path !== "/v1/traces" || bodyBytes === undefined) return socket.destroy();
      handled = true;

      const body = "collector unavailable";
      socket.end(
        `HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        () => resolveFirstTrace({ path, bodyBytes }),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start the unavailable Collector fixture");

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    firstRejectedTrace,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function waitForFirstTrace(promise: Promise<{ path: string; bodyBytes: number }>): Promise<{ path: string; bodyBytes: number }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<{ path: string; bodyBytes: number }>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Health request did not produce an OTLP trace export")), 3_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const collector = await startUnavailableCollector();
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
    assert.equal(live.status, 200, "/health/live should succeed while the OTLP endpoint rejects exports");
    assert.deepEqual(await live.json(), { status: "ok", service: "kasitek-agents" });
    const rejectedTrace = await waitForFirstTrace(collector.firstRejectedTrace);
    assert.equal(rejectedTrace.path, "/v1/traces");
    assert.ok(rejectedTrace.bodyBytes > 0, "the rejected OTLP request should include a trace payload");

    const liveAfterFailure = await fetch(`${baseUrl}/health/live`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(liveAfterFailure.status, 200, "/health/live should stay healthy after an OTLP export is rejected");
    assert.deepEqual(await liveAfterFailure.json(), { status: "ok", service: "kasitek-agents" });

    const ready = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(ready.status, 200, "/health/ready should stay healthy after an OTLP export is rejected");
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
    console.log("Agents live and ready health checks passed after a non-empty OTLP trace export was rejected with HTTP 503.");
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
