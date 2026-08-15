import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import {
  inspectMcpRequest,
  MCP_COMPATIBILITY_PROTOCOL_VERSION,
  MCP_STATELESS_PROTOCOL_VERSION,
  mcpEnvelopeSchema,
  validateStatelessRequest,
} from "../mcp/protocol";

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MCP_PROBE_METADATA = {
  "io.modelcontextprotocol/protocolVersion": MCP_STATELESS_PROTOCOL_VERSION,
  // An empty capability object is deliberately used for probing: the bridge
  // makes no feature claims and does not invent a client identity.
  "io.modelcontextprotocol/clientCapabilities": {},
} as const;

export interface StdioProtocolSupport {
  supportsStateless: boolean;
  supportsCompatibility: boolean;
}

async function readBoundedText(response: Response): Promise<string> {
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) throw new Error("mcp_response_too_large");
  return body;
}

/**
 * Probe discovery once before forwarding an old client. This is read-only and
 * never upgrades the client's message: it only prevents sending an old
 * initialize request to a modern-only endpoint. Older endpoints that do not
 * implement discovery deterministically fall back to compatibility mode.
 */
export async function probeStdioProtocol(input: {
  endpoint: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<StdioProtocolSupport> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_STATELESS_PROTOCOL_VERSION,
      "mcp-method": "server/discover",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "stdio-probe", method: "server/discover", params: { _meta: MCP_PROBE_METADATA } }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readBoundedText(response);
  let payload: unknown;
  try {
    payload = body ? JSON.parse(body) : undefined;
  } catch {
    throw new Error("mcp_probe_invalid_response");
  }
  const supported = payload && typeof payload === "object" && "result" in payload
    ? (payload as { result?: { supportedVersions?: unknown } }).result?.supportedVersions
    : payload && typeof payload === "object" && "error" in payload
      ? (payload as { error?: { data?: { supported?: unknown } } }).error?.data?.supported
      : undefined;
  if (Array.isArray(supported) && supported.every((value) => typeof value === "string")) {
    return {
      supportsStateless: supported.includes(MCP_STATELESS_PROTOCOL_VERSION),
      supportsCompatibility: supported.includes(MCP_COMPATIBILITY_PROTOCOL_VERSION),
    };
  }
  // A legacy server is allowed to answer method-not-found without a version
  // list. Treat that as compatibility-capable, but never treat an unrelated
  // transport/auth failure as a protocol downgrade.
  const errorCode = payload && typeof payload === "object" && "error" in payload
    ? (payload as { error?: { code?: unknown } }).error?.code
    : undefined;
  if (response.status === 404 || response.status === 405 || errorCode === -32601 || errorCode === -32022) {
    return { supportsStateless: false, supportsCompatibility: true };
  }
  if (!response.ok) throw new Error(`mcp_probe_http_${response.status}`);
  return { supportsStateless: false, supportsCompatibility: true };
}
export interface StdioForwardInput {
  endpoint: string;
  token: string;
  message: unknown;
  fetchImpl?: typeof fetch;
}

export async function forwardStdioMessage(input: StdioForwardInput): Promise<string | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const parsed = mcpEnvelopeSchema.safeParse(input.message);
  const inspection = parsed.success ? inspectMcpRequest(parsed.data) : undefined;
  const isStateless = inspection?.era === "stateless_2026";
  if (isStateless && parsed.success) validateStatelessRequest({ body: parsed.data, transport: "stdio" });
  const response = await fetchImpl(input.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      accept: isStateless ? "application/json, text/event-stream" : "application/json",
      "mcp-protocol-version": isStateless ? MCP_STATELESS_PROTOCOL_VERSION : MCP_COMPATIBILITY_PROTOCOL_VERSION,
    },
    body: JSON.stringify(input.message),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readBoundedText(response);
  if (!response.ok) throw new Error(`mcp_gateway_http_${response.status}`);
  return body.length > 0 ? body : null;
}

export async function runStdioBridge(input: {
  endpoint: string;
  token: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  fetchImpl?: typeof fetch;
  /** Probe once before an old client message; defaults on for hosted safety. */
  probeProtocol?: boolean;
}): Promise<void> {
  const source = input.input ?? stdin;
  const destination = input.output ?? stdout;
  const reader = createInterface({ input: source, crlfDelay: Infinity });
  let protocolSupport: StdioProtocolSupport | undefined;
  let probed = false;
  for await (const line of reader) {
    if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
      destination.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32011, message: "mcp_request_too_large" } })}\n`);
      continue;
    }
    let message: unknown;
    let envelope: ReturnType<typeof mcpEnvelopeSchema.parse>;
    try {
      message = JSON.parse(line);
      envelope = mcpEnvelopeSchema.parse(message);
    } catch {
      destination.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid_mcp_request" } })}\n`);
      continue;
    }
    try {
      const inspection = inspectMcpRequest(envelope);
      if (!inspection || inspection.era !== "stateless_2026") {
        if (!probed && input.probeProtocol !== false) {
          protocolSupport = await probeStdioProtocol({ endpoint: input.endpoint, token: input.token, fetchImpl: input.fetchImpl });
          probed = true;
        }
        if (protocolSupport && !protocolSupport.supportsCompatibility && protocolSupport.supportsStateless) {
          throw new Error("mcp_compatibility_protocol_unavailable");
        }
      }
      const response = await forwardStdioMessage({ endpoint: input.endpoint, token: input.token, message, fetchImpl: input.fetchImpl });
      if (response) destination.write(`${response}\n`);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "agent_platform_unavailable";
      destination.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: messageText } })}\n`);
    }
  }
}

if (process.argv[1]?.endsWith("stdio.js") || process.argv[1]?.endsWith("stdio.ts")) {
  if (typeof process.loadEnvFile === "function") process.loadEnvFile(".env");
  const endpoint = process.env.MCP_STDIO_URL?.trim() || "http://127.0.0.1:4200/mcp";
  const token = process.env.MCP_STDIO_TOKEN?.trim();
  const probeProtocol = process.env.MCP_STDIO_PROBE?.trim().toLowerCase() !== "false";
  if (!token) {
    process.stderr.write("MCP_STDIO_TOKEN is required\n");
    process.exitCode = 1;
  } else {
    runStdioBridge({ endpoint, token, probeProtocol }).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "stdio_bridge_failed"}\n`);
      process.exitCode = 1;
    });
  }
}
