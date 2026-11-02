import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";
import { apiJson } from "../json.js";
import { auditGrowthAccess } from "./telemetry.js";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { executeGrowthOperation, isContentPublicOperation } from "./reviews.js";
import { growthToolArguments, resolveGrowthOperationContext } from "./transport.js";
import { CONTENT_APP_TOOL_NAME, CONTENT_APP_MIME, contentMcpAppResourcesList, readContentMcpAppResource,
  invokeContentMcpAppControl, decorateContentMcpAppResult } from "./content-mcp-app.js";
import { growthMcpToolList, handleGrowthMcp2026, isMcp2026Request, sanitizeMcpChatResult } from "./mcp-2026.js";

export function registerGrowthMcpRoutes(app: FastifyInstance, core: CoreContext) {
  app.post("/mcp", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    const hosts = new Set([new URL(core.config.publicApiUrl).host, new URL(core.config.frontendUrl).host]);
    if (core.config.environment !== "production") {
      hosts.add(`localhost:${core.config.port}`); hosts.add(`127.0.0.1:${core.config.port}`); hosts.add(`[::1]:${core.config.port}`);
    }
    if (!hosts.has(request.headers.host?.toLowerCase() ?? "")) throw new ApiError(403, "host_denied", "MCP request host is not allowed");
    let context;
    try { context = await resolveGrowthOperationContext(core, request, true); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) reply.header("WWW-Authenticate", `Bearer resource_metadata="${core.config.publicApiUrl}/.well-known/oauth-protected-resource", scope="growth:read"`);
      throw error;
    }
    const origin = request.headers.origin;
    const origins = new Set([core.config.frontendUrl, ...(core.config.env.GROWTH_MCP_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean)]);
    if (origin && !origins.has(origin)) throw new ApiError(403, "origin_denied", "MCP request origin is not allowed");
    if (isMcp2026Request(request)) return handleGrowthMcp2026(core, context, request, reply);
    const version = request.headers["mcp-protocol-version"];
    request.log.info({ event: "growth.mcp.capabilities",
      protocol_version: typeof version === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(version) ? version : "legacy",
      content_form_supported: false, extended_form_supported: false }, "Growth MCP request capabilities");
    const envelope = request.body as { params?: { _meta?: Record<string, unknown> } } | undefined;
    const capabilities = envelope?.params?._meta?.["io.modelcontextprotocol/clientCapabilities"];
    const extensions = capabilities && typeof capabilities === "object" ? (capabilities as Record<string, unknown>).extensions : undefined;
    const ui = extensions && typeof extensions === "object" ? (extensions as Record<string, unknown>)["io.modelcontextprotocol/ui"] : undefined;
    const appUiSupported = !!ui && typeof ui === "object" && Array.isArray((ui as Record<string, unknown>).mimeTypes) &&
      ((ui as Record<string, unknown>).mimeTypes as unknown[]).includes(CONTENT_APP_MIME);
    const server = new Server({ name: "kasitek-growth", version: "1.2.0" }, { capabilities: { tools: {}, resources: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => growthMcpToolList(core, context, appUiSupported));
    server.setRequestHandler(ListResourcesRequestSchema, async () => auditGrowthAccess(core, context, "content.review.resources", async () => contentMcpAppResourcesList()));
    server.setRequestHandler(ReadResourceRequestSchema, async call => {
      const result = await auditGrowthAccess(core, context, "content.review.resource", async () => readContentMcpAppResource(call.params.uri, core.config.publicApiUrl));
      request.log.info({ event: "growth.mcp.resource.read", resource_version: "content-review-v1" }, "Growth content review resource read");
      return result;
    });
    server.setRequestHandler(CallToolRequestSchema, async call => {
      const started = Date.now();
      try {
        if (call.params.name === CONTENT_APP_TOOL_NAME) {
          if (!appUiSupported)
            throw new ApiError(409, "content_confirmation_unavailable", "This client does not support content confirmation");
          const result = await invokeContentMcpAppControl(core, context, call.params.arguments ?? {});
          if (Buffer.byteLength(apiJson(result)) > (appUiSupported ? 2 * 1024 * 1024 : 256 * 1024)) throw new ApiError(413, "operation_result_too_large", "Narrow the requested range or page size");
          return result;
        }
        const args = growthToolArguments(call.params.arguments ?? {});
        let value = await executeGrowthOperation(core, context, { operation: call.params.name, ...args });
        if (!appUiSupported && (isContentPublicOperation(call.params.name) || call.params.name === "content.actions.preview")) value = sanitizeMcpChatResult(value);
        const result = appUiSupported ? await decorateContentMcpAppResult(core, context, call.params.name, call.params.arguments ?? {}, value)
          : { content: [{type: "text" as const, text: apiJson(value)}], structuredContent: JSON.parse(apiJson(value)), isError: value.state === "uncertain" };
        if (Buffer.byteLength(apiJson(result)) > (appUiSupported ? 2 * 1024 * 1024 : 256 * 1024)) throw new ApiError(413, "operation_result_too_large", "Narrow the requested range or page size");
        request.log.info({ event: "growth.operation.completed", operation: call.params.name, duration_ms: Date.now() - started, outcome: value.state }, "Growth tool completed");
        return result;
      } catch (error) {
        request.log.warn({ event: "growth.operation.failed", operation: call.params.name, duration_ms: Date.now() - started, error_type: error instanceof ApiError ? error.code : "internal_error" }, "Growth tool failed");
        const value = { code: error instanceof ApiError ? error.code : "internal_error", message: error instanceof ApiError ? error.message : "Could not complete the Growth operation" };
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    reply.hijack();
    reply.raw.once("finish", () => { void transport.close(); void server.close(); });
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  app.get("/mcp", async (_request, reply) => reply.code(405).header("Allow", "POST").send({ error: "Use the MCP POST transport" }));
  app.delete("/mcp", async (_request, reply) => reply.code(405).header("Allow", "POST").send({ error: "This MCP transport has no resumable sessions" }));
}
