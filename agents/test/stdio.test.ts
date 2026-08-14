import { describe, expect, it, vi } from "vitest";
import { forwardStdioMessage, runStdioBridge } from "../src/gateway/stdio";
import { PassThrough } from "node:stream";

describe("local MCP stdio bridge", () => {
  it("forwards protocol and bearer headers to the hosted gateway", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 }));
    const response = await forwardStdioMessage({ endpoint: "https://agents.example/mcp", token: "secret-token", message: { jsonrpc: "2.0", id: 1, method: "initialize" }, fetchImpl });
    expect(response).toContain('"jsonrpc":"2.0"');
    expect(fetchImpl).toHaveBeenCalledWith("https://agents.example/mcp", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer secret-token", "mcp-protocol-version": "2025-06-18" }),
    }));
  });

  it("preserves notification silence and returns structured local errors", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }), { status: 200 }));
    const bridge = runStdioBridge({ endpoint: "https://agents.example/mcp", token: "secret-token", input, output, fetchImpl });
    input.end(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await bridge;
    expect(Buffer.concat(chunks).toString()).toBe('{"jsonrpc":"2.0","id":2,"result":{}}\n');
  });

  it("rejects malformed and oversized local messages before forwarding", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const fetchImpl = vi.fn();
    const bridge = runStdioBridge({ endpoint: "https://agents.example/mcp", token: "secret-token", input, output, fetchImpl });
    input.end(`not-json\n${"x".repeat(256 * 1024 + 1)}\n`);
    await bridge;
    const lines = Buffer.concat(chunks).toString().trim().split("\n").map((line) => JSON.parse(line) as { error: { code: number } });
    expect(lines.map((line) => line.error.code)).toEqual([-32600, -32011]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
