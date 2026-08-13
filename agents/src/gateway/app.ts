import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { FixedWindowRateLimiter } from "./rate-limit";

const MAX_MCP_REQUEST_BYTES = 256 * 1024;
const MAX_MCP_RESPONSE_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18"]);

async function readBoundedResponse(response: Response, limit: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new Error("upstream_response_too_large");
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
      throw new Error("upstream_response_too_large");
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

export function buildGateway(input: {
  agentPlatformUrl: string;
  sharedSecret?: string;
  environment?: "development" | "test" | "production";
  enabled?: boolean;
  rateLimitPerWindow?: number;
  preAuthRateLimitPerWindow?: number;
  rateLimitWindowMs?: number;
  rateLimitMaxKeys?: number;
}): FastifyInstance {
  if (input.environment === "production" && !input.sharedSecret?.trim()) {
    throw new Error("AGENT_GATEWAY_SHARED_SECRET is required in production");
  }
  const app = Fastify({ logger: false, bodyLimit: MAX_MCP_REQUEST_BYTES, requestTimeout: UPSTREAM_TIMEOUT_MS });
  const enabled = input.enabled ?? true;
  const windowMs = input.rateLimitWindowMs ?? 60_000;
  const authenticatedLimiter = new FixedWindowRateLimiter(input.rateLimitPerWindow ?? 120, windowMs, input.rateLimitMaxKeys ?? 10_000);
  const preAuthLimiter = new FixedWindowRateLimiter(input.preAuthRateLimitPerWindow ?? 60, windowMs, input.rateLimitMaxKeys ?? 10_000);

  const jsonRpcError = (reply: { code: (status: number) => { send: (payload: unknown) => unknown } }, code: number, message: string) =>
    reply.code(code === -32029 ? 429 : code === -32003 ? 401 : code === -32602 ? 400 : 503).send({ jsonrpc: "2.0", id: null, error: { code, message } });

  const protocolVersion = (request: { headers: Record<string, string | string[] | undefined> }): string | undefined => {
    const value = request.headers["mcp-protocol-version"];
    return Array.isArray(value) ? value[0] : value;
  };

  app.get("/health", async () => ({ status: "ok", service: "agent-gateway" }));
  app.get("/.well-known/oauth-protected-resource", async () => ({
    resource: "/mcp",
    authorization_servers: [],
    scopes_supported: ["mcp:read", "mcp:write"],
    bearer_methods_supported: ["header"],
    installation_token_exchange_endpoint: "/v1/installation-tokens/exchange",
  }));
  app.get("/mcp", async (_request, reply) => reply.code(405).header("allow", "POST").send({ error: "streaming_not_supported" }));
  app.delete("/mcp", async (_request, reply) => reply.code(405).header("allow", "POST").send({ error: "sessions_not_supported" }));
  app.post("/mcp", async (request, reply) => {
    if (!enabled) return jsonRpcError(reply, -32030, "mcp_gateway_disabled");
    const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : "";
    const rateKey = authorization.startsWith("Bearer ")
      ? `credential:${createHash("sha256").update(authorization).digest("hex")}`
      : `network:${request.ip}`;
    const decision = (authorization ? authenticatedLimiter : preAuthLimiter).consume(rateKey);
    if (!decision.allowed) {
      reply.header("retry-after", String(decision.retryAfterSeconds));
      return jsonRpcError(reply, -32029, "rate_limited");
    }
    const requestedProtocol = protocolVersion(request);
    if (requestedProtocol && !SUPPORTED_PROTOCOL_VERSIONS.has(requestedProtocol)) {
      reply.header("mcp-protocol-version", "2025-06-18");
      return jsonRpcError(reply, -32602, "unsupported_mcp_protocol_version");
    }
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (typeof request.headers.authorization === "string") headers.authorization = request.headers.authorization;
    if (requestedProtocol) headers["mcp-protocol-version"] = requestedProtocol;
    if (input.sharedSecret) headers["x-agent-gateway-secret"] = input.sharedSecret;

    const controller = new AbortController();
    const onDisconnect = () => controller.abort();
    request.raw.once("close", onDisconnect);
    try {
      const response = await fetch(`${input.agentPlatformUrl.replace(/\/$/, "")}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
      });
      const payload = await readBoundedResponse(response, MAX_MCP_RESPONSE_BYTES);
      const upstreamProtocol = response.headers.get("mcp-protocol-version");
      if (upstreamProtocol) reply.header("mcp-protocol-version", upstreamProtocol);
      return reply.code(response.status).header("content-type", response.headers.get("content-type") ?? "application/json").send(payload);
    } catch (error) {
      const message = error instanceof Error && error.message === "upstream_response_too_large" ? error.message : "agent_platform_unavailable";
      return reply.code(502).send({ jsonrpc: "2.0", id: null, error: { code: -32000, message } });
    } finally {
      request.raw.off("close", onDisconnect);
    }
  });
  return app;
}
