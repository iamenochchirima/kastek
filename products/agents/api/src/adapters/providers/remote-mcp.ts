import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, readSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { preflightToolSchema } from "../../contracts/capability-catalog";
import { requestDigest } from "../../contracts/contracts";
import { publicAddress, type NetworkAttempt } from "../../infrastructure/connected-network";

export const REMOTE_MCP_RELEASE = "remote-mcp-v1-sdk2.3.1-cache1";
export const REMOTE_MCP_LIMITS = Object.freeze({ tools: 500, inventoryEntries: 500, catalogBytes: 2_097_152,
  pages: 32, schemaBytes: 32768, argumentsBytes: 65536, resultBytes: 2_097_152,
  requestBytes: 131072, requests: 128, wallMs: 30_000, cpuSeconds: 5, heapMiB: 96, addressBytes: 2_147_483_648 });
type JsonObject = Record<string, unknown>;
export interface RemoteMcpCacheScope {
  organizationId:string;accountId:string;connectionId:string;credentialRevision:number;policyRevision:number;generation:number;
}
export interface RemoteMcpEndpoint {
  endpoint: string; authorization?: string; headers?: Record<string, string>;
  protocolVersion?: "2026-07-28" | "2025-11-25"; deadlineAt: number; maxRequests?: number;
  transport?: "streamable_http" | "legacy_sse" | "auto"; testLoopback?: boolean;
  cacheScope?:RemoteMcpCacheScope;effectiveAuthorityDigest?:string;adapterManifestDigest?:string;
}
export interface RemoteMcpDiagnostic { code: string; message: string }
export interface RemoteMcpTool {
  name: string; alias: string; description: string; inputSchema: JsonObject; outputSchema?: JsonObject;
  annotations?: JsonObject; definitionDigest: string; schemaDigest: string;
  effect: "unknown"; reviewRequired: true; compatible: boolean; diagnostics: RemoteMcpDiagnostic[];
}
export interface RemoteMcpResource { uri: string; name: string; mimeType?: string; descriptor: JsonObject }
export interface RemoteMcpResourceTemplate { uriTemplate: string; name: string; descriptor: JsonObject }
export interface RemoteMcpPrompt { name: string; description?: string; arguments: { name: string; required: boolean; description?: string }[]; descriptor: JsonObject }
export interface RemoteMcpInventory {
  protocolVersion: "2026-07-28" | "2025-11-25"; transport: "streamable_http" | "legacy_sse";
  tools: RemoteMcpTool[]; resources: RemoteMcpResource[]; resourceTemplates: RemoteMcpResourceTemplate[]; prompts: RemoteMcpPrompt[];
  serverCapabilities: JsonObject; diagnostics: RemoteMcpDiagnostic[]; digest: string;
  attempts: NetworkAttempt[]; metrics?: { peakRssBytes: number; cpuMs: number };
}
export interface RemoteMcpCatalogIndex {
  protocolVersion:"2026-07-28"|"2025-11-25";transport:"streamable_http"|"legacy_sse";
  capabilitiesDigest:string;expiresAt:number;
  tools:{name:string;definitionDigest:string;schemaDigest:string;compatible:boolean}[];
}
export interface RemoteMcpResult {
  protocolVersion: "2026-07-28" | "2025-11-25"; transport: "streamable_http" | "legacy_sse";
  isError: boolean; content: JsonObject[]; structuredContent?: unknown; rawResult: JsonObject;
  resultDigest: string; effect: "unknown"; reviewRequired: true; attempts: NetworkAttempt[];
  catalogIndex?:RemoteMcpCatalogIndex;
  metrics?: { peakRssBytes: number; cpuMs: number };
}
export interface RemoteMcpHooks {
  beforeAttempt?(attempt: RemoteMcpAttempt): Promise<void>; onAttempt?(attempt: RemoteMcpAttempt): Promise<void>;
  onScopeRequired?(challenge:RemoteMcpScopeChallenge):Promise<void>;
}
export interface RemoteMcpAttempt extends NetworkAttempt { rpcMethod?: string }
export interface RemoteMcpScopeChallenge {resource:string;requiredScope:string}
type Job = { kind: "discover"; endpoint: RemoteMcpEndpoint }
  | { kind: "call"; endpoint: RemoteMcpEndpoint; tool: RemoteMcpTool; arguments: JsonObject; cached?:Omit<RemoteMcpCatalogIndex,"tools">&{tool?:RemoteMcpCatalogIndex["tools"][number]} };
export class RemoteMcpError extends Error {
  constructor(public readonly code: string, public readonly attempts: NetworkAttempt[] = [],public readonly scopeChallenge?:RemoteMcpScopeChallenge) { super(code); }
}
function fail(code: string): never { throw new RemoteMcpError(code); }
const protocols = ["2026-07-28", "2025-11-25"] as const;
function record(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MCP_DESCRIPTOR_INVALID");
  return value as JsonObject;
}
function boundedString(value: unknown, maximum = 1024): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > maximum) fail("MCP_DESCRIPTOR_INVALID");
  return value as string;
}

