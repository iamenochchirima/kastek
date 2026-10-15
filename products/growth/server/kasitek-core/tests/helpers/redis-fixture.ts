import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "redis";
/** An owned, loopback-only native server with persistence disabled. Never points at shared Redis. */
export async function nativeRedisFixture() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const child = spawn(
    process.env.CORE_REDIS_TEST_BINARY ??
      (() => {
        throw Error("CORE_REDIS_TEST_BINARY is required");
      })(),
    [
      "--bind",
      "127.0.0.1",
      "--port",
      String(port),
      "--save",
      "",
      "--appendonly",
      "no",
      "--protected-mode",
      "yes",
      "--requirepass",
      "fixture-password",
      "--loglevel",
      "warning",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let diagnostics = "";
  child.stderr.on("data", (chunk) => (diagnostics += chunk));
  const url = `redis://:fixture-password@127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const client = createClient({ url, socket: { reconnectStrategy: false } });
    client.on("error", () => {});
    try {
      await client.connect();
      await client.ping();
      ready = true;
      break;
    } catch {
      await delay(20);
    } finally {
      if (client.isOpen) client.destroy();
    }
  }
  if (!ready) {
    child.kill("SIGTERM");
    throw Error(`Portable Redis did not start: ${diagnostics}`);
  }
  const inspector = createClient({ url, socket: { reconnectStrategy: false } });
  inspector.on("error", () => {});
  await inspector.connect();
  return {
    url,
    inspector,
    async close() {
      if (inspector.isOpen) inspector.destroy();
      if (child.exitCode === null) {
        const closed = once(child, "exit");
        child.kill("SIGTERM");
        await closed;
      }
    },
  };
}
