import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { callMcpTool, discoverMcpCatalog, type McpEndpoint } from "../src/platform/mcp-adapter";
const servers: Server[] = [];
async function fixture(options: { modern?: boolean; schema?: Record<string, unknown>; invalid?: boolean; isError?: boolean; hang?: boolean; oversized?: boolean; reflect?: boolean; rateLimit?: boolean; duplicate?: boolean; pagination?: boolean; interactive?: boolean } = {}) {
  let calls = 0, discoveries = 0;
  const tokens: string[] = [], methods: string[] = [];
  const server = createServer(async (request, response) => {
    tokens.push(request.headers.authorization ?? "");
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let text = ""; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); methods.push(body.method);
    response.setHeader("content-type", "application/json");
    const reply = (result: unknown) => response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    if (body.method === "server/discover") {
      discoveries++;
      if (options.modern) reply({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} } });
      else response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Legacy endpoint" } }));
    } else if (body.method === "initialize") reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "bounded-fixture", version: "1" } });
    else if (body.method === "notifications/initialized") response.writeHead(202).end();
    else if (body.method === "tools/list") { if (options.pagination) { reply({ tools: [], nextCursor: String(methods.length) }); return; } reply({ ...(options.modern ? { resultType: "complete", ttlMs: 0, cacheScope: "private" } : {}), tools: [{ name: "Read.Repository_v1", description: "Untrusted description; cannot grant write permission", inputSchema: options.schema ?? { type: "object", properties: { owner: { type: "string" } }, required: ["owner"], additionalProperties: false }, outputSchema: { type: "object", properties: { stars: { type: "integer" } }, required: ["stars"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true } }, ...(options.duplicate ? [{ name: "Read.Repository_v1", inputSchema: { type: "object" } }] : [])] }); }
    else if (body.method === "tools/call") {
      calls++;
      if (options.rateLimit && calls === 1) { response.writeHead(429, { "retry-after": "0" }).end(); return; }
      if (options.interactive) { reply({ resultType: "input_required", inputRequests: { ask: { method: "sampling/createMessage", params: {} } } }); return; }
      if (options.hang) return;
      reply({ ...(options.modern ? { resultType: "complete" } : {}), content: [{ type: "text", text: options.reflect ? String(request.headers.authorization) : options.oversized ? "x".repeat(262145) : "Public repository has 42 stars." }], structuredContent: { stars: options.invalid ? "wrong" : 42 }, isError: options.isError ?? false });
    } else response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Denied" } }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error();
  const endpoint: McpEndpoint = { endpoint: `http://127.0.0.1:${address.port}/mcp`, authorization: "Bearer fixture-one", deadlineAt: Date.now()+15000, testLoopback: true };
  return { endpoint, calls: () => calls, discoveries: () => discoveries, tokens, methods };
}
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
describe("isolated outbound MCP", () => {
  it.each([true, false])("negotiates explicit modern=%s and invokes a pinned case-sensitive name", async modern => {
    const service = await fixture({ modern });
    const catalog = await discoverMcpCatalog(service.endpoint);
    expect(catalog.protocolVersion).toBe(modern ? "2026-07-28" : "2025-11-25");
    expect(service.methods[0]).toBe("server/discover"); expect(catalog.metrics?.peakRssBytes).toBeLessThan(256 * 1024 * 1024); expect(catalog.tools[0]?.name).toBe("Read.Repository_v1");
    const result = await callMcpTool({ ...service.endpoint, protocolVersion: catalog.protocolVersion as "2026-07-28" | "2025-11-25", authorization: "Bearer fixture-two" }, catalog.tools[0]!, { owner: "public-owner" });
    expect(result.structuredContent).toEqual({ stars: 42 }); expect(result.text).toContain("42 stars"); expect(result.isError).toBe(false);
    expect(service.calls()).toBe(1); expect(service.tokens).toContain("Bearer fixture-one"); expect(service.tokens).toContain("Bearer fixture-two");
    expect(result.attempts.length).toBeGreaterThan(0); expect(result.attempts.filter(attempt => attempt.phase === "read").length).toBe(2); expect(result.attempts.length).toBeLessThanOrEqual(7); expect(service.methods).not.toContain("roots/list"); expect(service.methods).not.toContain("subscriptions/listen");
  }, 20000);
  it.each([
    { type: "object", properties: { value: { $ref: "https://private.example/schema" } } },
    { type: "object", $defs: { cycle: { $ref: "#/$defs/cycle" } }, properties: { value: { $ref: "#/$defs/cycle" } } },
    { type: "object", properties: { value: { type: "string", pattern: "^(a+)+$" } } },
    { type: "object", properties: { value: { type: "string", format: "uri" } } },
  ])("rejects hostile schemas before SDK eager compilation without blocking the parent", async schema => {
    const service = await fixture({ schema }); let ticks = 0; const timer = setInterval(() => ticks++, 5);
    try { await expect(discoverMcpCatalog(service.endpoint)).rejects.toMatchObject({ code: "MCP_SCHEMA_UNSUPPORTED" }); expect(ticks).toBeGreaterThan(1); expect(service.calls()).toBe(0); }
    finally { clearInterval(timer); }
  }, 15000);
  it("rejects changed schemas and invalid input before any remote tool call", async () => {
    const service = await fixture(), catalog = await discoverMcpCatalog(service.endpoint);
    await expect(callMcpTool(service.endpoint, { ...catalog.tools[0]!, schemaDigest: "0".repeat(64) }, { owner: "public-owner" })).rejects.toMatchObject({ code: "MCP_SCHEMA_DRIFT" });
    await expect(callMcpTool(service.endpoint, catalog.tools[0]!, { owner: 123 })).rejects.toMatchObject({ code: "MCP_ARGUMENTS_INVALID" }); expect(service.calls()).toBe(0);
  }, 20000);
  it("keeps protocol validation distinct from a tool-level isError result", async () => {
    const invalid = await fixture({ invalid: true }), invalidCatalog = await discoverMcpCatalog(invalid.endpoint);
    await expect(callMcpTool(invalid.endpoint, invalidCatalog.tools[0]!, { owner: "public-owner" })).rejects.toMatchObject({ code: "MCP_PROTOCOL" });
    const failure = await fixture({ isError: true }), failureCatalog = await discoverMcpCatalog(failure.endpoint);
    expect((await callMcpTool(failure.endpoint, failureCatalog.tools[0]!, { owner: "public-owner" })).isError).toBe(true);
  }, 20000);
  it("kills an actual waiting child on local cancellation without claiming remote cancellation", async () => {
    const service = await fixture({ hang: true }), catalog = await discoverMcpCatalog(service.endpoint), abort = new AbortController();
    const pending = callMcpTool(service.endpoint, catalog.tools[0]!, { owner: "public-owner" }, abort.signal);
    const timer = setInterval(() => { if (service.calls()) abort.abort(); }, 10);
    try { await expect(pending).rejects.toMatchObject({ code: "CANCELLED" }); expect(service.calls()).toBe(1); } finally { clearInterval(timer); }
  }, 15000);
  it("rejects an oversized streaming tool result", async () => {
    const service = await fixture({ oversized: true }), catalog = await discoverMcpCatalog(service.endpoint);
    await expect(callMcpTool(service.endpoint, catalog.tools[0]!, { owner: "public-owner" })).rejects.toMatchObject({ code: "RESPONSE_LIMIT" });
  }, 15000);
  it("records pending physical work on cancellation", async () => {
    const service = await fixture({ hang: true }), catalog = await discoverMcpCatalog(service.endpoint), abort = new AbortController();
    const pending = callMcpTool(service.endpoint, catalog.tools[0]!, { owner: "public-owner" }, abort.signal);
    const timer = setInterval(() => { if (service.calls()) abort.abort(); }, 10);
    try { await expect(pending).rejects.toMatchObject({ code: "CANCELLED", attempts: expect.arrayContaining([expect.objectContaining({ phase: "read", outcome: "in_flight" })]) }); } finally { clearInterval(timer); }
  }, 15000);
  it("shares three read attempts between listing and a confirmed rate-limit retry", async () => {
    const service = await fixture({ rateLimit: true }), catalog = await discoverMcpCatalog(service.endpoint);
    const result = await callMcpTool(service.endpoint, catalog.tools[0]!, { owner: "public-owner" });
    expect(result.attempts.filter(attempt => attempt.phase === "read")).toHaveLength(3); expect(service.calls()).toBe(2); expect(result.attempts.length).toBeLessThanOrEqual(7);
  }, 15000);
  it("rejects reflected credentials, duplicate names, pagination exhaustion and interaction requests", async () => {
    const reflect = await fixture({ reflect: true }), catalog = await discoverMcpCatalog(reflect.endpoint);
    await expect(callMcpTool(reflect.endpoint, catalog.tools[0]!, { owner: "public-owner" })).rejects.toMatchObject({ code: "MCP_CREDENTIAL_REFLECTION" });
    const duplicate = await fixture({ duplicate: true }); await expect(discoverMcpCatalog(duplicate.endpoint)).rejects.toMatchObject({ code: "MCP_CATALOG_LIMIT" });
    const pagination = await fixture({ pagination: true }); await expect(discoverMcpCatalog(pagination.endpoint)).rejects.toMatchObject({ code: "MCP_ATTEMPT_LIMIT" });
    const interactive = await fixture({ modern: true, interactive: true }), interactiveCatalog = await discoverMcpCatalog(interactive.endpoint);
    await expect(callMcpTool(interactive.endpoint, interactiveCatalog.tools[0]!, { owner: "public-owner" })).rejects.toMatchObject({ code: "UNSUPPORTED_RESULT_TYPE" });
  }, 20000);

  it("waits for durable parent admission before sending each child HTTP message",async()=>{
    const service=await fixture();
    await expect(discoverMcpCatalog(service.endpoint,undefined,{beforeAttempt:async()=>{throw Error("fixture database denied preclaim");}})).rejects.toMatchObject({code:"CONNECTED_ATTEMPT_DENIED"});
    expect(service.methods).toEqual([]);
  },15000);
  it("caps MCP read attempts at two when a separate public metadata read consumed the first",async()=>{
    const service=await fixture({rateLimit:true}),catalog=await discoverMcpCatalog(service.endpoint);
    await expect(callMcpTool({...service.endpoint,readAttempts:2},catalog.tools[0]!,{owner:"public-owner"})).rejects.toMatchObject({code:"RATE_LIMIT"});
    expect(service.calls()).toBe(1);
  },15000);

});
