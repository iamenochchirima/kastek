import Fastify, { type FastifyInstance } from "fastify";

export function buildGateway(input: { agentPlatformUrl: string; sharedSecret?: string }): FastifyInstance {
  const app = Fastify({ logger: false });
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
    for (const name of ["x-organization-id", "x-actor-id", "x-correlation-id"]) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    if (input.sharedSecret) headers["x-agent-gateway-secret"] = input.sharedSecret;
    const response = await fetch(`${input.agentPlatformUrl.replace(/\/$/, "")}/mcp`, { method: "POST", headers, body: JSON.stringify(request.body) });
    reply.code(response.status).header("content-type", response.headers.get("content-type") ?? "application/json").send(await response.text());
  });
  return app;
}
