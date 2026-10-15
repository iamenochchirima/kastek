import type { FastifyInstance, FastifyRequest, HTTPMethods } from "fastify";
import { admitBrowserRequest } from "./auth";
import { requireSameOrigin, type PlatformLogin } from "./platform-login";

// Explicitly expose the initial browser workspace and agent journeys. No wildcard
// proxy, internal credential forwarding, operator routes or channel ingestion aliases.
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
  ["POST", "/v1/models/catalog", "/api/agents/models/catalog"],
  ["GET", "/v1/capabilities/directory", "/api/agents/capabilities/directory"],
  ["GET", "/v1/operations/summary", "/api/agents/operations/summary"],
  ["POST", "/v1/installations/:installationId/status/:status", "/api/agents/installations/:installationId/status/:status"],
  ["GET", "/v1/installations/:installationId/readiness", "/api/agents/installations/:installationId/readiness"],
  ["GET", "/v1/installations/:installationId/capabilities", "/api/agents/installations/:installationId/capabilities"],
  ["GET", "/v1/installations/:installationId/connection-directory", "/api/agents/installations/:installationId/connection-directory"],
  ["GET", "/v1/mcp/providers", "/api/agents/mcp/providers"],
  ["POST", "/v1/mcp/providers", "/api/agents/mcp/providers"],
  ["POST", "/v1/mcp/providers/:providerId/discover", "/api/agents/mcp/providers/:providerId/discover"],
  ["POST", "/v1/mcp/providers/:providerId/health", "/api/agents/mcp/providers/:providerId/health"],
  ["GET", "/v1/mcp/providers/:providerId/versions", "/api/agents/mcp/providers/:providerId/versions"],
  ["POST", "/v1/mcp/providers/:providerId/versions/:versionId/publish", "/api/agents/mcp/providers/:providerId/versions/:versionId/publish"],
  ["GET", "/v1/agent-versions/:agentVersionId/mcp-providers", "/api/agents/agent-versions/:agentVersionId/mcp-providers"],
  ["POST", "/v1/agent-versions/:agentVersionId/mcp-providers/:providerVersionId", "/api/agents/agent-versions/:agentVersionId/mcp-providers/:providerVersionId"],
  ["DELETE", "/v1/agent-versions/:agentVersionId/mcp-providers/:providerVersionId", "/api/agents/agent-versions/:agentVersionId/mcp-providers/:providerVersionId"],
  ["GET", "/v1/integrations/catalog", "/api/agents/integrations/catalog"],
  ["GET", "/v1/installations/:installationId/integrations", "/api/agents/installations/:installationId/integrations"],
  ["GET", "/v1/installations/:installationId/channels", "/api/agents/installations/:installationId/channels"],
  ["POST", "/v1/installations/:installationId/channels", "/api/agents/installations/:installationId/channels"],
  ["POST", "/v1/installations/:installationId/channels/:connectionId/pairing", "/api/agents/installations/:installationId/channels/:connectionId/pairing"],
  ["DELETE", "/v1/installations/:installationId/channels/:connectionId", "/api/agents/installations/:installationId/channels/:connectionId"],
  ["DELETE", "/v1/channel-bindings/:bindingId", "/api/agents/channel-bindings/:bindingId"],
  ["POST", "/v1/installations/:installationId/integrations/:integrationId/oauth/start", "/api/agents/installations/:installationId/integrations/:integrationId/oauth/start"],
  ["POST", "/v1/installations/:installationId/integrations/:integrationId/api-key", "/api/agents/installations/:installationId/integrations/:integrationId/api-key"],
  ["POST", "/v1/installations/:installationId/integrations/:integrationId/local-connector", "/api/agents/installations/:installationId/integrations/:integrationId/local-connector"],
  ["DELETE", "/v1/installations/:installationId/integrations/:integrationId", "/api/agents/installations/:installationId/integrations/:integrationId"],
  ["GET", "/v1/installations/:installationId/grants", "/api/agents/installations/:installationId/grants"],
  ["GET", "/v1/connectors", "/api/agents/connectors"],
  ["GET", "/v1/installations/:installationId/connectors", "/api/agents/installations/:installationId/connectors"],
  ["POST", "/v1/installations/:installationId/tools", "/api/agents/installations/:installationId/tools"],
  ["POST", "/v1/installations/:installationId/grants/resources", "/api/agents/installations/:installationId/grants/resources"],
  ["POST", "/v1/installations/:installationId/grants/connectors", "/api/agents/installations/:installationId/grants/connectors"],
  ["DELETE", "/v1/tool-grants/:grantId", "/api/agents/tool-grants/:grantId"],
  ["POST", "/v1/runs/:runId/approval-group", "/api/agents/runs/:runId/approval-group"],
  ["GET", "/v1/installations/:installationId/api-keys", "/api/agents/installations/:installationId/api-keys"],
  ["GET", "/v1/installations/:installationId/website-deployments", "/api/agents/installations/:installationId/website-deployments"],
  ["POST", "/v1/installations/:installationId/website-deployments", "/api/agents/installations/:installationId/website-deployments"],
  ["PATCH", "/v1/installations/:installationId/website-deployments/:deploymentId", "/api/agents/installations/:installationId/website-deployments/:deploymentId"],
  ["POST", "/v1/installations/:installationId/website-deployments/:deploymentId/status/:status", "/api/agents/installations/:installationId/website-deployments/:deploymentId/status/:status"],
  ["POST", "/v1/installations/:installationId/api-keys", "/api/agents/installations/:installationId/api-keys"],
  ["DELETE", "/v1/installations/:installationId/api-keys/:keyId", "/api/agents/installations/:installationId/api-keys/:keyId"],
  ["GET", "/v1/installations/:installationId/runs", "/api/agents/installations/:installationId/runs"],
  ["POST", "/v1/installations/:installationId/platform/conversation", "/api/agents/installations/:installationId/platform/conversation"],
  ["POST", "/v1/installations/:installationId/platform/conversation/new", "/api/agents/installations/:installationId/platform/conversation/new"],
  ["POST", "/v1/installations/:installationId/platform/messages", "/api/agents/installations/:installationId/platform/messages"],
  ["GET", "/v1/conversations/customer", "/api/agents/conversations/customer"],
  ["GET", "/v1/conversations/summary", "/api/agents/conversations/summary"],
  ["GET", "/v1/conversations/handoffs", "/api/agents/conversations/handoffs"],
  ["GET", "/v1/conversations/handoffs/:handoffId", "/api/agents/conversations/handoffs/:handoffId"],
  ["GET", "/v1/conversations/events/stream", "/api/agents/conversations/events/stream"],
  ["GET", "/v1/conversations/:conversationId/events/stream", "/api/agents/conversations/:conversationId/events/stream"],
  ["POST", "/v1/conversations/:conversationId/takeover", "/api/agents/conversations/:conversationId/takeover"],
  ["POST", "/v1/conversations/:conversationId/reopen", "/api/agents/conversations/:conversationId/reopen"],
  ["POST", "/v1/conversations/:conversationId/notes", "/api/agents/conversations/:conversationId/notes"],
  ["POST", "/v1/conversations/handoffs/:handoffId/claim", "/api/agents/conversations/handoffs/:handoffId/claim"],
  ["POST", "/v1/conversations/handoffs/:handoffId/release", "/api/agents/conversations/handoffs/:handoffId/release"],
  ["POST", "/v1/conversations/handoffs/:handoffId/continue", "/api/agents/conversations/handoffs/:handoffId/continue"],
  ["POST", "/v1/conversations/handoffs/:handoffId/resolve", "/api/agents/conversations/handoffs/:handoffId/resolve"],
  ["POST", "/v1/conversations/handoffs/:handoffId/messages", "/api/agents/conversations/handoffs/:handoffId/messages"],
  ["GET", "/v1/conversations/:conversationId", "/api/agents/conversations/:conversationId"],
  ["PATCH", "/v1/conversations/:conversationId", "/api/agents/conversations/:conversationId"],
  ["GET", "/v1/runs/:runId", "/api/agents/runs/:runId"],
  ["GET", "/v1/runs/:runId/timeline", "/api/agents/runs/:runId/timeline"],
  ["GET", "/v1/runs/:runId/memory-observatory", "/api/agents/runs/:runId/memory-observatory"],
  ["GET", "/v1/memory/revisions/:revisionId/lineage", "/api/agents/memory/revisions/:revisionId/lineage"],
  ["GET", "/v1/memory", "/api/agents/memory"],
  ["DELETE", "/v1/memory/:memoryId", "/api/agents/memory/:memoryId"],
  ["POST", "/v1/memory/:memoryId/revalidate", "/api/agents/memory/:memoryId/revalidate"],
  ["POST", "/v1/memory/:memoryId/review", "/api/agents/memory/:memoryId/review"],
  ["POST", "/v1/knowledge/sources", "/api/agents/knowledge/sources"],
  ["GET", "/v1/knowledge/sources", "/api/agents/knowledge/sources"],
  ["GET", "/v1/knowledge/sources/:sourceId", "/api/agents/knowledge/sources/:sourceId"],
  ["DELETE", "/v1/knowledge/sources/:sourceId", "/api/agents/knowledge/sources/:sourceId"],
  ["POST", "/v1/knowledge/sources/:sourceId/ingest-text", "/api/agents/knowledge/sources/:sourceId/ingest-text"],
  ["POST", "/v1/knowledge/sources/:sourceId/ingest-file", "/api/agents/knowledge/sources/:sourceId/ingest-file"],
  ["POST", "/v1/knowledge/sources/:sourceId/ingest-url", "/api/agents/knowledge/sources/:sourceId/ingest-url"],
  ["GET", "/v1/knowledge/websites/readiness", "/api/agents/knowledge/websites/readiness"],
  ["POST", "/v1/knowledge/websites/map", "/api/agents/knowledge/websites/map"],
  ["POST", "/v1/knowledge/websites/crawl", "/api/agents/knowledge/websites/crawl"],
  ["GET", "/v1/knowledge/websites/crawl/:sourceId", "/api/agents/knowledge/websites/crawl/:sourceId"],
  ["DELETE", "/v1/knowledge/websites/crawl/:sourceId", "/api/agents/knowledge/websites/crawl/:sourceId"],
  ["GET", "/v1/runs/:runId/events/stream", "/api/agents/runs/:runId/events/stream"],
  ["POST", "/v1/runs/:runId/cancel", "/api/agents/runs/:runId/cancel"],
  ["POST", "/v1/runs/:runId/retry", "/api/agents/runs/:runId/retry"],
  ["POST", "/v1/runs/:runId/external-event", "/api/agents/runs/:runId/external-event"],
];

