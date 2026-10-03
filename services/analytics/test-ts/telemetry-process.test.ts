import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

test("API remains live and shuts down when the configured Collector is unavailable", async () => {
  const apiPort = await freePort();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src-ts/api-main.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ANALYTICS_API_HOST: "127.0.0.1",
        ANALYTICS_API_PORT: String(apiPort),
        ANALYTICS_DATABASE_URL:
          "postgres://invalid:invalid@127.0.0.1:1/analytics",
        ANALYTICS_DATABASE_ACQUIRE_TIMEOUT_MS: "200",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        OTEL_SDK_DISABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (value: string) => {
    stderr += value;
  });
  const exit = once(child, "exit");

  try {
    let live: Response | undefined;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error(`API exited before liveness: ${stderr}`);
      try {
        live = await fetch(`http://127.0.0.1:${apiPort}/health/live`, {
          signal: AbortSignal.timeout(700),
        });
        if (live.status === 200) break;
      } catch {
        await delay(100);
      }
    }
    assert.equal(live?.status, 200, `API liveness failed: ${stderr}`);

    const ready = await fetch(`http://127.0.0.1:${apiPort}/health/ready`, {
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(ready.status, 503);
    child.kill("SIGTERM");
    let timeout: NodeJS.Timeout | undefined;
    let code: number | null;
    try {
      [code] = await Promise.race([
        exit,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`API did not shut down: ${stderr}`));
          }, 6_000);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    assert.equal(code, 0, `API exited with code ${code}: ${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
