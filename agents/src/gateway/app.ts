import Fastify, { type FastifyInstance } from "fastify";

const MAX_MCP_REQUEST_BYTES = 256 * 1024;
const MAX_MCP_RESPONSE_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;

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

export function buildGateway(input: { agentPlatformUrl: string; sharedSecret?: string; environment?: "development" | "test" | "production" }): FastifyInstance {
  if (input.environment === "production" && !input.sharedSecret?.trim()) {
    throw new Error("AGENT_GATEWAY_SHARED_SECRET is required in production");
  }
  const app = Fastify({ logger: false, bodyLimit: MAX_MCP_REQUEST_BYTES, requestTimeout: UPSTREAM_TIMEOUT_MS });
  app.get("/health", async () => ({ status: "ok", service: "agent-gateway" }));
  app.get("/.well-known/oauth-protected-resource", async () => ({
    resource: "/mcp",
    authorization_servers: [],
    scopes_supported: ["mcp:read", "mcp:write"],
    bearer_methods_supported: ["header"],
    installation_token_exchange_endpoint: "/v1/installation-tokens/exchange",
  }));
  app.post("/mcp", async (request, reply) => {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (typeof request.headers.authorization === "string") headers.authorization = request.headers.authorization;
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
