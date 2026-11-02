import type { FastifyReply, FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import type { RequestContext } from "../identity/request-context.js";
import { ApiError } from "../error.js";
import { apiJson } from "../json.js";
import { listGrowthOperations } from "./policy.js";
import { auditGrowthAccess } from "./telemetry.js";
import { growthToolArguments, growthToolInputSchema } from "./transport.js";
import { executeGrowthOperation } from "./reviews.js";

export const MCP_2026_VERSION = "2026-07-28";
const VERSION_META = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
const MAX_RESULT_BYTES = 256 * 1024;
type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isMcp2026Request(request: Pick<FastifyRequest, "headers" | "body">): boolean {
  const body = request.body;
  const params = object(body) && object(body.params) ? body.params : undefined;
  const meta = params && object(params._meta) ? params._meta : undefined;
  const header = request.headers["mcp-protocol-version"];
  return typeof header === "string" && /^\d{4}-\d{2}-\d{2}$/.test(header) && header >= MCP_2026_VERSION ||
    meta?.[VERSION_META] === MCP_2026_VERSION || object(body) && body.method === "server/discover";
}

/** Standard mirrored headers follow the 2026 HTTP binding, including encoded names. */
function decodedNameHeader(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[\x20-\x7e]+$/.test(value) || value.trim() !== value) return undefined;
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const encoded = value.slice(9, -2);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  const decoded = bytes.toString("utf8");
  return Buffer.from(decoded).equals(bytes) ? decoded : undefined;
}

export function growthMcpToolResult(value: JsonObject) {
  const output = JSON.parse(apiJson(value)) as JsonObject;
  const text = JSON.stringify(output);
  if (Buffer.byteLength(text) > MAX_RESULT_BYTES) throw new ApiError(413, "operation_result_too_large", "Narrow the requested range or page size");
  return { content: [{ type: "text" as const, text }], structuredContent: output, isError: value.state === "uncertain" };
}

export async function growthMcpToolList(core: CoreContext, context: RequestContext) {
  return auditGrowthAccess(core, context, "discovery", async () => ({ tools: (await listGrowthOperations(core, context)).map(operation => ({
    name: operation.name, description: operation.description,
    inputSchema: growthToolInputSchema(operation), outputSchema: operation.outputSchema,
    annotations: { readOnlyHint: operation.effect === "read", destructiveHint: operation.effect === "destructive",
      idempotentHint: operation.idempotency === "required", openWorldHint: operation.effect === "external_effect" },
  })) }));
}

/** Modern per-request metadata uses the same authorized operation entry point as legacy MCP. */
export async function handleGrowthMcp2026(core: CoreContext, context: RequestContext, request: FastifyRequest, reply: FastifyReply) {
  const body = request.body;
  const id = object(body) && (typeof body.id === "string" || typeof body.id === "number") ? body.id : null;
  const fail = (code: number, message: string, status = 200, data?: JsonObject) => reply.code(status).send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
  if (!object(body) || body.jsonrpc !== "2.0" || id === null ||
      typeof body.method !== "string" || !object(body.params) || !object(body.params._meta)) return fail(-32600, "Invalid MCP request", 400);
  const params = body.params;
  const meta = params._meta as JsonObject;
  if (typeof meta[VERSION_META] !== "string" || meta[VERSION_META] !== request.headers["mcp-protocol-version"])
    return fail(-32020, "MCP protocol metadata and header must agree", 400);
  if (meta[VERSION_META] !== MCP_2026_VERSION)
    return fail(-32022, "Unsupported MCP protocol version", 400, { supported: [MCP_2026_VERSION, "2025-11-25"], requested: meta[VERSION_META] });
  if (request.headers["mcp-method"] !== body.method)
    return fail(-32020, "MCP method metadata and header must agree", 400);
  const needsName = ["tools/call", "resources/read", "prompts/get"].includes(body.method);
  const name = body.method === "resources/read" ? params.uri : params.name;
  if (needsName && (typeof name !== "string" || decodedNameHeader(request.headers["mcp-name"]) !== name))
    return fail(-32020, "MCP name metadata and header must agree", 400);
  if (!object(meta[CAPABILITIES_META])) return fail(-32602, "MCP client capabilities are required", 400);
  request.log.info({ event: "growth.mcp.request", protocol_version: MCP_2026_VERSION }, "Growth MCP request");
  reply.header("Cache-Control", "no-store");
  try {
    let result: unknown;
    switch (body.method) {
      case "server/discover":
        result = { resultType: "complete", supportedVersions: [MCP_2026_VERSION, "2025-11-25"], capabilities: { tools: {} },
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "kasitek-growth", version: "1.3.0" } } }; break;
      case "ping": result = { resultType: "complete" }; break;
      case "tools/list": result = { resultType: "complete", ...await growthMcpToolList(core, context) }; break;
      case "tools/call": {
        if (typeof params.name !== "string" || params.name.length > 200 || params.arguments !== undefined && !object(params.arguments))
          throw new ApiError(422, "operation_arguments_invalid", "Invalid tool arguments");
        if (params.inputResponses !== undefined || params.requestState !== undefined)
          throw new ApiError(409, "operation_arguments_invalid", "This confirmation flow has been retired. Call the requested action directly.");
        const invocation = growthToolArguments(params.arguments as JsonObject | undefined ?? {});
        const value = await executeGrowthOperation(core, context, { operation: params.name, ...invocation });
        result = { resultType: "complete", ...growthMcpToolResult(value) }; break;
      }
      default: return fail(-32601, "MCP method not supported", 404);
    }
    return reply.send({ jsonrpc: "2.0", id, result });
  } catch (error) {
    const value = { code: error instanceof ApiError ? error.code : "internal_error",
      message: error instanceof ApiError ? error.message : "Could not complete the Growth operation" };
    request.log.warn({ event: "growth.operation.failed", protocol_version: MCP_2026_VERSION, error_type: value.code }, "Growth MCP request failed");
    return reply.send({ jsonrpc: "2.0", id, result: { resultType: "complete", isError: true,
      content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value } });
  }
}