async function isolated<T>(job: Job, signal?: AbortSignal, hooks?: RemoteMcpHooks): Promise<T> {
  if (signal?.aborted) fail("CANCELLED");
  const remaining = Math.min(REMOTE_MCP_LIMITS.wallMs, job.endpoint.deadlineAt - Date.now());
  if (!Number.isFinite(remaining) || remaining <= 0) fail("DEADLINE");
  if (!existsSync("/usr/bin/prlimit")) fail("ADAPTER_ISOLATION_UNAVAILABLE");
  const serialized = JSON.stringify(job);
  if (Buffer.byteLength(serialized) > 262144) fail("REQUEST_LIMIT");
  const compiled = join(__dirname, "remote-mcp.js"), source = join(__dirname, "remote-mcp.ts");
  const entry = existsSync(compiled) ? [compiled] : ["--import", require.resolve("tsx"), source];
  return new Promise<T>((resolve, reject) => {
    const child = spawn("/usr/bin/prlimit", [`--cpu=${REMOTE_MCP_LIMITS.cpuSeconds}:${REMOTE_MCP_LIMITS.cpuSeconds}`, `--as=${REMOTE_MCP_LIMITS.addressBytes}`,
      process.execPath, "--jitless", `--max-old-space-size=${REMOTE_MCP_LIMITS.heapMiB}`, "--max-semi-space-size=4", "--disable-proto=throw", ...entry, "--remote-mcp-worker"],
    { stdio: ["pipe", "pipe", "pipe", "pipe"], env: { LANG: "C.UTF-8", TZ: "UTC" } });
    const channel = child.stdio[3] as Duplex; channel.on("error", () => undefined);
    const decoder = new StringDecoder("utf8"), attempts = new Map<number, NetworkAttempt>();
    let pending = "", bytes = 0, stderrBytes = 0, errorCode: string | undefined;
    let result: { ok: boolean; value?: T; code?: string;scopeChallenge?:RemoteMcpScopeChallenge } | undefined, acknowledgments = Promise.resolve();
    const stop = (code: string) => { errorCode ??= code; child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop("DEADLINE"), remaining), cancel = () => stop("CANCELLED");
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 7_000_000) { stop("ADAPTER_OUTPUT_LIMIT"); return; }
      pending += decoder.write(chunk);
      for (;;) {
        const end = pending.indexOf("\n"); if (end < 0) break;
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.event === "attempt" && Number.isInteger(frame.value?.attempt) && frame.value.attempt >= 1 && frame.value.attempt <= REMOTE_MCP_LIMITS.requests) {
            attempts.set(frame.value.attempt, frame.value);
            acknowledgments = acknowledgments.then(async () => {
              if (frame.value.outcome === "in_flight") await hooks?.beforeAttempt?.(frame.value);
              else await hooks?.onAttempt?.(frame.value);
              channel.write("ok\n");
            }).catch(() => stop("CONNECTED_ATTEMPT_DENIED"));
          } else if (typeof frame.ok === "boolean") result = frame;
          else stop("ADAPTER_OUTPUT_INVALID");
        } catch { stop("ADAPTER_OUTPUT_INVALID"); }
      }
    });
    // SDK errors may contain provider data or credentials. Never forward stderr to the parent.
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 8192) stop("ADAPTER_DIAGNOSTIC_LIMIT"); });
    child.stdin.on("error", () => undefined);
    child.once("error", () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(new RemoteMcpError("ADAPTER_ISOLATION_UNAVAILABLE")); });
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      const attemptsList = [...attempts.values()].sort((a, b) => a.attempt - b.attempt);
      if (errorCode || code !== 0) reject(new RemoteMcpError(errorCode ?? "ADAPTER_RESOURCE_LIMIT", attemptsList));
      else if (!result) reject(new RemoteMcpError("ADAPTER_OUTPUT_INVALID", attemptsList));
      else if (!result.ok) {
        const challenge=result.scopeChallenge;
        const valid=result.code==="OAUTH_SCOPE_REQUIRED"&&challenge?.resource===job.endpoint.endpoint&&typeof challenge.requiredScope==="string"&&Buffer.byteLength(challenge.requiredScope)<=2048
          &&/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(challenge.requiredScope)&&challenge.requiredScope.split(" ").length<=32;
        reject(new RemoteMcpError(typeof result.code === "string" && /^[A-Z0-9_]{1,80}$/.test(result.code) ? result.code : "MCP_PROTOCOL", attemptsList,valid?challenge:undefined));
      }
      else resolve(result.value as T);
    });
    child.stdin.end(serialized);
  });
}
export const REMOTE_MCP_CACHE_LIMITS=Object.freeze({partitions:16,bytes:8_388_608,indexBytes:2_097_152,ttlMs:30_000});
const catalogCache=new Map<string,{index:RemoteMcpCatalogIndex;bytes:number;partition:string}>();
function cachePartition(scope:RemoteMcpCacheScope):string {return requestDigest([scope.organizationId,scope.accountId,scope.connectionId]);}
function cacheKey(endpoint:RemoteMcpEndpoint):string|undefined {
  const scope=endpoint.cacheScope;
  if(!scope||![scope.organizationId,scope.accountId,scope.connectionId].every(value=>typeof value==="string"&&value.length>0&&value.length<=128)
    ||![scope.credentialRevision,scope.policyRevision,scope.generation].every(value=>Number.isSafeInteger(value)&&value>0)
    ||!endpoint.effectiveAuthorityDigest||!/^[a-f0-9]{64}$/.test(endpoint.effectiveAuthorityDigest))return;
  const identity=requestDigest({authorization:endpoint.authorization??null,headers:endpoint.headers??{}});
  return requestDigest({scope,identity,authority:endpoint.effectiveAuthorityDigest,endpoint:endpoint.endpoint,
    protocol:endpoint.protocolVersion??"auto",transport:endpoint.transport??"auto",release:REMOTE_MCP_RELEASE,adapter:endpoint.adapterManifestDigest??null});
}
export function invalidateRemoteMcpCatalogCache(scope?:RemoteMcpCacheScope):void {
  const partition=scope?cachePartition(scope):undefined;
  for(const [key,value]of catalogCache)if(!partition||value.partition===partition)catalogCache.delete(key);
}
export function remoteMcpCatalogCacheStats():{partitions:number;bytes:number} {return {partitions:catalogCache.size,bytes:[...catalogCache.values()].reduce((sum,value)=>sum+value.bytes,0)};}
function storeIndex(key:string,scope:RemoteMcpCacheScope,index:RemoteMcpCatalogIndex):void {
  for(const [entry,value]of catalogCache)if(value.index.expiresAt<=Date.now())catalogCache.delete(entry);
  const bytes=Buffer.byteLength(JSON.stringify(index));
  if(index.expiresAt<=Date.now()||index.expiresAt>Date.now()+REMOTE_MCP_CACHE_LIMITS.ttlMs||index.tools.length>REMOTE_MCP_LIMITS.tools||bytes>REMOTE_MCP_CACHE_LIMITS.indexBytes)return;
  catalogCache.delete(key);catalogCache.set(key,{index:JSON.parse(JSON.stringify(index)) as RemoteMcpCatalogIndex,bytes,partition:cachePartition(scope)});
  while(catalogCache.size>REMOTE_MCP_CACHE_LIMITS.partitions||remoteMcpCatalogCacheStats().bytes>REMOTE_MCP_CACHE_LIMITS.bytes)catalogCache.delete(catalogCache.keys().next().value!);
}
export function discoverRemoteMcp(endpoint: RemoteMcpEndpoint, signal?: AbortSignal, hooks?: RemoteMcpHooks): Promise<RemoteMcpInventory> {
  if(endpoint.cacheScope)invalidateRemoteMcpCatalogCache(endpoint.cacheScope);
  return isolated({ kind: "discover", endpoint }, signal, hooks);
}
export async function executeRemoteMcpTool(endpoint: RemoteMcpEndpoint, tool: RemoteMcpTool, arguments_: JsonObject,
  signal?: AbortSignal, hooks?: RemoteMcpHooks): Promise<RemoteMcpResult> {
  const key=cacheKey(endpoint),entry=key?catalogCache.get(key):undefined;
  if(key&&entry){catalogCache.delete(key);if(entry.index.expiresAt>Date.now())catalogCache.set(key,entry);}
  const index=entry&&entry.index.expiresAt>Date.now()?entry.index:undefined;
  const cached=index?{protocolVersion:index.protocolVersion,transport:index.transport,capabilitiesDigest:index.capabilitiesDigest,expiresAt:index.expiresAt,
    tool:index.tools.find(value=>value.name===tool.name)}:undefined;
  try {
    const result=await isolated<RemoteMcpResult>({kind:"call",endpoint,tool,arguments:arguments_,...(cached?{cached}:{})},signal,hooks);
    if(key&&result.catalogIndex)storeIndex(key,endpoint.cacheScope!,result.catalogIndex);
    return result;
  }catch(error){if(key)catalogCache.delete(key);if(error instanceof RemoteMcpError&&error.scopeChallenge)await hooks?.onScopeRequired?.(error.scopeChallenge);throw error;}
}

