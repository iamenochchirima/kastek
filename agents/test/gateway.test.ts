import { describe, expect, it, vi } from "vitest";
import { buildGateway } from "../src/gateway/app";

describe("agent gateway", () => {
  it("is stateless and forwards MCP requests without touching storage", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "content-type": "application/json" } }));
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
    expect(forwarded.headers).not.toHaveProperty("x-correlation-id");
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
});
