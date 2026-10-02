import type { FastifyInstance, FastifyRequest, HTTPMethods } from "fastify";
import { admitBrowserRequest } from "./auth";
import { requireSameOrigin, type PlatformLogin } from "./platform-login";

// Explicitly expose the initial creation/playground journey. No wildcard proxy,
// internal credential forwarding, operator routes or channel ingestion aliases.
export const browserAgentRoutes: [HTTPMethods, string, string][] = [
  ["GET", "/v1/agents", "/api/agents"],
  ["POST", "/v1/agents", "/api/agents"],
  ["POST", "/v1/studio/agents", "/api/agents/studio"],
  ["PATCH", "/v1/agents/:agentId", "/api/agents/:agentId"],
  ["GET", "/v1/agents/:agentId/deployment-status", "/api/agents/:agentId/deployment-status"],
  ["POST", "/v1/agents/:agentId/playground/ensure", "/api/agents/:agentId/playground/ensure"],
  ["GET", "/v1/agents/:agentId/versions", "/api/agents/:agentId/versions"],
  ["POST", "/v1/agents/:agentId/versions", "/api/agents/:agentId/versions"],
  ["POST", "/v1/agents/:agentId/versions/:versionId/publish", "/api/agents/:agentId/versions/:versionId/publish"],
  ["POST", "/v1/installations/:installationId/deploy", "/api/agents/installations/:installationId/deploy"],
  ["GET", "/v1/agent-versions/:agentVersionId/effective-config", "/api/agents/agent-versions/:agentVersionId/effective-config"],
  ["GET", "/v1/models/catalog", "/api/agents/models/catalog"],
  ["GET", "/v1/capabilities/directory", "/api/agents/capabilities/directory"],
  ["GET", "/v1/operations/summary", "/api/agents/operations/summary"],
  ["POST", "/v1/installations/:installationId/status/:status", "/api/agents/installations/:installationId/status/:status"],
  ["GET", "/v1/installations/:installationId/readiness", "/api/agents/installations/:installationId/readiness"],
  ["GET", "/v1/installations/:installationId/capabilities", "/api/agents/installations/:installationId/capabilities"],
  ["GET", "/v1/installations/:installationId/connection-directory", "/api/agents/installations/:installationId/connection-directory"],
  ["GET", "/v1/installations/:installationId/runs", "/api/agents/installations/:installationId/runs"],
  ["POST", "/v1/installations/:installationId/platform/conversation", "/api/agents/installations/:installationId/platform/conversation"],
  ["POST", "/v1/installations/:installationId/platform/conversation/new", "/api/agents/installations/:installationId/platform/conversation/new"],
  ["POST", "/v1/installations/:installationId/platform/messages", "/api/agents/installations/:installationId/platform/messages"],
  ["GET", "/v1/conversations/:conversationId", "/api/agents/conversations/:conversationId"],
  ["PATCH", "/v1/conversations/:conversationId", "/api/agents/conversations/:conversationId"],
  ["GET", "/v1/runs/:runId", "/api/agents/runs/:runId"],
  ["GET", "/v1/runs/:runId/timeline", "/api/agents/runs/:runId/timeline"],
  ["GET", "/v1/runs/:runId/memory-observatory", "/api/agents/runs/:runId/memory-observatory"],
  ["GET", "/v1/memory/revisions/:revisionId/lineage", "/api/agents/memory/revisions/:revisionId/lineage"],
  ["GET", "/v1/runs/:runId/events/stream", "/api/agents/runs/:runId/events/stream"],
  ["POST", "/v1/runs/:runId/cancel", "/api/agents/runs/:runId/cancel"],
  ["POST", "/v1/runs/:runId/retry", "/api/agents/runs/:runId/retry"],
];

export function registerBrowserAgentRoutes(app: FastifyInstance, login?: PlatformLogin): void {
  const registered = new Set<string>();
  app.addHook("onRoute", (options) => {
    if (!options.url.startsWith("/v1/")) return;
    const methods = Array.isArray(options.method) ? options.method : [options.method];
    for (const [method, source, url] of browserAgentRoutes) {
      if (source !== options.url || !methods.includes(method) || registered.has(`${method} ${url}`)) continue;
      registered.add(`${method} ${url}`);
      const changing = method !== "GET" && method !== "HEAD";
      async function authorize(request: FastifyRequest) {
        if (!login) throw Object.assign(new Error("Sign-in is not configured yet"), { statusCode: 503 });
        if (changing) requireSameOrigin(request, login.provider.publicOrigin);
        else if (request.headers["sec-fetch-site"] === "cross-site"
          || (request.headers.origin && request.headers.origin !== login.provider.publicOrigin)) {
          throw Object.assign(new Error("Request origin denied"), { statusCode: 403 });
        }
        const session = await login.requireSession(request);
        const membership = session.organizations.find(org => org.id === session.activeOrganizationId);
        if (!membership) throw Object.assign(new Error("Choose a workspace first"), { statusCode: 403 });
        if (changing && membership.role === "viewer") throw Object.assign(new Error("Workspace write access required"), { statusCode: 403 });
        return { organizationId: membership.id, actorId: session.account.id,
          scopes: ["agents:read", "runs:read", "chat:read", ...(membership.role === "viewer" ? [] : ["agents:write", "runs:write", "runs:cancel", "chat:write"])] };
      }
      app.route({
        ...options, method, url,
        onRequest: [...(options.onRequest ? Array.isArray(options.onRequest) ? options.onRequest : [options.onRequest] : []),
          async (request, reply) => {
            reply.header("cache-control", "no-store");
            const context = await authorize(request);
            admitBrowserRequest(request, context, async () => {
              const current = await authorize(request);
              if (current.organizationId !== context.organizationId || current.actorId !== context.actorId) {
                throw Object.assign(new Error("Workspace session changed"), { statusCode: 403 });
              }
            });
          }],
      });
    }
  });
}
