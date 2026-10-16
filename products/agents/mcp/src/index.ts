#!/usr/bin/env node

import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

export const DEFAULT_MCP_URL = "http://127.0.0.1:4200/mcp";
export const COMPATIBILITY_PROTOCOL_VERSION = "2025-06-18";
export const STATELESS_PROTOCOL_VERSION = "2026-07-28";

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

export type FetchLike = typeof fetch;

export interface McpBridgeConfig {
  endpoint: string;
  apiKey: string;
}

export interface ForwardMcpMessageInput extends McpBridgeConfig {
  message: unknown;
  fetchImpl?: FetchLike;
}

export interface RunStdioBridgeInput extends McpBridgeConfig {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  fetchImpl?: FetchLike;
  probeProtocol?: boolean;
}

export interface McpProtocolSupport {
  supportsStateless: boolean;
  supportsCompatibility: boolean;
}

export class McpBridgeError extends Error {
  readonly rpcCode: number;

  constructor(message: string, rpcCode = -32000) {
    super(message);
    this.name = "McpBridgeError";
    this.rpcCode = rpcCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseMessage(message: unknown): JsonRpcMessage {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || !message.method.trim()) {
    throw new McpBridgeError("invalid_mcp_request", -32600);
  }
  if (message.params !== undefined && !isRecord(message.params)) {
    throw new McpBridgeError("invalid_mcp_params", -32602);
  }
  return message as unknown as JsonRpcMessage;
}

function protocolVersion(message: JsonRpcMessage): string {
  const metadata = message.params?._meta;
  if (!isRecord(metadata)) return COMPATIBILITY_PROTOCOL_VERSION;
  const version = metadata["io.modelcontextprotocol/protocolVersion"];
  return typeof version === "string" && version.trim()
    ? version
    : COMPATIBILITY_PROTOCOL_VERSION;
}

function hasResponseId(message: JsonRpcMessage): boolean {
  return Object.prototype.hasOwnProperty.call(message, "id");
}

function requestHeaders(message: JsonRpcMessage, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": protocolVersion(message),
    "mcp-method": message.method,
  };
  const name = message.method === "resources/read"
    ? message.params?.uri
    : message.params?.name;
  if (typeof name === "string" && name.trim()) headers["mcp-name"] = name;
  return headers;
}

async function boundedBody(response: Response): Promise<string> {
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    throw new McpBridgeError("mcp_response_too_large");
  }
  return body;
}

export async function forwardMcpMessage(input: ForwardMcpMessageInput): Promise<string | null> {
  if (!input.endpoint.trim()) throw new McpBridgeError("mcp_endpoint_required", -32602);
  if (!input.apiKey.trim()) throw new McpBridgeError("kasitek_api_key_required", -32001);
  const message = parseMessage(input.message);
  const version = protocolVersion(message);
  if (![COMPATIBILITY_PROTOCOL_VERSION, STATELESS_PROTOCOL_VERSION].includes(version)) {
    throw new McpBridgeError("mcp_unsupported_protocol_version", -32022);
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(input.endpoint, {
      method: "POST",
      headers: requestHeaders(message, input.apiKey),
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new McpBridgeError("mcp_gateway_unreachable");
  }

  const body = await boundedBody(response);
  if (!response.ok) throw new McpBridgeError(`mcp_gateway_http_${response.status}`);
  return body.length > 0 ? body : null;
}

export async function probeMcpProtocol(input: {
  endpoint: string;
  apiKey: string;
  fetchImpl?: FetchLike;
}): Promise<McpProtocolSupport> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": STATELESS_PROTOCOL_VERSION,
      "mcp-method": "server/discover",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "stdio-probe",
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": STATELESS_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await boundedBody(response);
  let payload: unknown;
  try {
    payload = body ? JSON.parse(body) : undefined;
  } catch {
    throw new McpBridgeError("mcp_probe_invalid_response");
  }

  const supported = isRecord(payload) && isRecord(payload.result)
    ? payload.result.supportedVersions
    : isRecord(payload) && isRecord(payload.error) && isRecord(payload.error.data)
      ? payload.error.data.supported
      : undefined;
  if (Array.isArray(supported) && supported.every((value) => typeof value === "string")) {
    return {
      supportsStateless: supported.includes(STATELESS_PROTOCOL_VERSION),
      supportsCompatibility: supported.includes(COMPATIBILITY_PROTOCOL_VERSION),
    };
  }

  const errorCode = isRecord(payload) && isRecord(payload.error) ? payload.error.code : undefined;
  if (response.status === 404 || response.status === 405 || errorCode === -32601 || errorCode === -32022) {
    return { supportsStateless: false, supportsCompatibility: true };
  }
  if (!response.ok) throw new McpBridgeError(`mcp_probe_http_${response.status}`);
  return { supportsStateless: false, supportsCompatibility: true };
}

function writeError(output: NodeJS.WritableStream, id: string | number | null, error: unknown): void {
  const message = error instanceof McpBridgeError ? error.message : "mcp_bridge_failed";
  const code = error instanceof McpBridgeError ? error.rpcCode : -32000;
  output.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

export async function runStdioBridge(input: RunStdioBridgeInput): Promise<void> {
  const source = input.input ?? stdin;
  const output = input.output ?? stdout;
  const reader = createInterface({ input: source, crlfDelay: Infinity });
  let protocolSupport: McpProtocolSupport | undefined;
  let probed = false;

  for await (const line of reader) {
    if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
      writeError(output, null, new McpBridgeError("mcp_request_too_large", -32011));
      continue;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      writeError(output, null, new McpBridgeError("invalid_mcp_request", -32600));
      continue;
    }

    let parsed: JsonRpcMessage;
    try {
      parsed = parseMessage(message);
      if (protocolVersion(parsed) === COMPATIBILITY_PROTOCOL_VERSION && !probed && input.probeProtocol !== false) {
        protocolSupport = await probeMcpProtocol({ endpoint: input.endpoint, apiKey: input.apiKey, fetchImpl: input.fetchImpl });
        probed = true;
      }
      if (protocolSupport && !protocolSupport.supportsCompatibility && protocolSupport.supportsStateless) {
        throw new McpBridgeError("mcp_compatibility_protocol_unavailable");
      }
      const response = await forwardMcpMessage({ ...input, message: parsed });
      if (response && hasResponseId(parsed)) output.write(`${response}\n`);
    } catch (error) {
      const hasId = isRecord(message) && Object.prototype.hasOwnProperty.call(message, "id");
      if (hasId) {
        writeError(output, isRecord(message) && (typeof message.id === "string" || typeof message.id === "number" || message.id === null) ? message.id : null, error);
      }
    }
  }
}

export function resolveCliConfig(env: NodeJS.ProcessEnv = process.env): McpBridgeConfig {
  return {
    endpoint: env.KASITEK_MCP_URL?.trim() || env.MCP_STDIO_URL?.trim() || DEFAULT_MCP_URL,
    apiKey: env.KASITEK_API_KEY?.trim() || env.MCP_STDIO_API_KEY?.trim() || env.KASITEK_MCP_TOKEN?.trim() || env.MCP_STDIO_TOKEN?.trim() || "",
  };
}

async function main(): Promise<void> {
  const config = resolveCliConfig();
  if (!config.apiKey) {
    process.stderr.write("KASITEK_API_KEY is required\n");
    process.exitCode = 1;
    return;
  }
  await runStdioBridge(config);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "mcp_bridge_failed"}\n`);
    process.exitCode = 1;
  });
}
