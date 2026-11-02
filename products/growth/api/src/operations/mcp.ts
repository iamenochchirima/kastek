import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";
import { apiJson } from "../json.js";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { listGrowthOperations } from "./policy.js";
import { executeGrowthOperation } from "./reviews.js";
import { growthToolArguments, growthToolInputSchema, resolveGrowthOperationContext } from "./transport.js";
import { auditGrowthAccess } from "./telemetry.js";

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
    const server = new Server({ name: "kasitek-growth", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => auditGrowthAccess(core, context, "discovery", async () => ({ tools: (await listGrowthOperations(core, context)).map(operation => ({
      name: operation.name, description: operation.description,
      inputSchema: growthToolInputSchema(operation) as { type: "object" },
      outputSchema: operation.outputSchema as { type: "object" },
      annotations: { readOnlyHint: operation.effect === "read", destructiveHint: operation.effect === "destructive", idempotentHint: operation.idempotency === "required", openWorldHint: operation.effect === "external_effect" },
    })) })));
    server.setRequestHandler(CallToolRequestSchema, async call => {
      const started = Date.now();
      try {
        const args = growthToolArguments(call.params.arguments ?? {});
        const value = await executeGrowthOperation(core, context, { operation: call.params.name, ...args });
        const output = JSON.parse(apiJson(value));
        const text = JSON.stringify(output);
        if (Buffer.byteLength(text) > 256 * 1024) throw new ApiError(413, "operation_result_too_large", "Narrow the requested range or page size");
        request.log.info({ event: "growth.operation.completed", operation: call.params.name, duration_ms: Date.now() - started, outcome: value.state }, "Growth tool completed");
        return { content: [{ type: "text" as const, text }], structuredContent: output, isError: value.state === "uncertain" };
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
