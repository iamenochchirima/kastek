import { describe, expect, it, vi } from "vitest";
import { buildGateway } from "../src/gateway/app";

describe("agent gateway", () => {
  it("is stateless and forwards MCP requests without touching storage", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "content-type": "application/json" } }));
    const app = buildGateway({ agentPlatformUrl: "http://agent-platform:4100", sharedSecret: "secret" });
    const health = await app.inject({ method: "GET", url: "/health" });
    const metadata = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" });
    const response = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: "Bearer token", "x-organization-id": "org" }, payload: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    expect(health.json()).toEqual({ status: "ok", service: "agent-gateway" });
    expect(metadata.json()).toMatchObject({ resource: "/mcp" });
    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("http://agent-platform:4100/mcp", expect.objectContaining({ method: "POST" }));
    await app.close();
    fetchMock.mockRestore();
  });
});