function toolDescriptor(value: unknown): RemoteMcpTool {
  const pending = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 8192 || item.depth > 20) fail("MCP_DESCRIPTOR_INVALID");
    if (item.value && typeof item.value === "object") for (const [key, child] of Object.entries(item.value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) fail("MCP_DESCRIPTOR_INVALID");
      pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  const raw = record(value), name = boundedString(raw.name, 128);
  const description = raw.description === undefined || raw.description === "" ? "" : boundedString(raw.description, 8192);
  const diagnostics: RemoteMcpDiagnostic[] = [];
  let inputSchema: JsonObject = {}, outputSchema: JsonObject | undefined;
  try {
    const input = preflightToolSchema(raw.inputSchema);
    if (typeof input !== "object" || input === null || input.type !== "object") fail("MCP_SCHEMA_UNSUPPORTED");
    inputSchema = input;
    if (raw.outputSchema !== undefined) {
      const output = preflightToolSchema(raw.outputSchema);
      if (typeof output !== "object" || output === null || output.type !== "object") fail("MCP_SCHEMA_UNSUPPORTED");
      outputSchema = output;
    }
    if (raw.execution && record(raw.execution).taskSupport === "required") fail("MCP_TASKS_UNSUPPORTED");
  } catch (error) {
    const code = error instanceof RemoteMcpError ? error.code : "MCP_SCHEMA_UNSUPPORTED";
    diagnostics.push({ code, message: code === "MCP_TASKS_UNSUPPORTED" ? "This tool requires unsupported durable MCP tasks." : "This tool schema exceeds supported validation capabilities." });
    // Preserve the actual untrusted schema in the preview. It never reaches schema compilation.
    inputSchema = raw.inputSchema && typeof raw.inputSchema === "object" && !Array.isArray(raw.inputSchema) ? raw.inputSchema as JsonObject : {};
    outputSchema = raw.outputSchema && typeof raw.outputSchema === "object" && !Array.isArray(raw.outputSchema) ? raw.outputSchema as JsonObject : undefined;
  }
  return { name, alias: `mcp_${requestDigest(name).slice(0, 32)}`, description, inputSchema,
    ...(outputSchema !== undefined ? { outputSchema } : {}), ...(raw.annotations ? { annotations: record(raw.annotations) } : {}),
    definitionDigest: requestDigest(raw), schemaDigest: requestDigest({ inputSchema: raw.inputSchema ?? null, outputSchema: raw.outputSchema ?? null }),
    effect: "unknown", reviewRequired: true, compatible: diagnostics.length === 0, diagnostics };
}

