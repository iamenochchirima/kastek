import {readSync} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { createBoundedFetch, ConnectedNetworkError, type NetworkAttempt } from "./connected-network";
import { MCP_ADAPTER_LIMITS, McpAdapterError, type McpJob, type McpTool } from "./mcp-adapter";

const supported = ["2026-07-28", "2025-11-25"];
const fail = (code: string): never => { throw new Error(code); };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const keywords = new Set(["$schema", "format", "$defs", "$ref", "type", "properties", "required", "additionalProperties", "items", "prefixItems", "enum", "const", "title", "description", "default", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "allOf", "anyOf", "oneOf", "not"]);
export function assertRestrictedSchema(schema: unknown): asserts schema is Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || Buffer.byteLength(JSON.stringify(schema)) > MCP_ADAPTER_LIMITS.schemaBytes) fail("MCP_SCHEMA_UNSUPPORTED");
  let jsonNodes = 0;
  function boundedJson(value: unknown, depth: number): void {
    if (++jsonNodes > 4096 || depth > MCP_ADAPTER_LIMITS.schemaDepth + 2) fail("MCP_SCHEMA_UNSUPPORTED");
    if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) fail("MCP_SCHEMA_UNSUPPORTED");
      boundedJson(item, depth + 1);
    }
  }
  boundedJson(schema, 0);
  let nodes = 0;
  const root = schema as Record<string, unknown>;
  function walk(value: unknown, depth: number, stack: Set<unknown>): void {
    if (++nodes > MCP_ADAPTER_LIMITS.schemaNodes || depth > MCP_ADAPTER_LIMITS.schemaDepth || stack.has(value)) fail("MCP_SCHEMA_UNSUPPORTED");
    if (typeof value === "boolean") return;
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("MCP_SCHEMA_UNSUPPORTED");
    const record = value as Record<string, unknown>, next = new Set(stack).add(value);
    for (const [key, item] of Object.entries(record)) {
      if (!keywords.has(key)) fail("MCP_SCHEMA_UNSUPPORTED");
      if (key === "$schema" && depth !== 0) fail("MCP_SCHEMA_UNSUPPORTED");
      if (key === "$schema" && !["https://json-schema.org/draft/2020-12/schema","http://json-schema.org/draft-07/schema#"].includes(item as string)) fail("MCP_SCHEMA_UNSUPPORTED");
      if (key === "format" && item !== "uuid") fail("MCP_SCHEMA_UNSUPPORTED");
      if (root.$schema === "http://json-schema.org/draft-07/schema#" && ["prefixItems","$defs"].includes(key)) fail("MCP_SCHEMA_UNSUPPORTED");
      if (key === "$ref") {
        if (typeof item !== "string" || !item.startsWith("#/$defs/") || item.length > 512) fail("MCP_SCHEMA_UNSUPPORTED");
        let target: unknown = root;
        for (const piece of (item as string).slice(2).split("/")) {
          const name = piece.replaceAll("~1", "/").replaceAll("~0", "~");
          if (!target || typeof target !== "object" || !Object.hasOwn(target, name)) fail("MCP_SCHEMA_UNSUPPORTED");
          target = (target as Record<string, unknown>)[name];
        }
        walk(target, depth + 1, next);
      } else if (["properties", "$defs"].includes(key)) {
        if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length > 100) fail("MCP_SCHEMA_UNSUPPORTED");
        for (const entry of Object.values(item as object)) walk(entry, depth + 1, next);
      } else if (["items", "additionalProperties", "not"].includes(key)) walk(item, depth + 1, next);
      else if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key)) {
        if (!Array.isArray(item) || item.length > 16) fail("MCP_SCHEMA_UNSUPPORTED");
        for (const entry of item as unknown[]) walk(entry, depth + 1, next);
      } else if (key === "enum" && (!Array.isArray(item) || item.length > 100)) fail("MCP_SCHEMA_UNSUPPORTED");
      else if (["required", "type"].includes(key) && Array.isArray(item) && item.length > 100) fail("MCP_SCHEMA_UNSUPPORTED");
    }
  }
  walk(root, 0, new Set());
}
function toolsFrom(result: unknown): McpTool[] {
  const record = result as { tools?: unknown[] };
  if (!Array.isArray(record.tools) || record.tools.length > MCP_ADAPTER_LIMITS.tools) fail("MCP_CATALOG_LIMIT");
  return record.tools!.map(value => {
    const tool = value as Record<string, unknown>;
    if (typeof tool.name !== "string" || !tool.name.length || tool.name.length > 128 || typeof tool.description !== "undefined" && (typeof tool.description !== "string" || tool.description.length > 8192)) fail("MCP_CATALOG_INVALID");
    assertRestrictedSchema(tool.inputSchema); if (tool.outputSchema !== undefined) assertRestrictedSchema(tool.outputSchema);
    return { name: tool.name as string, description: tool.description as string ?? "", inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}), schemaDigest: digest({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema ?? null }) };
  });
}
function guardCatalogBytes(text: string): void {
  // Inspect the transport result before SDK listTools eagerly compiles output schemas.
  const messages: unknown[] = [];
  if (text.trimStart().startsWith("{")) messages.push(JSON.parse(text));
  else for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (data) messages.push(JSON.parse(data));
  }
  for (const message of messages) { const value = message as { result?: unknown }; if (value.result && typeof value.result === "object" && "tools" in value.result) toolsFrom(value.result); }
}
export async function performMcpJob(job: McpJob, observe?: (attempt: NetworkAttempt) => void|Promise<void>) {
  const attempts: NetworkAttempt[] = [], endpoint = new URL(job.endpoint.endpoint);
  const deadlineAt = Math.min(job.endpoint.deadlineAt, Date.now() + MCP_ADAPTER_LIMITS.wallMs);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1, deadlineAt - Date.now()));
  let setupMessages = 0, readMessages = 0, totalMessages = 0;
  let phase: "setup" | "read" = "setup";
  const network = createBoundedFetch({ authorizeUrl: url => url.href === endpoint.href, headers: { ...job.endpoint.headers, authorization: job.endpoint.authorization }, maxRequestBytes: 32768,
    maxResponseBytes: MCP_ADAPTER_LIMITS.resultBytes, deadlineAt, maxAttempts: 1, maxRequests: 7, signal: controller.signal, testLoopback: job.endpoint.testLoopback, onAttempt: attempt => { const receipt = { ...attempt, attempt: totalMessages, phase }; attempts.push(receipt); return observe?.(receipt); } });
  let catalogBytes = 0, catalogTools = 0;
  const transportFetch: typeof fetch = async (url, init) => {
    // Legacy SDK notification streams are disabled locally; no GET is sent or retried.
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (init?.method !== "POST" || typeof init.body !== "string") fail("MCP_CAPABILITY_DENIED");
    const method = JSON.parse(init!.body as string).method as unknown;
    const read = method === "tools/list" || method === "tools/call";
    if (!read && !["server/discover", "initialize", "notifications/initialized"].includes(method as string)) fail("MCP_CAPABILITY_DENIED");
    phase = read ? "read" : "setup";
    for (;;) {
      if (++totalMessages > 7 || read && ++readMessages > Math.min(3,job.endpoint.readAttempts??3) || !read && ++setupMessages > 4) fail("MCP_ATTEMPT_LIMIT");
      await observe?.({ attempt: totalMessages, phase, status: null, requestBytes: Buffer.byteLength(init!.body as string), responseBytes: 0, elapsedMs: 0, outcome: "in_flight" });
      let response: Response;
      try { response = await network(url, { ...init, redirect: "error" }); }
      catch (error) {
        const last = attempts.at(-1);
        if (!read || readMessages >= Math.min(3,job.endpoint.readAttempts??3) || !(error instanceof ConnectedNetworkError) || !["RATE_LIMIT", "NETWORK_UNAVAILABLE"].includes(error.code) || ![429, 502, 503, 504].includes(last?.status ?? 0)) throw error;
        const wait = error.retryAfterMs ?? 250;
        if (!Number.isFinite(wait) || wait >= deadlineAt - Date.now()) throw error;
        await new Promise(resolve => setTimeout(resolve, wait)); continue;
      }
      const text = await response.clone().text();
      const secrets = [job.endpoint.authorization, job.endpoint.authorization.replace(/^Bearer\s+/i, "")].filter(value => value.length >= 8);
      if (secrets.some(secret => text.includes(secret))) fail("MCP_CREDENTIAL_REFLECTION");
      guardCatalogBytes(text);
      if (method === "tools/list") {
        catalogBytes += Buffer.byteLength(text); catalogTools += text.trimStart().startsWith("{") ? (JSON.parse(text).result?.tools?.length ?? 0) : 0;
        if (catalogBytes > MCP_ADAPTER_LIMITS.catalogBytes || catalogTools > MCP_ADAPTER_LIMITS.tools) fail("MCP_CATALOG_LIMIT");
      }
      return response;
    }
  };
  const validator = new AjvJsonSchemaValidator();
  const client = new Client({ name: "kasitek-connected-read", version: "1.0.0" }, { capabilities: {}, supportedProtocolVersions: job.endpoint.protocolVersion ? [job.endpoint.protocolVersion] : supported,
    versionNegotiation: { mode: job.endpoint.protocolVersion === "2025-11-25" ? "legacy" : job.endpoint.protocolVersion === "2026-07-28" ? { pin: "2026-07-28" } : "auto" }, inputRequired: { autoFulfill: false }, listMaxPages: 16, jsonSchemaValidator: validator });
  const transport = new StreamableHTTPClientTransport(endpoint, { fetch: transportFetch, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1, maxReconnectionDelay: 1, reconnectionDelayGrowFactor: 1 } });
  try {
    await client.connect(transport, { signal: controller.signal, timeout: Math.max(1, deadlineAt - Date.now()) });
    const protocolVersion = client.getNegotiatedProtocolVersion(); if (!protocolVersion || !supported.includes(protocolVersion)) fail("MCP_PROTOCOL_UNSUPPORTED");
    const tools: McpTool[] = [], cursors = new Set<string>(); let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined, { signal: controller.signal, timeout: Math.max(1, deadlineAt - Date.now()) });
      tools.push(...toolsFrom(result));
      if (tools.length > MCP_ADAPTER_LIMITS.tools || Buffer.byteLength(JSON.stringify(tools)) > MCP_ADAPTER_LIMITS.catalogBytes || new Set(tools.map(tool => tool.name)).size !== tools.length) fail("MCP_CATALOG_LIMIT");
      cursor = result.nextCursor;
      if (cursor && (cursor.length > 1024 || cursors.has(cursor))) fail("MCP_CATALOG_INVALID");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (job.kind === "discover") return { protocolVersion, tools, attempts };
    assertRestrictedSchema(job.tool.inputSchema); if (job.tool.outputSchema) assertRestrictedSchema(job.tool.outputSchema);
    const selected = tools.find(tool => tool.name === job.tool.name);
    if (!selected) throw new Error("MCP_SCHEMA_DRIFT");
    if (selected.schemaDigest !== job.tool.schemaDigest || selected.schemaDigest !== digest({ inputSchema: job.tool.inputSchema, outputSchema: job.tool.outputSchema ?? null })) fail("MCP_SCHEMA_DRIFT");
    if (Buffer.byteLength(JSON.stringify(job.arguments)) > MCP_ADAPTER_LIMITS.argumentsBytes) fail("REQUEST_LIMIT");
    if (!validator.getValidator(selected.inputSchema)(job.arguments).valid) fail("MCP_ARGUMENTS_INVALID");
    const result = await client.callTool({ name: selected.name, arguments: job.arguments }, { signal: controller.signal, timeout: Math.max(1, deadlineAt - Date.now()) });
    if (Buffer.byteLength(JSON.stringify(result)) > MCP_ADAPTER_LIMITS.resultBytes) fail("RESPONSE_LIMIT");
    const rawResult = result as unknown as Record<string, unknown>;
    const combined = (result.content ?? []).filter(content => content.type === "text").map(content => content.text).join("\n");
    const textBytes = Buffer.from(combined), truncated = textBytes.length > MCP_ADAPTER_LIMITS.textBytes;
    return { protocolVersion, isError: result.isError === true, text: textBytes.subarray(0, MCP_ADAPTER_LIMITS.textBytes).toString("utf8"), structuredContent: result.structuredContent, rawResult, resultDigest: digest(rawResult), truncated, attempts };
  } catch (error) {
    const sdk = error as { code?: unknown; message?: unknown };
    const code = error instanceof ConnectedNetworkError ? error.code : typeof sdk.code === "string" && /^[A-Z0-9_]{1,80}$/.test(sdk.code) ? sdk.code : typeof sdk.message === "string" && /^[A-Z0-9_]{1,80}$/.test(sdk.message) ? sdk.message : "MCP_PROTOCOL";
    throw new McpAdapterError(code, attempts);
  } finally { clearTimeout(timer); await client.close().catch(() => undefined); }
}
async function main(): Promise<void> {
  let input = ""; const decoder = new StringDecoder("utf8");
  for await (const chunk of process.stdin) { input += decoder.write(chunk); if (Buffer.byteLength(input) > 524288) fail("REQUEST_LIMIT"); }
  input += decoder.end();
  const job = JSON.parse(input) as McpJob;
  try { const value = await performMcpJob(job, async attempt => {
    process.stdout.write(`${JSON.stringify({ event: "attempt", value: attempt })}\n`);
    const acknowledgment=Buffer.alloc(3);let offset=0;
    while(offset<3){const read=readSync(3,acknowledgment,offset,3-offset,null);if(!read)fail("CONNECTED_ATTEMPT_DENIED");offset+=read;}
    if(acknowledgment.toString()!=="ok\n")fail("CONNECTED_ATTEMPT_DENIED");
  }); const usage = process.resourceUsage(); process.stdout.write(`${JSON.stringify({ ok: true, value: { ...value, metrics: { peakRssBytes: usage.maxRSS * 1024, cpuMs: (usage.userCPUTime + usage.systemCPUTime) / 1000 } } })}\n`); }
  catch (error) { const raw = error instanceof McpAdapterError || error instanceof ConnectedNetworkError ? error.code : error instanceof Error ? error.message : "MCP_PROTOCOL"; const code = /^[A-Z0-9_]{1,80}$/.test(raw) ? raw : "MCP_PROTOCOL"; process.stdout.write(`${JSON.stringify({ ok: false, code, attempts: error instanceof McpAdapterError ? error.attempts : [] })}\n`); }
}
if (require.main === module) void main().catch(() => { process.stdout.write(`${JSON.stringify({ ok: false, code: "MCP_PROTOCOL" })}\n`); });
