import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callRemoteMcpTool, discoverRemoteMcpTools, validateRemoteMcpEndpoint } from "../src/mcp/remote";

describe("remote MCP boundary", () => {
  let server: Server;
  let endpoint: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const input = JSON.parse(body) as { method: string };
        response.setHeader("content-type", "application/json");
        if (input.method === "initialize") {
          response.setHeader("Mcp-Session-Id", "test-session");
          response.end(JSON.stringify({ jsonrpc: "2.0", id: "kasitek-initialize", result: { protocolVersion: "2025-06-18" } }));
          return;
        }
        if (input.method === "tools/list") {
          response.end(JSON.stringify({ jsonrpc: "2.0", id: "kasitek-tools-list", result: { tools: [{ name: "lookup", description: "Look up a value", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }] } }));
          return;
        }
        response.end(JSON.stringify({ jsonrpc: "2.0", id: "kasitek-tools-call", result: { answer: "ok", apiKey: "do-not-return" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    endpoint = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("rejects private production endpoints", () => {
    expect(() => validateRemoteMcpEndpoint("http://127.0.0.1:8000/mcp", "production")).toThrow("REMOTE_MCP_ENDPOINT_HTTPS_REQUIRED");
    expect(() => validateRemoteMcpEndpoint("https://127.0.0.1:8000/mcp", "production")).toThrow("REMOTE_MCP_ENDPOINT_PRIVATE_NETWORK");
  });

  it("discovers pinned tool schemas and redacts remote output", async () => {
    const discovered = await discoverRemoteMcpTools({ endpointUrl: endpoint, timeoutMs: 2_000, maxResponseBytes: 100_000, environment: "test" });
    expect(discovered.tools[0]).toMatchObject({ name: "lookup", description: "Look up a value" });
    const output = await callRemoteMcpTool({ endpointUrl: endpoint, toolName: "lookup", argumentsValue: { query: "value" }, timeoutMs: 2_000, maxResponseBytes: 100_000, environment: "test" });
    expect(output).toEqual({ answer: "ok", apiKey: "[REDACTED]" });
  });
});
