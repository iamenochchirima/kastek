import { describe, expect, it, vi } from "vitest";
import { buildGateway } from "../src/gateway/app";
import { request as httpRequest } from "node:http";

describe("agent gateway", () => {
  it("is stateless and forwards MCP requests without touching storage", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "content-type": "application/json" } }));
    const app = buildGateway({ agentPlatformUrl: "http://agent-platform:4100", sharedSecret: "secret" });
    const health = await app.inject({ method: "GET", url: "/health" });
    const metadata = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" });
    const response = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: "Bearer token", "x-organization-id": "org", "x-actor-id": "spoofed", "x-correlation-id": "spoofed" }, payload: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    expect(health.json()).toEqual({ status: "ok", service: "agent-gateway" });
    expect(metadata.json()).toMatchObject({ resource: "/mcp" });
    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("http://agent-platform:4100/mcp", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer token", "x-agent-gateway-secret": "secret" }),
    }));
    const forwarded = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(forwarded.headers).not.toHaveProperty("x-organization-id");
    expect(forwarded.headers).not.toHaveProperty("x-actor-id");
    expect(forwarded.headers).toMatchObject({ "x-correlation-id": "spoofed" });
    await app.close();
    fetchMock.mockRestore();
  });

  it("refuses production startup without gateway-to-api authentication", () => {
    expect(() => buildGateway({ agentPlatformUrl: "http://agent-platform:4100", environment: "production" })).toThrow("AGENT_GATEWAY_SHARED_SECRET");
  });

  it("enforces the global transport switch and rejects unsupported protocol versions", async () => {
    const disabled = buildGateway({ agentPlatformUrl: "http://agent-platform:4100", enabled: false });
    const disabledResponse = await disabled.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    expect(disabledResponse.statusCode).toBe(503);
    expect(disabledResponse.json()).toMatchObject({ error: { code: -32030, message: "mcp_gateway_disabled" } });
    await disabled.close();

    const incompatible = buildGateway({ agentPlatformUrl: "http://agent-platform:4100", rateLimitPerWindow: 20, preAuthRateLimitPerWindow: 20 });
    const incompatibleResponse = await incompatible.inject({ method: "POST", url: "/mcp", headers: { "mcp-protocol-version": "2099-01-01" }, payload: { jsonrpc: "2.0", id: 2, method: "initialize" } });
    expect(incompatibleResponse.statusCode).toBe(400);
    expect(incompatibleResponse.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(incompatibleResponse.json()).toMatchObject({ error: { code: -32602, message: "unsupported_mcp_protocol_version" } });
    await incompatible.close();
  });

  it("forwards protocol notifications without manufacturing a JSON-RPC response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 204,
      headers: { "mcp-protocol-version": "2025-06-18" },
    }));
    const app = buildGateway({ agentPlatformUrl: "http://agent-platform:4100" });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "mcp-protocol-version": "2025-06-18" },
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(fetchMock).toHaveBeenCalledWith("http://agent-platform:4100/mcp", expect.objectContaining({
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }));
    await app.close();
    fetchMock.mockRestore();
  });

  it("rate limits unauthenticated traffic before contacting the Agent API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "content-type": "application/json" } }));
    const app = buildGateway({ agentPlatformUrl: "http://agent-platform:4100", preAuthRateLimitPerWindow: 1, rateLimitPerWindow: 10, rateLimitWindowMs: 60_000 });
    const first = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    const second = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 2, method: "initialize" } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
    expect(second.json()).toMatchObject({ error: { code: -32029, message: "rate_limited" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await app.close();
    fetchMock.mockRestore();
  });

  it("returns a structured JSON-RPC error for oversized requests", async () => {
    const app = buildGateway({ agentPlatformUrl: "http://agent-platform:4100" });
    const response = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 3, method: "initialize", params: { padding: "x".repeat(300_000) } } });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32011, message: "mcp_request_too_large" } });
    await app.close();
  });

  it("maps upstream timeout and failure to bounded structured errors", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response("unreachable", { status: 503 })), 30);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("timed out", "AbortError")); }, { once: true });
    }));
    const app = buildGateway({ agentPlatformUrl: "http://agent-platform:4100", upstreamTimeoutMs: 5 });
    const timedOut = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 4, method: "initialize" } });
    expect(timedOut.statusCode).toBe(502);
    expect(timedOut.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "agent_platform_unavailable" } });
    fetchMock.mockImplementationOnce(async () => new Response("bad gateway", { status: 503 }));
    const failed = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 5, method: "initialize" } });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "agent_platform_unavailable" } });
    await app.close();
    fetchMock.mockRestore();
  });

  it("preserves a scoped kill-switch error returned by the Agent Platform", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 6, error: { code: -32030, message: "mcp_kill_switch_active" } }), { status: 200, headers: { "content-type": "application/json" } }));
    const app = buildGateway({ agentPlatformUrl: "http://agent-platform:4100" });
    const response = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 6, method: "tools/list" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ error: { code: -32030, message: "mcp_kill_switch_active" } });
    await app.close();
    fetchMock.mockRestore();
  });

  it("aborts the upstream request when an MCP client disconnects", async () => {
    let aborted = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("client disconnected", "AbortError")); }, { once: true });
    }));
    const app = buildGateway({ agentPlatformUrl: "http://agent-platform:4100", upstreamTimeoutMs: 2_000 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("gateway did not bind an address");
    await new Promise<void>((resolve) => {
      const client = httpRequest({ host: "127.0.0.1", port: address.port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength('{"jsonrpc":"2.0","id":7,"method":"initialize"}') } });
      client.once("error", () => resolve());
      client.end('{"jsonrpc":"2.0","id":7,"method":"initialize"}');
      setTimeout(() => { client.destroy(); resolve(); }, 30);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(aborted).toBe(true);
    await app.close();
    fetchMock.mockRestore();
  });

  it("makes unsupported stream and session lifecycle explicit", async () => {
    const app = buildGateway({ agentPlatformUrl: "http://agent-platform:4100" });
    const stream = await app.inject({ method: "GET", url: "/mcp" });
    const session = await app.inject({ method: "DELETE", url: "/mcp" });
    expect(stream.statusCode).toBe(405);
    expect(stream.headers.allow).toBe("POST");
    expect(session.statusCode).toBe(405);
    expect(session.headers.allow).toBe("POST");
    await app.close();
  });

  it("exposes readiness and redacted operational metrics with correlation ids", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/health/ready")) return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "content-type": "application/json", "mcp-protocol-version": "2025-06-18" } });
    });
    const app = buildGateway({ agentPlatformUrl: "http://agent-platform:4100", rateLimitPerWindow: 10, preAuthRateLimitPerWindow: 10 });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    const response = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: "Bearer secret", "x-correlation-id": "trace-123" }, payload: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(ready.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).toBe("trace-123");
    expect(metrics.body).toContain("kasitek_gateway_requests_total 1");
    expect(metrics.body).toContain("kasitek_gateway_errors_total 0");
    await app.close();
    fetchMock.mockRestore();
  });

  it("counts bounded client and rate-limit failures in redacted metrics", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "content-type": "application/json" } }));
    const app = buildGateway({ agentPlatformUrl: "http://agent-platform:4100", rateLimitPerWindow: 1, preAuthRateLimitPerWindow: 1 });
    const malformed = await app.inject({ method: "POST", url: "/mcp", headers: { "mcp-protocol-version": "2099-01-01" }, payload: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    const limited = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(malformed.statusCode).toBe(400);
    expect(limited.statusCode).toBe(429);
    expect(metrics.body).toContain("kasitek_gateway_errors_total 2");
    expect(metrics.body).not.toContain("authorization");
    await app.close();
    fetchMock.mockRestore();
  });

  it("keeps replica behavior stateless and equivalent", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "content-type": "application/json" } }));
    const first = buildGateway({ agentPlatformUrl: "http://agent-platform:4100", rateLimitPerWindow: 1, preAuthRateLimitPerWindow: 1 });
    const second = buildGateway({ agentPlatformUrl: "http://agent-platform:4100", rateLimitPerWindow: 1, preAuthRateLimitPerWindow: 1 });
    const payload = { jsonrpc: "2.0", id: 1, method: "initialize" };
    const firstReplica = await first.inject({ method: "POST", url: "/mcp", headers: { authorization: "Bearer replica-token" }, payload });
    const secondReplica = await second.inject({ method: "POST", url: "/mcp", headers: { authorization: "Bearer replica-token" }, payload });
    expect(firstReplica.statusCode).toBe(200);
    expect(secondReplica.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await first.inject({ method: "POST", url: "/mcp", headers: { authorization: "Bearer replica-token" }, payload })).statusCode).toBe(429);
    expect((await second.inject({ method: "POST", url: "/mcp", headers: { authorization: "Bearer replica-token" }, payload })).statusCode).toBe(429);
    await first.close();
    await second.close();
    fetchMock.mockRestore();
  });
});
