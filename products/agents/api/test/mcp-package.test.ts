import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  COMPATIBILITY_PROTOCOL_VERSION,
  DEFAULT_MCP_URL,
  STATELESS_PROTOCOL_VERSION,
  forwardMcpMessage,
  probeMcpProtocol,
  resolveCliConfig,
  runStdioBridge,
} from "../../mcp/src/index";

describe("@kasitek/mcp local package bridge", () => {
  it("forwards bearer, protocol, method, and tool identity headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 }));
    await forwardMcpMessage({
      endpoint: "https://agents.example/mcp",
      apiKey: "kst_test-api-key",
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "content.list",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": STATELESS_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://agents.example/mcp", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Bearer kst_test-api-key",
        "mcp-protocol-version": STATELESS_PROTOCOL_VERSION,
        "mcp-method": "tools/call",
        "mcp-name": "content.list",
      }),
    }));
  });

  it("uses the resource URI for the stateless resource identity header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }), { status: 200 }));
    await forwardMcpMessage({
      endpoint: "https://agents.example/mcp",
      apiKey: "kst_test-api-key",
      message: {
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: {
          uri: "kasitek://content/posts/123",
          _meta: {
            "io.modelcontextprotocol/protocolVersion": STATELESS_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
      fetchImpl,
    });

    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ "mcp-name": "kasitek://content/posts/123" }),
    }));
  });

  it("rejects an unsupported protocol before making a network request", async () => {
    const fetchImpl = vi.fn();
    await expect(forwardMcpMessage({
      endpoint: "https://agents.example/mcp",
      apiKey: "kst_test-api-key",
      message: {
        jsonrpc: "2.0",
        id: 3,
        method: "server/discover",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } },
      },
      fetchImpl,
    })).rejects.toMatchObject({ rpcCode: -32022 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps notifications silent and returns request responses over stdio", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 4, result: { tools: [] } }), { status: 200 }));
    const bridge = runStdioBridge({ endpoint: "https://agents.example/mcp", apiKey: "kst_test-api-key", input, output, fetchImpl, probeProtocol: false });

    input.end(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" })}\n`);
    await bridge;

    expect(Buffer.concat(chunks).toString()).toBe('{"jsonrpc":"2.0","id":4,"result":{"tools":[]}}\n');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("probes protocol support before forwarding a compatibility client", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "stdio-probe",
      result: { supportedVersions: [STATELESS_PROTOCOL_VERSION] },
    }), { status: 200 }));
    await expect(probeMcpProtocol({ endpoint: "https://agents.example/mcp", apiKey: "kst_test-api-key", fetchImpl })).resolves.toEqual({
      supportsStateless: true,
      supportsCompatibility: false,
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://agents.example/mcp", expect.objectContaining({
      headers: expect.objectContaining({
        "mcp-protocol-version": STATELESS_PROTOCOL_VERSION,
        "mcp-method": "server/discover",
      }),
    }));
  });

  it("uses the public environment names and preserves internal aliases", () => {
    expect(resolveCliConfig({ KASITEK_MCP_URL: "https://agents.example/mcp", KASITEK_API_KEY: "kst_public-key" })).toEqual({
      endpoint: "https://agents.example/mcp",
      apiKey: "kst_public-key",
    });
    expect(resolveCliConfig({ MCP_STDIO_URL: "http://127.0.0.1:4300/mcp", MCP_STDIO_API_KEY: "kst_legacy-key" })).toEqual({
      endpoint: "http://127.0.0.1:4300/mcp",
      apiKey: "kst_legacy-key",
    });
    expect(resolveCliConfig({})).toEqual({ endpoint: DEFAULT_MCP_URL, apiKey: "" });
    expect(COMPATIBILITY_PROTOCOL_VERSION).toBe("2025-06-18");
  });
});
