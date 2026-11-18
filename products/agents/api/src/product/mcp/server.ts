import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createHash } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { resolveAgentsOAuthToken } from "./oauth";
import { containsConnectorCredential } from "../../capabilities/connected-tools/credential-reflection";
import { projectMcpReferences, referenceAwareSchema, resolveMcpReferences } from "./references";
export type McpOperation = { name: string; description: string; scope: "agents:read" | "agents:manage" | "runs:read" | "runs:start"; inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }; idempotent?: boolean; openWorld?: boolean; run(scope: { accountId: string; organizationId: string; connectionId: string }, args: Record<string, unknown>): Promise<unknown> };

/** Each request resolves a revocable product-owned OAuth connection and current membership. */
export function registerAgentsMcp(app: FastifyInstance, options: { pool: Pool; publicUrl: string; operations: McpOperation[]; allowedOrigins: string[]; allowedHosts?: string[] }) {
 const resource = new URL("/mcp", options.publicUrl).toString();
 const hosts = new Set([new URL(options.publicUrl).host,...(options.allowedHosts??[])].map(host=>host.toLowerCase()));
 const metadata = () => ({ resource, authorization_servers: [new URL(options.publicUrl).origin], scopes_supported: ["agents:read", "agents:manage", "runs:read", "runs:start"], bearer_methods_supported: ["header"] });
 app.get("/.well-known/oauth-protected-resource", metadata);
 app.get("/.well-known/oauth-protected-resource/mcp", metadata);
 app.post("/mcp", { bodyLimit: 262144 }, async (request, reply) => {
  if (!hosts.has((request.headers.host ?? "").toLowerCase())) throw new PlatformError("HOST_DENIED", 403, "Host is not allowed");
  if (request.headers.origin && !options.allowedOrigins.includes(request.headers.origin)) throw new PlatformError("ORIGIN_DENIED", 403, "Origin is not allowed");
  const authorization = request.headers.authorization ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) { reply.header("WWW-Authenticate", `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", options.publicUrl)}"`); return reply.code(401).send({error:"invalid_token"}); }
  const access = await resolveAgentsOAuthToken(options.pool, match[1]!, resource);
  if (!access) return reply.code(401).send({ error: "invalid_token" });
  const scope = { accountId: access.accountId, organizationId: access.organizationId, connectionId: access.connectionId }, granted = new Set(access.scopes);
  const server = new Server({ name: "kasitek-agents", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: options.operations.filter(op => granted.has(op.scope)).map(op => ({
   name: op.name,
   description: op.description,
   inputSchema: referenceAwareSchema(op.inputSchema) as typeof op.inputSchema,
   // MCP annotations describe the tool; authorization is always enforced by OAuth and the operation.
   annotations: { readOnlyHint: op.scope === "agents:read" || op.scope === "runs:read", destructiveHint: false, ...(op.idempotent ? { idempotentHint: true } : {}), ...(op.openWorld ? { openWorldHint: true } : {}) },
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async call => {
   const op = options.operations.find(item => item.name === call.params.name && granted.has(item.scope));
   if (!op) return { isError: true, content: [{ type: "text", text: "Operation unavailable" }] };
   const started = performance.now();
   let completed = false;
   try {
    let value:unknown;
    const args=await resolveMcpReferences(options.pool,scope,call.params.arguments??{}) as Record<string,unknown>;
    if(op.scope === "agents:manage" || op.scope === "runs:start") {
     // Serialize admission with connection and membership revocation. The called product
     // operation retains its own transaction and authority checks; revocation cannot
     // commit between this check and that operation's commit.
     const db=await options.pool.connect();
     try {
      await db.query("BEGIN");
      const current=await db.query(`SELECT 1 FROM agents_platform.mcp_oauth_connections c JOIN agents_platform.memberships m ON m.organization_id=c.organization_id AND m.account_id=c.account_id
       WHERE c.id=$1 AND c.organization_id=$2 AND c.account_id=$3 AND c.access_hash=$4 AND c.revoked_at IS NULL AND c.access_expires_at>now()
       AND $5=ANY(c.scopes) AND m.revoked_at IS NULL FOR SHARE OF c,m`,[access.connectionId,scope.organizationId,scope.accountId,createHash("sha256").update(match[1]!).digest("hex"),op.scope]);
      if(!current.rowCount)throw new PlatformError("ACCESS_DENIED",403,"Connection access is unavailable");
      value=await op.run(scope,args);
      await db.query("COMMIT");
     } catch(error) {await db.query("ROLLBACK");throw error;} finally {db.release();}
    } else value=await op.run(scope,args);
    completed = true;
    const projected = await projectMcpReferences(options.pool,scope,value ?? null);
    if (!projected || typeof projected !== "object" || Array.isArray(projected)) throw new PlatformError("INVALID_TOOL_RESULT", 502, "The operation returned an invalid result");
    const text = JSON.stringify(projected);
    if (Buffer.byteLength(text) > 262144) throw new PlatformError("RESULT_TOO_LARGE", 413, "Narrow the request");
    if (containsConnectorCredential(Buffer.from(text),`Bearer ${match[1]}`)) throw new PlatformError("CREDENTIAL_REFLECTION",409,"The result is unavailable because it contains a connection credential");
    request.log.info({ event: "agents.mcp.operation.completed", operation: op.name, duration_ms: Math.round(performance.now() - started), outcome: "completed" });
    return { content: [{ type: "text", text }], structuredContent: projected as Record<string, unknown> };
   } catch (error) {
    const message = completed && (op.scope === "agents:manage" || op.scope === "runs:start") ? "The operation completed, but its result is unavailable. Check its status before retrying." : error instanceof PlatformError ? error.code === "CONFIGURATION_CONFIRMATION_REQUIRED" ? "This change needs review. Call request_configuration_review with the same proposed changes." : error.message : error instanceof z.ZodError ? "Invalid input" : "Operation failed";
    const code = error instanceof PlatformError ? error.code : error instanceof z.ZodError ? "invalid_input" : "operation_failed";
    request.log.warn({ event: "agents.mcp.operation.failed", operation: op.name, duration_ms: Math.round(performance.now() - started), code });
    return { isError: true, content: [{ type: "text", text: message }], structuredContent: { code, message } };
   }
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  reply.hijack();
  reply.raw.once("finish", () => { void transport.close(); void server.close(); });
  await transport.handleRequest(request.raw, reply.raw, request.body);
 });
 app.get("/mcp", async (_request, reply) => reply.code(405).header("Allow", "POST").send());
 app.delete("/mcp", async (_request, reply) => reply.code(405).header("Allow", "POST").send());
}