/** Network bytes remain bounded while legacy SSE stays open for the SDK's message stream. */
async function runJob(job: Job, observe: (attempt: RemoteMcpAttempt) => Promise<void>): Promise<RemoteMcpInventory | RemoteMcpResult> {
  const { Client, StreamableHTTPClientTransport, SSEClientTransport,extractWWWAuthenticateParams } = await import("@modelcontextprotocol/client");
  const { AjvJsonSchemaValidator } = await import("@modelcontextprotocol/client/validators/ajv");
  const endpoint = new URL(job.endpoint.endpoint), deadlineAt = Math.min(job.endpoint.deadlineAt, Date.now() + REMOTE_MCP_LIMITS.wallMs);
  const fixture = job.endpoint.testLoopback === true;
  function allowed(url: URL): void {
    const loopback = fixture && url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if ((!loopback && (url.protocol !== "https:" || url.port && url.port !== "443")) || url.username || url.password || url.hash
      || url.origin !== endpoint.origin) fail("DESTINATION_DENIED");
  }
  allowed(endpoint);
  const authorization = job.endpoint.authorization;
  if (authorization !== undefined && (!authorization || /[\x00-\x1f\x7f]/.test(authorization) || Buffer.byteLength(authorization) > 8192)) fail("MCP_AUTH_INVALID");
  const trustedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(job.endpoint.headers ?? {})) {
    if (key.toLowerCase() === "authorization") continue;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(key) || /^(?:host|cookie|connection|content-length|transfer-encoding|proxy-.*|forwarded|x-forwarded-.*)$/i.test(key)
      || typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 8192) fail("MCP_AUTH_INVALID");
    trustedHeaders[key.toLowerCase()] = value;
  }
  if (authorization !== undefined) trustedHeaders.authorization = authorization;
  const secrets = Object.values(trustedHeaders).flatMap(value => [value, value.replace(/^Bearer\s+/i, "")]).filter(value => value.length > 0);
  const maxRequests = job.endpoint.maxRequests ?? REMOTE_MCP_LIMITS.requests;
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > REMOTE_MCP_LIMITS.requests) fail("MCP_ATTEMPT_LIMIT");
  let negotiatedModern=false,toolsFreshUntil=Infinity,selectedCacheExpiresAt:number|undefined,scopeChallenge:RemoteMcpScopeChallenge|undefined;
  let requestCount = 0, catalogBytes = 0, sseGets = 0, protocolFallback = false, ssePostEndpoint: string | undefined, networkFailure: string | undefined;
  const attempts: NetworkAttempt[] = [], tools: RemoteMcpTool[] = [], names = new Set<string>();
  const inventories = { resources: [] as RemoteMcpResource[], resourceTemplates: [] as RemoteMcpResourceTemplate[], prompts: [] as RemoteMcpPrompt[] };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1, deadlineAt - Date.now()));
  const validator = new AjvJsonSchemaValidator();
  const sanitizeMessage = (raw: unknown): unknown => {
    const message = record(raw);
    if (!message.result || typeof message.result !== "object" || Array.isArray(message.result)) return raw;
    const result = message.result as JsonObject;
    if (result.resultType === "input_required") fail("MCP_CLIENT_CAPABILITY_UNSUPPORTED");
    if (result.tools !== undefined) {
      const supplied=result.ttlMs;
      if(supplied!==undefined&&(typeof supplied!=="number"||!Number.isSafeInteger(supplied)))fail("MCP_CACHE_HINT_INVALID");
      const ttl=typeof supplied==="number"?Math.max(0,Math.min(supplied,REMOTE_MCP_CACHE_LIMITS.ttlMs)):negotiatedModern?0:REMOTE_MCP_CACHE_LIMITS.ttlMs;
      toolsFreshUntil=Math.min(toolsFreshUntil,Date.now()+ttl);
      if (!Array.isArray(result.tools)) fail("MCP_CATALOG_INVALID");
      catalogBytes += Buffer.byteLength(JSON.stringify(result));
      if (catalogBytes > REMOTE_MCP_LIMITS.catalogBytes || tools.length + result.tools.length > REMOTE_MCP_LIMITS.tools) fail("MCP_CATALOG_LIMIT");
      const safe: unknown[] = [];
      for (const rawTool of result.tools) {
        let tool: RemoteMcpTool;
        try { tool = toolDescriptor(rawTool); }
        catch {
          const raw = rawTool && typeof rawTool === "object" && !Array.isArray(rawTool) ? rawTool as JsonObject : {};
          const name = typeof raw.name === "string" && raw.name.length && raw.name.length <= 128 ? raw.name : `invalid-tool:${tools.length}`;
          tool = { name, alias: `mcp_${requestDigest([name, tools.length]).slice(0, 32)}`, description: "", inputSchema: {},
            definitionDigest: requestDigest({ invalidIndex: tools.length, name }), schemaDigest: requestDigest(null), effect: "unknown", reviewRequired: true, compatible: false,
            diagnostics: [{ code: "MCP_DESCRIPTOR_INVALID", message: "This tool has an invalid or oversized descriptor." }] };
        }
        if (names.has(tool.name)) fail("MCP_TOOL_NAME_COLLISION");
        names.add(tool.name); tools.push(tool);
        if (tool.compatible) safe.push(rawTool);
      }
      return { ...message, result: { ...result, tools: safe } };
    }
    return raw;
  };
  function sanitizeEvent(frame: string): string {
    const lines = frame.split(/\r?\n/), data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
    if (event === "endpoint") {
      const target = new URL(data, endpoint); allowed(target);
      if (target.origin !== endpoint.origin || target.username || target.password || target.hash) fail("DESTINATION_DENIED");
      ssePostEndpoint = target.href;
    }
    if (!data || event === "endpoint") return frame + "\n\n";
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { fail("MCP_PROTOCOL"); }
    const sanitized = sanitizeMessage(parsed);
    return [...lines.filter(line => !line.startsWith("data:")), `data: ${JSON.stringify(sanitized)}`].join("\n") + "\n\n";
  }
  const active = new Set<ReturnType<typeof httpRequest>>();
  const networkRequest: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); allowed(url);
    const method = init?.method ?? "GET", body = typeof init?.body === "string" ? init.body : "";
    const isSse = method === "GET" && currentTransport === "legacy_sse";
    if (isSse && ++sseGets > 1) fail("MCP_RECONNECTION_UNSUPPORTED");
    if (method === "DELETE") return new Response(null, { status: 405 });
    if (method === "GET" && !isSse) return new Response(null, { status: 405 });
    if (url.href !== endpoint.href && !(currentTransport === "legacy_sse" && url.href === ssePostEndpoint)) fail("DESTINATION_DENIED");
    let rpcMethod: string | undefined;
    if (method === "POST") {
      try { rpcMethod = JSON.parse(body).method; } catch { fail("MCP_PROTOCOL"); }
      if (!["server/discover", "initialize", "notifications/initialized", "tools/list", "tools/call", "resources/list", "resources/templates/list", "prompts/list", "notifications/cancelled"].includes(rpcMethod ?? "")) fail("MCP_CLIENT_CAPABILITY_UNSUPPORTED");
      if (rpcMethod === "tools/call" && job.kind !== "call") fail("MCP_CAPABILITY_DENIED");
    } else if (!isSse) fail("MCP_CAPABILITY_DENIED");
    if (Buffer.byteLength(body) > REMOTE_MCP_LIMITS.requestBytes || ++requestCount > maxRequests) fail("MCP_ATTEMPT_LIMIT");
    const ordinal = requestCount, start = Date.now();
    const phase = ["server/discover", "initialize", "notifications/initialized"].includes(rpcMethod ?? "") || isSse ? "setup" as const
      : rpcMethod === "tools/call" ? undefined : "read" as const;
    if(rpcMethod==="tools/call"&&selectedCacheExpiresAt!==undefined&&selectedCacheExpiresAt<=Date.now())fail("MCP_CATALOG_EXPIRED");
    await observe({ attempt: ordinal, phase, rpcMethod, status: null, requestBytes: Buffer.byteLength(body), responseBytes: 0, elapsedMs: 0, outcome: "in_flight" });
    if (controller.signal.aborted) fail("CANCELLED");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(value => !publicAddress(value.address) && !(fixture && ["127.0.0.1", "::1", "localhost"].includes(host) && ["127.0.0.1", "::1"].includes(value.address)))) fail("PRIVATE_ADDRESS_DENIED");
    const address = addresses[0]!, headers: Record<string, string> = { "accept-encoding": "identity" };
    for (const [key, value] of new Headers(init?.headers)) if (["content-type", "accept", "mcp-protocol-version", "mcp-session-id", "last-event-id"].includes(key)) headers[key] = value;
    Object.assign(headers, trustedHeaders);
    if (Object.entries(headers).some(([key, value]) => key.length + value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) || Buffer.byteLength(JSON.stringify(headers)) > 16384) fail("MCP_AUTH_INVALID");
    if(rpcMethod==="tools/call"&&selectedCacheExpiresAt!==undefined&&selectedCacheExpiresAt<=Date.now())fail("MCP_CATALOG_EXPIRED");
    return new Promise<Response>((resolve, reject) => {
      const send = url.protocol === "http:" ? httpRequest : httpsRequest;
      const request = send(url, { method, headers, agent: false, family: address.family,
        lookup: (_host, _options, callback) => callback(null, address.address, address.family) }, response => {
        const status = response.statusCode ?? 502, responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined && !["set-cookie", "authorization"].includes(name)) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") { response.destroy(new Error("ENCODING_DENIED")); return; }
        if (status >= 300 && status < 400) { response.destroy(new Error("DESTINATION_DENIED")); return; }
        if (Number(response.headers["content-length"]) > REMOTE_MCP_LIMITS.resultBytes) { response.destroy(new Error("RESPONSE_LIMIT")); return; }
        const eventStream = String(response.headers["content-type"] ?? "").toLowerCase().includes("text/event-stream");
        let size = 0, text = "", secretTail = "", settled = false;
        const decoder = new StringDecoder("utf8");
        const complete = async (outcome: string) => {
          if (settled) return; settled = true;
          const attempt: RemoteMcpAttempt = { attempt: ordinal, phase, rpcMethod, status, requestBytes: Buffer.byteLength(body), responseBytes: size, elapsedMs: Date.now() - start, outcome };
          attempts.push(attempt); await observe(attempt);
        };
        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({ start(control) { streamController = control; }, cancel() { request.destroy(); } });
        if (eventStream) resolve(new Response(stream, { status, headers: responseHeaders }));
        response.on("data", (chunk: Buffer) => {
          try {
            size += chunk.length;
            if (size > REMOTE_MCP_LIMITS.resultBytes) fail("RESPONSE_LIMIT");
            const decoded = decoder.write(chunk), inspect = secretTail + decoded;
            if (secrets.some(secret => inspect.includes(secret))) fail("MCP_CREDENTIAL_REFLECTION");
            secretTail = inspect.slice(-8192); text += decoded;
            if (eventStream) {
              for (;;) {
                const separator = /\r?\n\r?\n/.exec(text); if (!separator || separator.index === undefined) break;
                const frame = text.slice(0, separator.index); text = text.slice(separator.index + separator[0].length);
                streamController!.enqueue(Buffer.from(sanitizeEvent(frame)));
              }
            }
          } catch (error) { response.destroy(error instanceof Error ? error : new Error("MCP_PROTOCOL")); }
        });
        response.on("error", error => {
          const code = error instanceof RemoteMcpError ? error.code : /^[A-Z0-9_]+$/.test(error.message) ? error.message : "NETWORK_UNAVAILABLE";
          networkFailure ??= code;
          if (eventStream) streamController?.error(new RemoteMcpError(code));
          void complete(code).catch(() => undefined); reject(new RemoteMcpError(code));
        });
        response.on("end", () => { void (async () => {
          text += decoder.end();
          if (!eventStream && text && secrets.some(secret => text.includes(secret))) fail("MCP_CREDENTIAL_REFLECTION");
          if (eventStream) { if (text.trim()) streamController!.enqueue(Buffer.from(sanitizeEvent(text))); streamController!.close(); }
          else {
            let sanitized = text;
            if (text.trimStart().startsWith("{")) sanitized = JSON.stringify(sanitizeMessage(JSON.parse(text)));
            await complete(status >= 200 && status < 300 ? "ok" : "http_error");
            if(status===403){
              const challenge=extractWWWAuthenticateParams(new Response(null,{status,headers:responseHeaders})),required=challenge.scope;
              if(challenge.error==="insufficient_scope"&&required&&Buffer.byteLength(required)<=2048&&required.split(" ").length<=32
                &&/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(required)&&!secrets.some(secret=>required.includes(secret))){
                scopeChallenge={resource:endpoint.href,requiredScope:required};throw new RemoteMcpError("OAUTH_SCOPE_REQUIRED",[],scopeChallenge);
              }
            }
            // Transport fallback is permitted only for explicit endpoint incompatibility, never auth or transient errors.
            if ([404, 405].includes(status) && ["server/discover", "initialize"].includes(rpcMethod ?? "")) protocolFallback = true;
            resolve(new Response([204, 205, 304].includes(status) ? null : sanitized, { status, headers: responseHeaders }));
          }
          if (eventStream) await complete("ok");
        })().catch(error => { if (eventStream) streamController?.error(error); reject(error); }); });
      });
      active.add(request);
      const abort = () => request.destroy(new Error("CANCELLED"));
      controller.signal.addEventListener("abort", abort, { once: true });
      request.once("close", () => { active.delete(request); controller.signal.removeEventListener("abort", abort); });
      request.once("error", error => reject(error instanceof RemoteMcpError ? error : new RemoteMcpError(/^[A-Z0-9_]+$/.test(error.message) ? error.message : "NETWORK_UNAVAILABLE")));
      if (body) request.write(body); request.end();
    });
  };
  const network: typeof fetch = async (input, init) => {
    try { return await networkRequest(input, init); }
    catch (error) {
      networkFailure ??= error instanceof RemoteMcpError ? error.code : "NETWORK_UNAVAILABLE";
      throw error;
    }
  };
  let currentTransport: "streamable_http" | "legacy_sse" = job.endpoint.transport === "legacy_sse" ? "legacy_sse" : "streamable_http";
  function createClient() {
    return new Client({ name: "kasitek-remote-catalogue", version: "1" }, { capabilities: {}, inputRequired: { autoFulfill: false },
      supportedProtocolVersions: job.endpoint.protocolVersion ? [job.endpoint.protocolVersion] : [...protocols],
      versionNegotiation: { mode: currentTransport === "legacy_sse" || job.endpoint.protocolVersion === "2025-11-25" ? "legacy" : job.endpoint.protocolVersion ? { pin: job.endpoint.protocolVersion } : "auto" },
      listMaxPages: REMOTE_MCP_LIMITS.pages, jsonSchemaValidator: validator });
  }
  let client = createClient();
  const requestOptions = () => ({ signal: controller.signal, timeout: Math.max(1, deadlineAt - Date.now()) });
  async function connect() {
    const transport = currentTransport === "legacy_sse" ? new SSEClientTransport(endpoint, { fetch: network, requestInit: { redirect: "error" } })
      : new StreamableHTTPClientTransport(endpoint, { fetch: network, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1, maxReconnectionDelay: 1, reconnectionDelayGrowFactor: 1 } });
    await client.connect(transport, requestOptions());
  }
  try {
    try { await connect(); }
    catch (error) {
      if (job.endpoint.transport === "auto" && currentTransport === "streamable_http" && protocolFallback) {
        await client.close().catch(() => undefined); currentTransport = "legacy_sse"; client = createClient(); await connect();
      } else throw error;
    }
    const protocolVersion = client.getNegotiatedProtocolVersion();
    if (!protocolVersion || !(protocols as readonly string[]).includes(protocolVersion)) fail("MCP_PROTOCOL_UNSUPPORTED");
    const version = protocolVersion as RemoteMcpInventory["protocolVersion"], capabilities = client.getServerCapabilities() as JsonObject ?? {};
    negotiatedModern=version==="2026-07-28";
    async function pages(method: "tools/list" | "resources/list" | "resources/templates/list" | "prompts/list", key: string): Promise<unknown[]> {
      let cursor: string | undefined, count = 0; const cursors = new Set<string>(), values: unknown[] = [];
      do {
        if (++count > REMOTE_MCP_LIMITS.pages) fail("MCP_PAGINATION_LIMIT");
        // Low-level SDK request avoids automatic aggregation and tool output-schema cache compilation.
        const result = await client.request({ method, params: cursor ? { cursor } : {} }, requestOptions()) as unknown as JsonObject;
        if (result.resultType === "input_required") fail("MCP_CLIENT_CAPABILITY_UNSUPPORTED");
        const items = result[key];
        if (!Array.isArray(items)) fail("MCP_CATALOG_INVALID");
        if (key !== "tools") { catalogBytes += Buffer.byteLength(JSON.stringify(result)); if (catalogBytes > REMOTE_MCP_LIMITS.catalogBytes) fail("MCP_CATALOG_LIMIT"); }
        values.push(...items);
        if (values.length > REMOTE_MCP_LIMITS.inventoryEntries) fail("MCP_CATALOG_LIMIT");
        cursor = result.nextCursor === undefined ? undefined : boundedString(result.nextCursor, 1024);
        if (cursor && cursors.has(cursor)) fail("MCP_PAGINATION_LOOP");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return values;
    }
    const cached=job.kind==="call"?job.cached:undefined;
    const reuse=!!cached&&cached.expiresAt>Date.now()&&cached.expiresAt<=Date.now()+REMOTE_MCP_CACHE_LIMITS.ttlMs
      &&cached.protocolVersion===version&&cached.transport===currentTransport&&cached.capabilitiesDigest===requestDigest(capabilities);
    if (capabilities.tools&&!reuse) await pages("tools/list", "tools");
    if (job.kind === "call") {
      let selected = tools.find(tool => tool.name === job.tool.name);
      if(reuse) {
        selectedCacheExpiresAt=cached!.expiresAt;
        const proof=cached!.tool;
        if(!proof||!proof.compatible||proof.name!==job.tool.name||proof.definitionDigest!==job.tool.definitionDigest||proof.schemaDigest!==job.tool.schemaDigest)fail("MCP_DEFINITION_DRIFT");
        // Cached metadata cannot bypass bounded schema preflight in this isolated process.
        const checked=toolDescriptor({name:job.tool.name,description:job.tool.description,inputSchema:job.tool.inputSchema,...(job.tool.outputSchema?{outputSchema:job.tool.outputSchema}:{})});
        if(!checked.compatible||checked.schemaDigest!==proof.schemaDigest)fail("MCP_DEFINITION_DRIFT");
        selected=job.tool;
      }
      if (!selected || !selected.compatible || selected.definitionDigest !== job.tool.definitionDigest || selected.schemaDigest !== job.tool.schemaDigest
        || requestDigest({ inputSchema: job.tool.inputSchema, outputSchema: job.tool.outputSchema ?? null }) !== selected.schemaDigest) fail("MCP_DEFINITION_DRIFT");
      if(reuse&&cached!.expiresAt<=Date.now())fail("MCP_CATALOG_EXPIRED");
      if (Buffer.byteLength(JSON.stringify(job.arguments)) > REMOTE_MCP_LIMITS.argumentsBytes) fail("REQUEST_LIMIT");
      if (!validator.getValidator(selected.inputSchema)(job.arguments).valid) fail("MCP_ARGUMENTS_INVALID");
      const result = await client.callTool({ name: selected.name, arguments: job.arguments }, { ...requestOptions(), toolDefinition: {
        name: selected.name, inputSchema: selected.inputSchema as { type: "object" }, ...(selected.outputSchema ? { outputSchema: selected.outputSchema as { type: "object" } } : {}),
      } });
      const rawResult = result as unknown as JsonObject;
      if (rawResult.resultType === "input_required") fail("MCP_CLIENT_CAPABILITY_UNSUPPORTED");
      if (Buffer.byteLength(JSON.stringify(rawResult)) > REMOTE_MCP_LIMITS.resultBytes) fail("RESPONSE_LIMIT");
      return { protocolVersion: version, transport: currentTransport, isError: rawResult.isError === true,
        content: Array.isArray(rawResult.content) ? rawResult.content as JsonObject[] : [],
        ...(rawResult.structuredContent !== undefined ? { structuredContent: rawResult.structuredContent } : {}), rawResult,
        resultDigest: requestDigest(rawResult), effect: "unknown", reviewRequired: true, attempts,
        ...(!reuse&&Number.isFinite(toolsFreshUntil)&&toolsFreshUntil>Date.now()?{catalogIndex:{protocolVersion:version,transport:currentTransport,capabilitiesDigest:requestDigest(capabilities),expiresAt:toolsFreshUntil,
          tools:tools.map(({name,definitionDigest,schemaDigest,compatible})=>({name,definitionDigest,schemaDigest,compatible}))}}:{}) };
    }
    if (capabilities.resources) {
      for (const value of await pages("resources/list", "resources")) {
        const descriptor = record(value); inventories.resources.push({ uri: boundedString(descriptor.uri, 4096), name: boundedString(descriptor.name, 256),
          ...(typeof descriptor.mimeType === "string" ? { mimeType: descriptor.mimeType } : {}), descriptor });
      }
      for (const value of await pages("resources/templates/list", "resourceTemplates")) {
        const descriptor = record(value); inventories.resourceTemplates.push({ uriTemplate: boundedString(descriptor.uriTemplate, 4096), name: boundedString(descriptor.name, 256), descriptor });
      }
    }
    if (capabilities.prompts) for (const value of await pages("prompts/list", "prompts")) {
      const descriptor = record(value), args = descriptor.arguments === undefined ? [] : descriptor.arguments;
      if (!Array.isArray(args) || args.length > 50) fail("MCP_CATALOG_INVALID");
      inventories.prompts.push({ name: boundedString(descriptor.name, 128), ...(typeof descriptor.description === "string" ? { description: descriptor.description } : {}),
        arguments: args.map(value => { const argument = record(value); return { name: boundedString(argument.name, 128), required: argument.required === true,
          ...(typeof argument.description === "string" ? { description: argument.description } : {}) }; }), descriptor });
    }
    const diagnostics: RemoteMcpDiagnostic[] = [
      { code: "MCP_CATALOG_PUSH_UNSUPPORTED", message: "Catalog updates use bounded cache expiry and explicit refresh. Persistent subscription streams are unavailable." },
      { code: "MCP_CLIENT_CAPABILITIES_UNSUPPORTED", message: "Sampling, elicitation, roots, MCP tasks and subscriptions are unavailable." },
    ];
    if (capabilities.resources) diagnostics.push({ code: "MCP_RESOURCE_READ_REQUIRES_POLICY", message: "Resource inventory is available. Reading requires a separately authorized resource binding." });
    if (capabilities.prompts) diagnostics.push({ code: "MCP_PROMPT_ACTIVATION_REQUIRES_POLICY", message: "Prompt inventory is available. Activation requires an explicit reviewed prompt binding." });
    const inventory = { protocolVersion: version, transport: currentTransport, tools, ...inventories, serverCapabilities: capabilities, diagnostics };
    return { ...inventory, digest: requestDigest(inventory), attempts };
  } catch (error) {
    if(scopeChallenge)throw new RemoteMcpError("OAUTH_SCOPE_REQUIRED",[],scopeChallenge);
    if (error instanceof RemoteMcpError) throw error;
    return fail(networkFailure ?? (controller.signal.aborted ? "DEADLINE" : "MCP_PROTOCOL"));
  } finally {
    clearTimeout(timer); controller.abort();
    await client.close().catch(() => undefined);
    for (const request of active) request.destroy();
  }
}

