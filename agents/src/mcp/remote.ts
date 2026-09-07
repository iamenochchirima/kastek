import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { redactSensitiveValue } from "../tools/redaction";

const MAX_REMOTE_TOOL_SCHEMA_BYTES = 100_000;
const MAX_REMOTE_TOOLS = 100;

export const remoteMcpToolSchema = z.object({
  name: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  description: z.string().trim().max(2_000).default("Remote MCP tool"),
  inputSchema: z.record(z.string(), z.unknown()).default({ type: "object", properties: {}, additionalProperties: false }),
}).strict();
export type RemoteMcpTool = z.infer<typeof remoteMcpToolSchema>;

export const remoteMcpToolsSchema = z.array(remoteMcpToolSchema).max(MAX_REMOTE_TOOLS);

export interface RemoteMcpProviderSettings {
  endpointUrl: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

export function validateRemoteMcpEndpoint(raw: string, environment: "development" | "test" | "production" = "production"): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("REMOTE_MCP_ENDPOINT_INVALID");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) throw new Error("REMOTE_MCP_ENDPOINT_CREDENTIALS_NOT_ALLOWED");
  if (endpoint.protocol !== "https:" && !(environment !== "production" && endpoint.protocol === "http:")) {
    throw new Error("REMOTE_MCP_ENDPOINT_HTTPS_REQUIRED");
  }
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    if (environment === "production") throw new Error("REMOTE_MCP_ENDPOINT_PRIVATE_NETWORK");
  }
  if (isPrivateAddress(hostname) && environment === "production") throw new Error("REMOTE_MCP_ENDPOINT_PRIVATE_NETWORK");
  return endpoint;
}

/** DNS validation closes the common hostname-to-private-address SSRF path. */
export async function resolveRemoteMcpEndpoint(raw: string, environment: "development" | "test" | "production" = "production"): Promise<URL> {
  const endpoint = validateRemoteMcpEndpoint(raw, environment);
  if (environment !== "production" || isIP(endpoint.hostname)) return endpoint;
  const addresses = await lookup(endpoint.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((address) => isPrivateAddress(address.address))) {
    throw new Error("REMOTE_MCP_ENDPOINT_PRIVATE_NETWORK");
  }
  return endpoint;
}

export async function discoverRemoteMcpTools(input: {
  endpointUrl: string;
  authorizationToken?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  environment?: "development" | "test" | "production";
  signal?: AbortSignal;
}): Promise<{ protocolVersion: string; tools: RemoteMcpTool[] }> {
  const endpoint = await resolveRemoteMcpEndpoint(input.endpointUrl, input.environment ?? "production");
  const headers = remoteHeaders(input.authorizationToken);
  let sessionId: string | undefined;
  try {
    const initialized = await remoteJsonRpc(endpoint, {
      jsonrpc: "2.0",
      id: "kasitek-initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "kasitek-agent-platform", version: "1" },
      },
    }, headers, input.timeoutMs, input.maxResponseBytes, input.signal);
    sessionId = initialized.sessionId;
  } catch (error) {
    // Some stateless MCP providers do not implement initialize. Their tools
    // endpoint is still safe to inspect independently.
    if (!isMethodUnsupported(error)) throw error;
  }
  const listed = await remoteJsonRpc(endpoint, {
    jsonrpc: "2.0",
    id: "kasitek-tools-list",
    method: "tools/list",
    params: {},
  }, { ...headers, ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) }, input.timeoutMs, input.maxResponseBytes, input.signal);
  const result = listed.result && typeof listed.result === "object" && !Array.isArray(listed.result) ? listed.result as Record<string, unknown> : {};
  const tools = remoteMcpToolsSchema.parse(result.tools ?? []);
  for (const tool of tools) {
    if (JSON.stringify(tool.inputSchema).length > MAX_REMOTE_TOOL_SCHEMA_BYTES) throw new Error("REMOTE_MCP_TOOL_SCHEMA_TOO_LARGE");
  }
  return { protocolVersion: typeof listed.protocolVersion === "string" ? listed.protocolVersion : "2025-06-18", tools };
}

export async function callRemoteMcpTool(input: {
  endpointUrl: string;
  toolName: string;
  argumentsValue: Record<string, unknown>;
  authorizationToken?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  environment?: "development" | "test" | "production";
  signal?: AbortSignal;
}): Promise<unknown> {
  const endpoint = await resolveRemoteMcpEndpoint(input.endpointUrl, input.environment ?? "production");
  const response = await remoteJsonRpc(endpoint, {
    jsonrpc: "2.0",
    id: "kasitek-tools-call",
    method: "tools/call",
    params: { name: input.toolName, arguments: input.argumentsValue },
  }, remoteHeaders(input.authorizationToken), input.timeoutMs, input.maxResponseBytes, input.signal);
  if (response.error) throw new Error("REMOTE_MCP_TOOL_FAILED");
  return redactSensitiveValue(response.result ?? {});
}

async function remoteJsonRpc(endpoint: URL, body: Record<string, unknown>, headers: Record<string, string>, timeoutMs: number, maxResponseBytes: number, signal?: AbortSignal): Promise<{ result?: unknown; error?: unknown; protocolVersion?: string; sessionId?: string }> {
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    headers: { ...headers, accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  const raw = await readBoundedResponse(response, maxResponseBytes);
  if (!response.ok) {
    const error = new Error(`REMOTE_MCP_HTTP_${response.status}`);
    Object.assign(error, { statusCode: response.status });
    throw error;
  }
  const parsed = parseRemoteResponse(raw);
  if (parsed.error) throw Object.assign(new Error("REMOTE_MCP_RPC_ERROR"), { rpcError: parsed.error });
  return {
    result: parsed.result,
    error: parsed.error,
    protocolVersion: typeof (parsed.result as Record<string, unknown> | undefined)?.protocolVersion === "string" ? (parsed.result as Record<string, string>).protocolVersion : undefined,
    sessionId: response.headers.get("mcp-session-id") ?? undefined,
  };
}

function remoteHeaders(token: string | undefined): Record<string, string> {
  return token?.trim() ? { authorization: `Bearer ${token.trim()}`, "content-type": "application/json" } : { "content-type": "application/json" };
}

function parseRemoteResponse(raw: string): { result?: unknown; error?: unknown } {
  const candidates = raw.trim().startsWith("data:")
    ? raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean)
    : [raw];
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate) as { result?: unknown; error?: unknown };
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Continue until the last complete SSE event or JSON body is found.
    }
  }
  throw new Error("REMOTE_MCP_RESPONSE_INVALID");
}

async function readBoundedResponse(response: Response, limit: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new Error("REMOTE_MCP_RESPONSE_TOO_LARGE");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("REMOTE_MCP_RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isMethodUnsupported(error: unknown): boolean {
  const statusCode = (error as { statusCode?: number }).statusCode;
  return statusCode === 400 || statusCode === 404 || statusCode === 405 || error instanceof Error && error.message === "REMOTE_MCP_RPC_ERROR";
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 10
    || octets[0] === 127
    || octets[0] === 169 && octets[1] === 254
    || octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31
    || octets[0] === 192 && octets[1] === 168;
}