export function registerBrowserAgentRoutes(app: FastifyInstance, login?: PlatformLogin): void {
  const registered = new Set<string>();
  app.addHook("onRoute", (options) => {
    if (!options.url.startsWith("/v1/")) return;
    const methods = Array.isArray(options.method) ? options.method : [options.method];
    for (const [method, source, url] of browserAgentRoutes) {
      if (source !== options.url || !methods.includes(method) || registered.has(`${method} ${url}`)) continue;
      registered.add(`${method} ${url}`);
      const readOnlyPost = method === "POST" && source === "/v1/models/catalog";
      const changing = method !== "GET" && method !== "HEAD" && !readOnlyPost;
      const sameOriginRequired = method !== "GET" && method !== "HEAD";
      async function authorize(request: FastifyRequest) {
        if (!login) throw Object.assign(new Error("Sign-in is not configured yet"), { statusCode: 503 });
        if (sameOriginRequired) requireSameOrigin(request, login.provider.publicOrigin);
        else if (request.headers["sec-fetch-site"] === "cross-site"
          || (request.headers.origin && request.headers.origin !== login.provider.publicOrigin)) {
          throw Object.assign(new Error("Request origin denied"), { statusCode: 403 });
        }
        const session = await login.requireSession(request);
        const membership = session.organizations.find(org => org.id === session.activeOrganizationId);
        if (!membership) throw Object.assign(new Error("Choose a workspace first"), { statusCode: 403 });
        if (changing && membership.role === "viewer") throw Object.assign(new Error("Workspace write access required"), { statusCode: 403 });
        return { organizationId: membership.id, actorId: session.account.id,
          scopes: ["agents:read", "runs:read", "chat:read", "channels:read", ...(membership.role === "viewer" ? [] : ["agents:write", "runs:write", "runs:cancel", "runs:approve", "chat:write", "channels:write"])] };
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
