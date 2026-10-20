import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { discoverRemoteMcp, executeRemoteMcpTool, type RemoteMcpEndpoint } from "../src/adapters/providers/remote-mcp";

const servers: Server[] = [];
const inputSchema = { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false };
type FixtureOptions = { modern?: boolean; tools?: unknown[]; pages?: number; resources?: boolean; mixedContent?: boolean;
  changed?: boolean; loop?: boolean; reflect?: boolean; hang?: boolean; sse?: boolean; redirect?: boolean; isError?: boolean; inputRequired?: boolean;
  status?: number; sseDestination?: string; resultText?: string; badStructured?: boolean };
async function fixture(options: FixtureOptions = {}) {
  let calls = 0, listCalls = 0; const methods: string[] = [], headers: Record<string, string>[] = [], waiters: (() => void)[] = [];
  let eventStream: import("node:http").ServerResponse | undefined;
  const capabilities = { tools: {}, ...(options.resources ? { resources: {}, prompts: {} } : {}) };
  const server = createServer(async (request, response) => {
    headers.push(request.headers as Record<string, string>);
    if (options.status) { response.writeHead(options.status).end(); return; }
    if (options.redirect) { response.writeHead(307, { location: "/other" }).end(); return; }
    if (options.sse && request.method === "GET") {
      eventStream = response; response.writeHead(200, { "content-type": "text/event-stream" }); response.write(`event: endpoint\ndata: ${options.sseDestination ?? "/messages"}\n\n`); return;
    }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    if (options.sse && request.url !== "/messages") { response.writeHead(405).end(); return; }
    let text = ""; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); methods.push(body.method);
    response.setHeader("content-type", "application/json");
    const reply = (result: unknown) => {
      const message = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
      if (eventStream) { eventStream.write(`event: message\ndata: ${message}\n\n`); response.writeHead(202).end(); }
      else response.end(message);
    };
    const error = () => {
      const message = JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method unavailable" } });
      if (eventStream) { eventStream.write(`event: message\ndata: ${message}\n\n`); response.writeHead(202).end(); }
      else response.end(message);
    };
    if (body.method === "server/discover") {
      if (options.modern) reply({ supportedVersions: ["2026-07-28"], capabilities }); else error();
    } else if (body.method === "initialize") reply({ protocolVersion: "2025-11-25", capabilities, serverInfo: { name: "controlled-fixture", version: "1" } });
    else if (body.method === "notifications/initialized") response.writeHead(202).end();
    else if (body.method === "tools/list") {
      listCalls++;
      const page = Number(body.params?.cursor ?? 0), pagination = options.pages ?? 1;
      const tools = options.tools ?? [{ name: `tool_${page}`, description: "Provider hints cannot grant authority.", inputSchema, annotations: { readOnlyHint: true },
        ...(options.changed && calls > 0 ? { description: "Changed metadata" } : {}) }];
      reply({ ...(options.modern ? { resultType: "complete", ttlMs: 0, cacheScope: "private" } : {}), tools,
        ...(options.loop || page + 1 < pagination ? { nextCursor: options.loop ? "same" : String(page + 1) } : {}) });
    } else if (body.method === "tools/call") {
      calls++; waiters.splice(0).forEach(resolve => resolve());
      if (options.hang) return;
      if (options.inputRequired) { reply({ resultType: "input_required", inputRequests: { ask: { method: "sampling/createMessage", params: {} } } }); return; }
      reply({ ...(options.modern ? { resultType: "complete" } : {}), content: options.mixedContent ? [
        { type: "text", text: "One" }, { type: "image", data: "AA==", mimeType: "image/png" },
        { type: "audio", data: "AA==", mimeType: "audio/wav" }, { type: "resource_link", uri: "https://example.com/artifact", name: "Artifact" },
        { type: "resource", resource: { uri: "file:///result.txt", text: "Embedded" } },
      ] : [{ type: "text", text: options.reflect ? String(request.headers.authorization) : options.resultText ?? "Safe fixture result" }], structuredContent: { count: options.badStructured ? "wrong" : 1 }, isError: options.isError ?? false });
    } else if (body.method === "resources/list") reply({ ...(options.modern ? { resultType: "complete", ttlMs: 0, cacheScope: "private" } : {}), resources: [{ uri: "fixture://policy", name: "Policy", mimeType: "text/plain" }] });
    else if (body.method === "resources/templates/list") reply({ ...(options.modern ? { resultType: "complete", ttlMs: 0, cacheScope: "private" } : {}), resourceTemplates: [{ uriTemplate: "fixture://policy/{name}", name: "Policy template" }] });
    else if (body.method === "prompts/list") reply({ ...(options.modern ? { resultType: "complete", ttlMs: 0, cacheScope: "private" } : {}), prompts: [{ name: "policy", description: "Reviewed before use", arguments: [{ name: "topic", required: true }] }] });
    else error();
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const endpoint: RemoteMcpEndpoint = { endpoint: `http://127.0.0.1:${address.port}/mcp`, deadlineAt: Date.now() + 20_000, testLoopback: true };
  return { endpoint, calls: () => calls, listCalls: () => listCalls, methods, headers,
    called: () => new Promise<void>(resolve => calls ? resolve() : waiters.push(resolve)), options };
}
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });

