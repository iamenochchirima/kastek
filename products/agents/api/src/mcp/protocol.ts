import { z } from "zod";

/**
 * MCP protocol revisions supported by the Agent Platform.
 *
 * 2026-07-28 is the per-request, stateless protocol core. 2025-06-18 is
 * retained as an explicit compatibility era while existing clients migrate.
 */
export const MCP_STATELESS_PROTOCOL_VERSION = "2026-07-28" as const;
export const MCP_COMPATIBILITY_PROTOCOL_VERSION = "2025-06-18" as const;
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  MCP_STATELESS_PROTOCOL_VERSION,
  MCP_COMPATIBILITY_PROTOCOL_VERSION,
] as const;
export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks" as const;

export type McpProtocolVersion = (typeof MCP_SUPPORTED_PROTOCOL_VERSIONS)[number];
export type McpEra = "stateless_2026" | "pre_2026_compatibility";

const identifierSchema = z.object({
  name: z.string().trim().min(1).max(160),
  version: z.string().trim().min(1).max(80),
}).passthrough();

export const mcpEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1).max(120),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const statelessMetadataSchema = z.object({
  "io.modelcontextprotocol/protocolVersion": z.literal(MCP_STATELESS_PROTOCOL_VERSION),
  "io.modelcontextprotocol/clientCapabilities": z.record(z.string(), z.unknown()),
  "io.modelcontextprotocol/clientInfo": identifierSchema.optional(),
}).passthrough();

export type McpEnvelope = z.infer<typeof mcpEnvelopeSchema>;
export type StatelessMetadata = z.infer<typeof statelessMetadataSchema>;

export interface McpHeaders {
  [name: string]: string | string[] | undefined;
}

export interface StatelessRequestInspection {
  era: McpEra;
  bodyProtocolVersion?: string;
  headerProtocolVersion?: string;
  metadata?: StatelessMetadata;
}

export class McpProtocolError extends Error {
  readonly statusCode: number;
  readonly rpcCode: number;
  readonly data?: unknown;

  constructor(input: { statusCode: number; rpcCode: number; message: string; data?: unknown }) {
    super(input.message);
    this.name = "McpProtocolError";
    this.statusCode = input.statusCode;
    this.rpcCode = input.rpcCode;
    this.data = input.data;
  }
}

export function firstHeader(headers: McpHeaders, name: string): string | undefined {
  const expected = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === expected);
  if (!key) return undefined;
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
}

