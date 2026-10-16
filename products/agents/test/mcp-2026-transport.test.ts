import { describe, expect, it, vi } from "vitest";
import { buildGateway } from "../src/gateway/app";
import { forwardStdioMessage } from "../src/gateway/stdio";

const metadata = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "transport-test", version: "1.0.0" },
};

function modernCall() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      _meta: metadata,
      name: "platform.current_time",
      arguments: {},
    },
  };
}

describe("MCP 2026 transport adapters", () => {
  it("validates and forwards modern headers through the stateless gateway", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { resultType: "complete", content: [{ type: "text", text: "ok" }] },
    }), {
      status: 200,
      headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28" },
    }));
    const app = buildGateway({ agentPlatformUrl: "http://agent-platform:4100" });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer token",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "platform.current_time",
        accept: "application/json, text/event-stream",
        "mcp-param-example": "safe-value",
      },
      payload: modernCall(),
    });
    expect(response.statusCode).toBe(200);
    const forwarded = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(forwarded.headers).toMatchObject({
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "platform.current_time",
      "mcp-param-example": "safe-value",
      accept: "application/json, text/event-stream",
    });
    await app.close();
    fetchMock.mockRestore();
  });

  it("rejects modern header/body mismatches at the gateway", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const app = buildGateway({ agentPlatformUrl: "http://agent-platform:4100" });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
        accept: "application/json, text/event-stream",
      },
      payload: modernCall(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: -32020 } });
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
    fetchMock.mockRestore();
  });

  it("rejects sensitive custom headers before gateway forwarding", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const app = buildGateway({ agentPlatformUrl: "http://agent-platform:4100" });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
        accept: "application/json, text/event-stream",
        "mcp-param-api-key": "secret",
      },
      payload: { jsonrpc: "2.0", id: 11, method: "server/discover", params: { _meta: metadata } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: -32020 } });
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
    fetchMock.mockRestore();
  });

  it("supports a gateway-only rollback switch for the 2026 path", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const app = buildGateway({ agentPlatformUrl: "http://agent-platform:4100", statelessEnabled: false });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: 21, method: "server/discover", params: { _meta: metadata } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(response.json()).toMatchObject({ error: { code: -32022, data: { supported: ["2025-06-18"] } } });
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
    fetchMock.mockRestore();
  });

  it("rejects an unlisted Origin while allowing an explicitly configured Origin", async () => {
    const denied = buildGateway({ agentPlatformUrl: "http://agent-platform:4100", allowedOrigins: ["https://trusted.example"] });
    const deniedResponse = await denied.inject({
      method: "POST",
      url: "/mcp",
      headers: { origin: "https://untrusted.example" },
      payload: { jsonrpc: "2.0", id: 2, method: "initialize" },
    });
    expect(deniedResponse.statusCode).toBe(403);
    expect(deniedResponse.json()).toEqual({ error: "origin_not_allowed" });
    await denied.close();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }), { status: 200 }));
    const allowed = buildGateway({ agentPlatformUrl: "http://agent-platform:4100", allowedOrigins: ["https://trusted.example"] });
    const allowedResponse = await allowed.inject({
      method: "POST",
      url: "/mcp",
      headers: { origin: "https://trusted.example" },
      payload: { jsonrpc: "2.0", id: 2, method: "initialize" },
    });
    expect(allowedResponse.statusCode).toBe(200);
    await allowed.close();
    fetchMock.mockRestore();
  });

  it("selects the 2026 HTTP revision for modern stdio messages", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 }));
    await forwardStdioMessage({
      endpoint: "https://agents.example/mcp",
      token: "secret-token",
      message: modernCall(),
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://agents.example/mcp", expect.objectContaining({
      headers: expect.objectContaining({
        "mcp-protocol-version": "2026-07-28",
        accept: "application/json, text/event-stream",
      }),
    }));
  });

  it("keeps upstream response bodies bounded", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bounded-test", {
      status: 200,
      headers: { "content-length": String(1024 * 1024 + 1), "content-type": "application/json" },
    }));
    const app = buildGateway({ agentPlatformUrl: "http://agent-platform:4100" });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: 3, method: "server/discover", params: { _meta: metadata } },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { message: "upstream_response_too_large" } });
    await app.close();
    fetchMock.mockRestore();
  });

  it("exposes redacted era/protocol error counters", async () => {
    const app = buildGateway({ agentPlatformUrl: "http://agent-platform:4100" });
    await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list", accept: "application/json" },
      payload: { jsonrpc: "2.0", id: 22, method: "tools/list", params: { _meta: metadata } },
    });
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.body).toContain("kasitek_gateway_stateless_requests_total 1");
    expect(metrics.body).toContain("kasitek_gateway_protocol_errors_total 1");
    expect(metrics.body).toContain("kasitek_gateway_method_tools_list_total 1");
    expect(metrics.body).toContain("kasitek_gateway_error_responses_total 0");
    await app.close();
  });
});