describe("isolated general remote MCP", () => {
  it.each([false, true])("negotiates legacy/modern protocols modern=%s with exact original names", async modern => {
    const service = await fixture({ modern, tools: [{ name: "Provider.Read_case.v2", inputSchema }] });
    const inventory = await discoverRemoteMcp(service.endpoint);
    expect(inventory.protocolVersion).toBe(modern ? "2026-07-28" : "2025-11-25"); expect(inventory.tools[0]!.name).toBe("Provider.Read_case.v2");
    expect(inventory.tools[0]!.effect).toBe("unknown"); expect(inventory.tools[0]!.reviewRequired).toBe(true);
    const result = await executeRemoteMcpTool(service.endpoint, inventory.tools[0]!, { name: "Controlled" });
    expect(result.content[0]!.text).toBe("Safe fixture result"); expect(service.calls()).toBe(1);
    expect(service.headers.every(headers => headers.authorization === undefined)).toBe(true);
  }, 20_000);
  it("keeps one unsupported schema in diagnostics and discovers compatible tools", async () => {
    const service = await fixture({ tools: [{ name: "safe", inputSchema }, { name: "unsupported", inputSchema: { type: "object", properties: { value: { type: "string", pattern: "(a+)+$" } } } }, { name: 1, inputSchema: {} }] });
    let ticks = 0; const timer = setInterval(() => ticks++, 5);
    try {
      const inventory = await discoverRemoteMcp(service.endpoint);
      expect(inventory.tools).toHaveLength(3); expect(inventory.tools[0]!.compatible).toBe(true);
      expect(inventory.tools[1]!.compatible).toBe(false); expect(inventory.tools[1]!.diagnostics[0]!.code).toBe("MCP_SCHEMA_UNSUPPORTED");
      expect(inventory.tools[2]!.diagnostics[0]!.code).toBe("MCP_DESCRIPTOR_INVALID"); expect(ticks).toBeGreaterThan(1);
      expect(inventory.metrics!.peakRssBytes).toBeLessThan(300 * 1024 * 1024);
      expect((await executeRemoteMcpTool(service.endpoint, inventory.tools[0]!, { name: "safe" })).isError).toBe(false);
    } finally { clearInterval(timer); }
  }, 20_000);
  it("discovers a paginated catalogue above the former 100 tool limit", async () => {
    const service = await fixture({ tools: Array.from({ length: 120 }, (_, index) => ({ name: `tool${index}`, inputSchema })) });
    expect((await discoverRemoteMcp(service.endpoint)).tools).toHaveLength(120);
    const paginated = await fixture({ pages: 4 });
    const inventory = await discoverRemoteMcp(paginated.endpoint);
    expect(inventory.tools.map(tool => tool.name)).toEqual(["tool_0", "tool_1", "tool_2", "tool_3"]); expect(paginated.listCalls()).toBe(4);
  }, 20_000);
  it("lists resources, templates and prompts without activating provider instructions", async () => {
    const service = await fixture({ resources: true }), inventory = await discoverRemoteMcp(service.endpoint);
    expect(inventory.resources[0]!.uri).toBe("fixture://policy"); expect(inventory.resourceTemplates[0]!.uriTemplate).toBe("fixture://policy/{name}");
    expect(inventory.prompts[0]!.arguments[0]).toMatchObject({ name: "topic", required: true });
    expect(inventory.diagnostics.map(value => value.code)).toContain("MCP_PROMPT_ACTIVATION_REQUIRES_POLICY");
    expect(service.methods).not.toContain("prompts/get"); expect(service.methods).not.toContain("resources/read");
  }, 15_000);
  it("preserves every supported typed content block, metadata and structured output", async () => {
    const service = await fixture({ mixedContent: true }), inventory = await discoverRemoteMcp(service.endpoint);
    const result = await executeRemoteMcpTool(service.endpoint, inventory.tools[0]!, { name: "value" });
    expect(result.content.map(block => block.type)).toEqual(["text", "image", "audio", "resource_link", "resource"]);
    expect(result.structuredContent).toEqual({ count: 1 }); expect(result.rawResult.content).toEqual(result.content);
    expect(result.effect).toBe("unknown"); expect(result.resultDigest).toMatch(/^[a-f0-9]{64}$/);
  }, 20_000);
  it("rejects stale descriptors and invalid arguments before an effect", async () => {
    const service = await fixture(), inventory = await discoverRemoteMcp(service.endpoint), tool = inventory.tools[0]!;
    await expect(executeRemoteMcpTool(service.endpoint, { ...tool, definitionDigest: "0".repeat(64) }, { name: "value" })).rejects.toMatchObject({ code: "MCP_DEFINITION_DRIFT" });
    await expect(executeRemoteMcpTool(service.endpoint, tool, { name: 123 })).rejects.toMatchObject({ code: "MCP_ARGUMENTS_INVALID" }); expect(service.calls()).toBe(0);
  }, 20_000);
  it("rejects ambiguous names, page loops and denied physical admission", async () => {
    const duplicated = await fixture({ tools: [{ name: "same", inputSchema }, { name: "same", inputSchema }] });
    await expect(discoverRemoteMcp(duplicated.endpoint)).rejects.toMatchObject({ code: "MCP_TOOL_NAME_COLLISION" });
    const loop = await fixture({ loop: true });
    await expect(discoverRemoteMcp(loop.endpoint)).rejects.toMatchObject({ code: "MCP_PAGINATION_LOOP" });
    const denied = await fixture();
    await expect(discoverRemoteMcp(denied.endpoint, undefined, { beforeAttempt: async () => { throw Error("denied"); } })).rejects.toMatchObject({ code: "CONNECTED_ATTEMPT_DENIED" });
    expect(denied.methods).toEqual([]);
  }, 20_000);
  it("distinguishes a tool error from transport failure and blocks secret reflection", async () => {
    const service = await fixture({ isError: true }), inventory = await discoverRemoteMcp(service.endpoint);
    expect((await executeRemoteMcpTool(service.endpoint, inventory.tools[0]!, { name: "value" })).isError).toBe(true);
    const reflected = await fixture({ reflect: true }), endpoint = { ...reflected.endpoint, authorization: "Bearer controlled-secret" };
    const privateInventory = await discoverRemoteMcp(endpoint);
    await expect(executeRemoteMcpTool(endpoint, privateInventory.tools[0]!, { name: "value" })).rejects.toMatchObject({ code: "MCP_CREDENTIAL_REFLECTION" });
  }, 20_000);
  it("protects short credential values conservatively before exposing provider metadata", async () => {
    const service=await fixture();
    await expect(discoverRemoteMcp({...service.endpoint,authorization:"Bearer a"})).rejects.toMatchObject({code:"MCP_CREDENTIAL_REFLECTION"});
    expect(service.calls()).toBe(0);
  }, 10_000);
  it("cancels an in-flight call without replaying its unknown effect", async () => {
    const service = await fixture({ hang: true }), inventory = await discoverRemoteMcp(service.endpoint), abort = new AbortController();
    const execution = executeRemoteMcpTool(service.endpoint, inventory.tools[0]!, { name: "value" }, abort.signal);
    await service.called(); abort.abort();
    await expect(execution).rejects.toMatchObject({ code: "CANCELLED" }); expect(service.calls()).toBe(1);
  }, 15_000);
  it("supports explicit deprecated SSE and detects opt-in SSE fallback", async () => {
    const service = await fixture({ sse: true });
    const explicit = await discoverRemoteMcp({ ...service.endpoint, transport: "legacy_sse" });
    expect(explicit.transport).toBe("legacy_sse"); expect(explicit.protocolVersion).toBe("2025-11-25"); expect(explicit.tools).toHaveLength(1);
    const fallback = await discoverRemoteMcp({ ...service.endpoint, transport: "auto" });
    expect(fallback.transport).toBe("legacy_sse");
    const result = await executeRemoteMcpTool({ ...service.endpoint, transport: "legacy_sse" }, explicit.tools[0]!, { name: "value" });
    expect(result.content[0]!.text).toBe("Safe fixture result");
  }, 25_000);
  it("rejects redirects, private destinations and cross-origin SSE message endpoints", async () => {
    const redirected = await fixture({ redirect: true });
    await expect(discoverRemoteMcp(redirected.endpoint)).rejects.toMatchObject({ code: "DESTINATION_DENIED" });
    expect(redirected.headers).toHaveLength(1);
    const privateService = await fixture();
    await expect(discoverRemoteMcp({ ...privateService.endpoint, testLoopback: false })).rejects.toMatchObject({ code: "DESTINATION_DENIED" });
    expect(privateService.headers).toHaveLength(0);
    const crossOrigin = await fixture({ sse: true, sseDestination: "http://127.0.0.1:1/messages" });
    await expect(discoverRemoteMcp({ ...crossOrigin.endpoint, transport: "legacy_sse" })).rejects.toMatchObject({ code: "DESTINATION_DENIED" });
    expect(crossOrigin.headers).toHaveLength(1);
  }, 20_000);
  it("does not fall back to legacy SSE when the selected endpoint requires authorization", async () => {
    const denied = await fixture({ status: 401 });
    await expect(discoverRemoteMcp({ ...denied.endpoint, transport: "auto" })).rejects.toMatchObject({ code: "MCP_PROTOCOL" });
    expect(denied.headers).toHaveLength(1);
  }, 10_000);
  it("enforces catalogue, physical-request and result byte limits", async () => {
    const oversized = await fixture({ tools: Array.from({ length: 501 }, (_, index) => ({ name: `tool${index}`, inputSchema })) });
    await expect(discoverRemoteMcp(oversized.endpoint)).rejects.toMatchObject({ code: "MCP_CATALOG_LIMIT" });
    const bounded = await fixture({ pages: 4 });
    await expect(discoverRemoteMcp({ ...bounded.endpoint, maxRequests: 4 })).rejects.toMatchObject({ code: "MCP_ATTEMPT_LIMIT" });
    expect(bounded.headers).toHaveLength(4);
    const hugeResult = await fixture({ resultText: "x".repeat(2_097_153) }), inventory = await discoverRemoteMcp(hugeResult.endpoint);
    await expect(executeRemoteMcpTool(hugeResult.endpoint, inventory.tools[0]!, { name: "value" })).rejects.toMatchObject({ code: "RESPONSE_LIMIT" });
  }, 20_000);
  it("validates structured output and reports unsupported client interactions", async () => {
    const invalid = await fixture({ badStructured: true, tools: [{ name: "typed", inputSchema, outputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] } }] });
    const inventory = await discoverRemoteMcp(invalid.endpoint);
    await expect(executeRemoteMcpTool(invalid.endpoint, inventory.tools[0]!, { name: "value" })).rejects.toMatchObject({ code: "MCP_PROTOCOL" });
    const interactive = await fixture({ modern: true, inputRequired: true }), modern = await discoverRemoteMcp(interactive.endpoint);
    await expect(executeRemoteMcpTool(interactive.endpoint, modern.tools[0]!, { name: "value" })).rejects.toMatchObject({ code: "MCP_CLIENT_CAPABILITY_UNSUPPORTED" });
  }, 20_000);
});