async function main() {
  const decoder = new StringDecoder("utf8"); let input = "";
  for await (const chunk of process.stdin) { input += decoder.write(chunk); if (Buffer.byteLength(input) > 262144) fail("REQUEST_LIMIT"); }
  input += decoder.end();
  try {
    const value = await runJob(JSON.parse(input), async attempt => {
      process.stdout.write(JSON.stringify({ event: "attempt", value: attempt }) + "\n");
      const acknowledgment = Buffer.alloc(3); let offset = 0;
      while (offset < 3) { const bytes = readSync(3, acknowledgment, offset, 3 - offset, null); if (!bytes) fail("CONNECTED_ATTEMPT_DENIED"); offset += bytes; }
      if (acknowledgment.toString() !== "ok\n") fail("CONNECTED_ATTEMPT_DENIED");
    });
    const usage = process.resourceUsage();
    process.stdout.write(JSON.stringify({ ok: true, value: { ...value, metrics: { peakRssBytes: usage.maxRSS * 1024, cpuMs: (usage.userCPUTime + usage.systemCPUTime) / 1000 } } }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error instanceof RemoteMcpError ? error.code : "MCP_PROTOCOL",...(error instanceof RemoteMcpError&&error.scopeChallenge?{scopeChallenge:error.scopeChallenge}:{}) }) + "\n");
  }
}
if (require.main === module && process.argv.includes("--remote-mcp-worker")) void main().catch(() => process.stdout.write('{"ok":false,"code":"MCP_PROTOCOL"}\n'));
