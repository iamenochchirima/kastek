import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { Writable } from "node:stream";
import test from "node:test";
import {
  initTelemetry,
  redactTelemetryLogArguments,
} from "@kasitek-labs/server-support/telemetry";

test("redacted Pino logs reach the configured OpenTelemetry logs exporter", async (t) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push(body);
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.OTEL_SDK_DISABLED = "false";
  process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT =
    `http://127.0.0.1:${address.port}/v1/logs`;
  process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http/json";
  process.env.OTEL_LOGS_EXPORTER = "otlp";
  process.env.OTEL_METRICS_EXPORTER = "none";
  process.env.OTEL_TRACES_EXPORTER = "none";
  process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = "pino";

  const telemetry = initTelemetry("kasitek-analytics-log-fixture");
  const require = createRequire(import.meta.resolve("fastify"));
  const pino = require("pino");
  let stdout = "";
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      stdout += chunk;
      callback();
    },
  });
  const logger = pino(
    {
      level: "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
      ],
      hooks: {
        logMethod(
          this: unknown,
          args: unknown[],
          method: (...args: unknown[]) => unknown,
        ) {
          return method.apply(this, redactTelemetryLogArguments(args));
        },
      },
    },
    destination,
  );

  try {
    logger.info(
      {
        event: "auth.callback.failed",
        errorCode: "invalid_grant",
        access_token: "nested-secret",
      },
      "Provider sent Bearer inline-secret ?code=query-secret",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    await telemetry.shutdown();
  }

  const exported = requests.join("\n");
  assert.ok(exported.length > 0, "Pino log reached the OTLP logs endpoint");
  for (const secret of ["nested-secret", "inline-secret", "query-secret"]) {
    assert.ok(!stdout.includes(secret), `${secret} was redacted from stdout`);
    assert.ok(!exported.includes(secret), `${secret} was redacted from OTLP logs`);
  }
  for (const safe of ["auth.callback.failed", "invalid_grant"]) {
    assert.ok(stdout.includes(safe), `${safe} remains in stdout`);
    assert.ok(exported.includes(safe), `${safe} remains in OTLP logs`);
  }
});