function metadataFromEnvelope(body: McpEnvelope): unknown {
  const metadata = body.params?.["_meta"];
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function inspectMcpRequest(body: McpEnvelope, headers: McpHeaders = {}): StatelessRequestInspection {
  const metadataValue = metadataFromEnvelope(body);
  const bodyProtocolVersion = metadataValue && typeof metadataValue === "object"
    ? stringValue((metadataValue as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"])
    : undefined;
  const headerProtocolVersion = firstHeader(headers, "MCP-Protocol-Version");
  const claimsStateless = bodyProtocolVersion !== undefined
    || headerProtocolVersion === MCP_STATELESS_PROTOCOL_VERSION;
  if (!claimsStateless) {
    return {
      era: "pre_2026_compatibility",
      bodyProtocolVersion,
      headerProtocolVersion,
    };
  }
  let metadata: StatelessMetadata | undefined;
  if (metadataValue !== undefined) {
    const parsed = statelessMetadataSchema.safeParse(metadataValue);
    if (parsed.success) metadata = parsed.data;
  }
  return {
    era: "stateless_2026",
    bodyProtocolVersion,
    headerProtocolVersion,
    metadata,
  };
}

function headerMismatch(message: string, data?: unknown): McpProtocolError {
  return new McpProtocolError({
    statusCode: 400,
    rpcCode: -32020,
    message,
    data,
  });
}

export function unsupportedProtocolVersion(
  requested: string | undefined,
  supported: readonly string[] = MCP_SUPPORTED_PROTOCOL_VERSIONS,
): McpProtocolError {
  return new McpProtocolError({
    statusCode: 400,
    rpcCode: -32022,
    message: "Unsupported protocol version",
    data: {
      supported: [...supported],
      ...(requested ? { requested } : {}),
    },
  });
}

function requireAsciiHeaderValue(name: string, value: string): void {
  // HTTP field values may contain visible ASCII plus SP/HTAB. Reject control
  // characters here before any value reaches a proxy or an audit/log sink.
  if (!/^[\x20-\x7e\t]*$/.test(value)) {
    throw headerMismatch(`Invalid ${name} header value`);
  }
}

function decodeHeaderValue(value: string): string {
  const match = /^=\?base64\?([^?]*)\?=$/.exec(value);
  if (!match) return value;
  try {
    const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64") !== match[1]) return value;
    return decoded;
  } catch {
    return value;
  }
}

function requiredNameForRequest(body: McpEnvelope): string | undefined {
  if (body.method === "tools/call" || body.method === "prompts/get") {
    return stringValue(body.params?.name);
  }
  if (body.method === "resources/read") {
    return stringValue(body.params?.uri);
  }
  return undefined;
}

/** Validate the per-request 2026 contract. HTTP requires mirrored headers; stdio does not. */
export function validateStatelessRequest(input: {
  body: McpEnvelope;
  headers?: McpHeaders;
  transport: "http" | "stdio";
}): StatelessMetadata {
  const metadataValue = metadataFromEnvelope(input.body);
  const requestedVersion = metadataValue && typeof metadataValue === "object"
    ? stringValue((metadataValue as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"])
    : undefined;
  if (requestedVersion && requestedVersion !== MCP_STATELESS_PROTOCOL_VERSION) {
    throw unsupportedProtocolVersion(requestedVersion);
  }
  const metadata = statelessMetadataSchema.safeParse(metadataValue);
  if (!metadata.success) {
    throw headerMismatch("Missing or invalid stateless MCP request metadata", {
      issues: metadata.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    });
  }
  const protocolVersion = metadata.data["io.modelcontextprotocol/protocolVersion"];
  if (protocolVersion !== MCP_STATELESS_PROTOCOL_VERSION) {
    throw unsupportedProtocolVersion(protocolVersion);
  }
  if (input.transport === "stdio") return metadata.data;

  const protocolHeader = firstHeader(input.headers ?? {}, "MCP-Protocol-Version");
  if (!protocolHeader || protocolHeader !== protocolVersion) {
    throw headerMismatch("MCP-Protocol-Version does not match request metadata", {
      header: protocolHeader ?? null,
      body: protocolVersion,
    });
  }
  const methodHeader = firstHeader(input.headers ?? {}, "Mcp-Method");
  if (!methodHeader || methodHeader !== input.body.method) {
    throw headerMismatch("Mcp-Method does not match request method", {
      header: methodHeader ?? null,
      body: input.body.method,
    });
  }
  requireAsciiHeaderValue("Mcp-Method", methodHeader);
  const acceptHeader = firstHeader(input.headers ?? {}, "accept") ?? "";
  if (!acceptHeader.toLowerCase().includes("application/json") || !acceptHeader.toLowerCase().includes("text/event-stream")) {
    throw headerMismatch("Accept must include application/json and text/event-stream");
  }
  for (const [headerName, rawValue] of Object.entries(input.headers ?? {})) {
    if (!headerName.toLowerCase().startsWith("mcp-param-")) continue;
    if (typeof rawValue !== "string") throw headerMismatch(`Invalid ${headerName} header value`);
    if (/(authorization|cookie|credential|password|secret|token|private|api[-_]?key)/i.test(headerName)) {
      throw headerMismatch(`Sensitive ${headerName} headers are not permitted`);
    }
    requireAsciiHeaderValue(headerName, rawValue);
    if (rawValue.startsWith("=?base64?") && decodeHeaderValue(rawValue) === rawValue) {
      throw headerMismatch(`Invalid ${headerName} header value`);
    }
  }
  const expectedName = requiredNameForRequest(input.body);
  if (expectedName !== undefined) {
    const nameHeader = firstHeader(input.headers ?? {}, "Mcp-Name");
    if (!nameHeader) throw headerMismatch("Mcp-Name is required for this method", { body: expectedName });
    requireAsciiHeaderValue("Mcp-Name", nameHeader);
    if (decodeHeaderValue(nameHeader) !== expectedName) {
      throw headerMismatch("Mcp-Name does not match request body", { header: nameHeader, body: expectedName });
    }
  }
  return metadata.data;
}

export function clientSupportsExtension(metadata: StatelessMetadata | undefined, extension: string): boolean {
  const capabilities = metadata?.["io.modelcontextprotocol/clientCapabilities"];
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return false;
  const extensions = (capabilities as Record<string, unknown>).extensions;
  return Boolean(extensions && typeof extensions === "object" && !Array.isArray(extensions)
    && Object.prototype.hasOwnProperty.call(extensions, extension));
}

export function responseMetadata(serverInfo: { name: string; version: string }): Record<string, unknown> {
  return { "io.modelcontextprotocol/serverInfo": serverInfo };
}

export function completeResult<T extends Record<string, unknown>>(
  value: T,
  options: { serverInfo?: { name: string; version: string } } = {},
): T & { resultType: "complete"; _meta?: Record<string, unknown> } {
  return {
    resultType: "complete",
    ...value,
    ...(options.serverInfo ? { _meta: responseMetadata(options.serverInfo) } : {}),
  };
}

export function cacheableResult<T extends Record<string, unknown>>(
  value: T,
  cache: { ttlMs: number; cacheScope: "public" | "private" },
  options: { serverInfo?: { name: string; version: string } } = {},
): T & { resultType: "complete"; ttlMs: number; cacheScope: "public" | "private"; _meta?: Record<string, unknown> } {
  return completeResult({ ...value, ttlMs: cache.ttlMs, cacheScope: cache.cacheScope }, options);
}

export const MCP_SERVER_INFO = Object.freeze({
  name: "kasitek-agent-platform",
  version: "1.0.0",
});
