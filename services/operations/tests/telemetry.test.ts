import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const database = process.env.OPERATIONS_TEST_DATABASE_URL;
test(
  "Operations exports bounded metrics through existing OTLP SDK",
  { skip: !database, timeout: 15000 },
  async () => {
    const bodies: Buffer[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        bodies.push(Buffer.concat(chunks));
        res.setHeader("content-type", "application/json");
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const script = `const {initTelemetry}=await import('@kasitek-labs/server-support/telemetry');
 const sdk=initTelemetry('kasitek-operations-test');
 const [{createPool},{loadConfig},{startMetrics,recordCollection}]=await Promise.all([import('./src/db.ts'),import('./src/config.ts'),import('./src/telemetry.ts')]);
 const pool=createPool(process.env.OPERATIONS_TEST_DATABASE_URL),config=loadConfig({...process.env,DATABASE_URL:process.env.OPERATIONS_TEST_DATABASE_URL});
 const stop=startMetrics(pool,config);recordCollection('growth','success');
 await new Promise(r=>setTimeout(r,2200));stop();await pool.end();await sdk.shutdown();`;
    try {
      let output = "";
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            fileURLToPath(
              new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
            ),
            "--input-type=module",
            "--eval",
            script,
          ],
          {
            cwd: fileURLToPath(new URL("../", import.meta.url)),
            env: {
              ...process.env,
              DATABASE_URL: database,
              ENVIRONMENT: "test",
              OPS_ENVIRONMENT: "test",
              OPS_SOURCES_JSON: "[]",
              OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
              OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
              OTEL_METRICS_EXPORTER: "otlp",
              OTEL_TRACES_EXPORTER: "none",
              OTEL_LOGS_EXPORTER: "none",
              OTEL_METRIC_EXPORT_INTERVAL: "1000",
              OTEL_METRIC_EXPORT_TIMEOUT: "1000",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          output += String(chunk);
        });
        child.once("error", reject);
        child.once("exit", resolve);
      });
      assert.equal(
        code,
        0,
        output.replace(/postgres(?:ql)?:\/\/\S+/g, "[REDACTED]"),
      );
      assert.ok(bodies.length > 0, "OTLP receiver received real SDK metrics");
      const wire = Buffer.concat(bodies).toString();
      for (const name of [
        "kasitek.operations.collection.count",
        "kasitek.operations.collection.age",
        "kasitek.operations.incidents.active",
        "kasitek.operations.notification.pending",
      ])
        assert.ok(wire.includes(name), `exported ${name}`);
      assert.equal(wire.includes("customerId"), false);
      assert.equal(wire.includes("actorId"), false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
