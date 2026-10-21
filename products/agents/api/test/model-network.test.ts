import { createServer, type RequestListener } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createModelFetch, type ModelNetworkPolicy } from "../src/infrastructure/model-network";

const closes: Array<() => Promise<void>> = [];
async function fixture(handler: RequestListener, hostname = "127.0.0.1") {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, hostname, resolve));
  closes.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://${hostname}:${(server.address() as { port: number }).port}/model`;
  const policy: ModelNetworkPolicy = { authorizeUrl: target => target.href === url, maxRequestBytes: 100_000,
    maxResponseBytes: 100_000, deadlineAt: Date.now() + 2000, testLoopback: true };
  return { url, policy };
}
afterEach(async () => { for (const close of closes.splice(0)) await close(); });

describe("model streaming network", () => {
  it("delivers the first SSE bytes before the provider ends the response", async () => {
    let finish: (() => void) | undefined;
    const { url, policy } = await fixture((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: first\n\n"); finish = () => res.end("data: final\n\n");
    });
    const response = await createModelFetch(policy)(url, { method: "POST", body: "{}" });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    finish!();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: final\n\n");
    expect((await reader.read()).done).toBe(true);
  });

  it("retains caller-supplied byte budgets above the connected-read limit", async () => {
    const { url, policy } = await fixture((req, res) => { let bytes = 0; req.on("data", chunk => { bytes += chunk.length; }); req.on("end", () => res.end(String(bytes))); });
    const response = await createModelFetch(policy)(url, { method: "POST", body: "a".repeat(40_000) });
    expect(await response.text()).toBe("40000");
  });

  it("uses only trusted authentication headers and identity encoding", async () => {
    let received: Record<string, unknown> = {};
    const { url, policy } = await fixture((req, res) => { received = req.headers; res.end("ok"); });
    const response = await createModelFetch({ ...policy, headers: { authorization: "Bearer trusted", "x-api-key": "trusted-key" } })(url,
      { headers: { authorization: "Bearer caller", "x-api-key": "caller-key", cookie: "ambient", "accept-encoding": "gzip", "content-type": "application/json" } });
    await response.text();
    expect(received).toMatchObject({ authorization: "Bearer trusted", "x-api-key": "trusted-key", "accept-encoding": "identity", "content-type": "application/json" });
    expect(received.cookie).toBeUndefined();
  });

  it("reauthorizes after DNS and before sending any provider request", async () => {
    let calls = 0;
    const { url, policy } = await fixture((_req, res) => { calls++; res.end("unexpected"); });
    await expect(createModelFetch({ ...policy, beforeDispatch: () => { throw new Error("revoked secret details"); } })(url))
      .rejects.toMatchObject({ code: "AUTHORIZATION_DENIED", dispatched: false });
    expect(calls).toBe(0);
  });

  it("resolves the fixture hostname and performs authorization before using the pinned address", async () => {
    let calls = 0, authorized = false;
    const { url, policy } = await fixture((_req, res) => { calls++; expect(authorized).toBe(true); res.end("ok"); }, "localhost");
    const response = await createModelFetch({ ...policy, beforeDispatch: () => { expect(calls).toBe(0); authorized = true; } })(url);
    expect(await response.text()).toBe("ok"); expect(calls).toBe(1);
  });

  it("rejects redirects after one physical request and never forwards credentials", async () => {
    let calls = 0;
    const { url, policy } = await fixture((_req, res) => { calls++; res.writeHead(307, { location: "/another" }); res.end(); });
    await expect(createModelFetch(policy)(url)).rejects.toMatchObject({ code: "DESTINATION_DENIED", dispatched: true });
    expect(calls).toBe(1);
  });

  it("returns provider status without retries, and forbids reuse for a hidden retry", async () => {
    let calls = 0;
    const { url, policy } = await fixture((_req, res) => { calls++; res.writeHead(429); res.end("quota"); });
    const fetch = createModelFetch(policy);
    const response = await fetch(url);
    expect(response.status).toBe(429); expect(await response.text()).toBe("quota");
    await expect(fetch(url)).rejects.toMatchObject({ code: "REQUEST_LIMIT", dispatched: false });
    expect(calls).toBe(1);
  });

  it("rejects private addresses without an explicit fixture profile", async () => {
    const policy = { authorizeUrl: () => true, maxRequestBytes: 10, maxResponseBytes: 10, deadlineAt: Date.now() + 1000 };
    await expect(createModelFetch(policy)("https://127.0.0.1/model")).rejects.toMatchObject({ code: "PRIVATE_ADDRESS_DENIED", dispatched: false });
    await expect(createModelFetch(policy)("http://127.0.0.1/model")).rejects.toMatchObject({ code: "DESTINATION_DENIED", dispatched: false });
  });

  it("rejects an oversized declared body and compressed encoding", async () => {
    for (const [headers, code] of [[{ "content-length": "1001" }, "RESPONSE_LIMIT"], [{ "content-encoding": "gzip" }, "ENCODING_DENIED"]] as const) {
      const { url, policy } = await fixture((_req, res) => { res.writeHead(200, headers); res.end("abc"); });
      await expect(createModelFetch({ ...policy, maxResponseBytes: 1000 })(url)).rejects.toMatchObject({ code, dispatched: true });
    }
  });

  it("enforces response bytes during streaming instead of buffering the body", async () => {
    let finish: (() => void) | undefined;
    const { url, policy } = await fixture((_req, res) => { res.write("first"); finish = () => res.end("toolarge"); });
    const response = await createModelFetch({ ...policy, maxResponseBytes: 6 })(url);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    finish!();
    await expect(reader.read()).rejects.toMatchObject({ code: "RESPONSE_LIMIT", dispatched: true });
  });

  it("aborts both before dispatch and while consuming the stream", async () => {
    const abort = new AbortController();
    let calls = 0;
    const { url, policy } = await fixture((_req, res) => { calls++; res.write("first"); });
    const response = await createModelFetch(policy)(url, { signal: abort.signal });
    const reader = response.body!.getReader(); await reader.read();
    abort.abort();
    await expect(reader.read()).rejects.toMatchObject({ code: "CANCELLED", dispatched: true });
    await expect(createModelFetch({ ...policy, signal: abort.signal })(url)).rejects.toMatchObject({ code: "CANCELLED", dispatched: false });
    expect(calls).toBe(1);
  });

  it("keeps heartbeat bytes separate from semantic progress", async () => {
    const { url, policy } = await fixture((_req, res) => {
      const timer = setInterval(() => res.write(": heartbeat\n\n"), 5);
      res.on("close", () => clearInterval(timer));
    });
    const response = await createModelFetch({ ...policy, idleTimeoutMs: 100, progressTimeoutMs: 35 })(url);
    await expect(response.text()).rejects.toMatchObject({ code: "PROGRESS_TIMEOUT", dispatched: true });
  });

  it("honors semantic progress notifications until the explicit deadline", async () => {
    const { url, policy } = await fixture((_req, res) => {
      const timer = setInterval(() => res.write("data: progress\n\n"), 5);
      res.on("close", () => clearInterval(timer));
    });
    const fetch = createModelFetch({ ...policy, progressTimeoutMs: 40, deadlineAt: Date.now() + 90 });
    const response = await fetch(url);
    const reader = response.body!.getReader();
    await expect((async () => { for (;;) { const chunk = await reader.read(); if (chunk.done) break; fetch.markProgress(); } })())
      .rejects.toMatchObject({ code: "DEADLINE", dispatched: true });
  });

  it("enforces transport idle timeout independently", async () => {
    const { url, policy } = await fixture((_req, res) => { res.write("first"); });
    const response = await createModelFetch({ ...policy, idleTimeoutMs: 30 })(url);
    await expect(response.text()).rejects.toMatchObject({ code: "IDLE_TIMEOUT", dispatched: true });
  });

  it("applies the explicit connection clock to pre-dispatch readiness", async () => {
    let calls = 0;
    const { url, policy } = await fixture((_req, res) => { calls++; res.end("unexpected"); });
    await expect(createModelFetch({ ...policy, connectTimeoutMs: 20, beforeDispatch: () => new Promise<void>(() => {}) })(url))
      .rejects.toMatchObject({ code: "CONNECT_TIMEOUT", dispatched: false });
    expect(calls).toBe(0);
  });

  it("rejects expired deadlines, oversized request bytes and changed URL authority before dispatch", async () => {
    let calls = 0, allowed = true;
    const { url, policy } = await fixture((_req, res) => { calls++; res.end("unexpected"); });
    await expect(createModelFetch({ ...policy, deadlineAt: Date.now() - 1 })(url)).rejects.toMatchObject({ code: "DEADLINE", dispatched: false });
    await expect(createModelFetch({ ...policy, maxRequestBytes: 1 })(url, { body: "ab" })).rejects.toMatchObject({ code: "REQUEST_LIMIT", dispatched: false });
    await expect(createModelFetch({ ...policy, authorizeUrl: () => allowed, beforeDispatch: () => { allowed = false; } })(url))
      .rejects.toMatchObject({ code: "DESTINATION_DENIED", dispatched: false });
    expect(calls).toBe(0);
  });
});
