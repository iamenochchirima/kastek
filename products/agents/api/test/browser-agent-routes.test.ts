import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { browserAuthContext, recheckBrowserRequest } from "../src/http/auth";
import { registerBrowserAgentRoutes } from "../src/http/browser-agent-routes";
import { registerPlatformLogin } from "../src/http/platform-login";

const config = loadConfig({ NODE_ENV: "test", AGENTS_DATABASE_URL: "postgresql://localhost/unused",
  AGENTS_OIDC_ISSUER_URL: "http://localhost:8080/realms/kasitek", AGENTS_PUBLIC_URL: "http://localhost:3100",
  AGENTS_OIDC_CLIENT_ID: "agents", AGENTS_OIDC_CLIENT_SECRET: "test-secret",
  AGENTS_OIDC_ADMIN_CLIENT_ID: "agents-admin", AGENTS_OIDC_ADMIN_CLIENT_SECRET: "test-admin-secret" });
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(apps.splice(0).map(app => app.close())); });

function setup(role = "member") {
  const app = Fastify(); apps.push(app);
  const login = registerPlatformLogin(app, config, {} as never)!;
  const session = { account: { id: "account-1" }, activeOrganizationId: "workspace-1",
    organizations: [{ id: "workspace-1", role, name: "Workspace" }] };
  const check = vi.spyOn(login, "requireSession").mockImplementation(async request => {
    if (!request.cookies[login.sessionCookie]) throw Object.assign(new Error("Sign-in required"), { statusCode: 401 });
    return session as never;
  });
  registerBrowserAgentRoutes(app, login);
  app.get("/v1/agents", request => browserAuthContext(request) ?? { machineRoute: true });
  app.post("/v1/agents", request => browserAuthContext(request));
  app.post("/v1/models/catalog", request => browserAuthContext(request));
  app.post("/v1/installations/:installationId/preflight", request => browserAuthContext(request));
  app.post("/v1/installations/:installationId/promote", request => browserAuthContext(request));
  app.post("/v1/installations/:installationId/rollback", request => browserAuthContext(request));
  app.post("/v1/runs/:runId/retry", request => browserAuthContext(request));
  app.post("/v1/runs/:runId/cancel", request => browserAuthContext(request));
  app.post("/v1/runs/:runId/external-event", request => browserAuthContext(request));
  app.get("/v1/installations/:installationId/integrations", request => browserAuthContext(request));
  app.get("/v1/installations/:installationId/channels", request => browserAuthContext(request));
  app.post("/v1/installations/:installationId/channels", request => browserAuthContext(request));
  app.post("/v1/installations/:installationId/channels/:connectionId/pairing", request => browserAuthContext(request));
  app.delete("/v1/installations/:installationId/channels/:connectionId", request => browserAuthContext(request));
  app.delete("/v1/channel-bindings/:bindingId", request => browserAuthContext(request));
  app.post("/v1/installations/:installationId/integrations/:integrationId/oauth/start", request => browserAuthContext(request));
  app.post("/v1/installations/:installationId/tools", request => browserAuthContext(request));
  app.post("/v1/runs/:runId/approval-group", request => browserAuthContext(request));
  app.get("/v1/installations/:installationId/website-deployments", request => browserAuthContext(request));
  app.post("/v1/installations/:installationId/website-deployments", request => browserAuthContext(request));
  app.patch("/v1/installations/:installationId/website-deployments/:deploymentId", request => browserAuthContext(request));
  app.post("/v1/installations/:installationId/website-deployments/:deploymentId/status/:status", request => browserAuthContext(request));
  app.get("/v1/knowledge/sources", request => browserAuthContext(request));
  app.post("/v1/knowledge/sources", request => browserAuthContext(request));
  app.get("/v1/runs/:runId/events/stream", async request => {
    session.activeOrganizationId = "another-workspace";
    await recheckBrowserRequest(request);
    return { unexpected: true };
  });
  app.get("/v1/conversations/customer", request => browserAuthContext(request));
  app.post("/v1/conversations/:conversationId/takeover", request => browserAuthContext(request));
  app.post("/v1/conversations/:conversationId/notes", request => browserAuthContext(request));
  app.post("/v1/conversations/handoffs/:handoffId/messages", request => browserAuthContext(request));
  app.get("/v1/mcp/providers", request => browserAuthContext(request));
  app.get("/v1/mcp/providers/:providerId/versions", request => browserAuthContext(request));
  app.post("/v1/mcp/providers", request => browserAuthContext(request));
  app.post("/v1/mcp/providers/:providerId/discover", request => browserAuthContext(request));
  app.post("/v1/mcp/providers/:providerId/health", request => browserAuthContext(request));
  app.post("/v1/mcp/providers/:providerId/versions/:versionId/publish", request => browserAuthContext(request));
  app.post("/v1/agent-versions/:agentVersionId/mcp-providers/:providerVersionId", request => browserAuthContext(request));
  app.delete("/v1/agent-versions/:agentVersionId/mcp-providers/:providerVersionId", request => browserAuthContext(request));
  app.get("/v1/operator/summary", () => ({ private: true }));
  return { app, check };
}
const headers = { cookie: "agents-session=opaque-session", origin: "http://localhost:3100" };

describe("standalone browser agent admission", () => {
  it("derives organization and actor from membership, ignoring forged machine headers", async () => {
    const { app } = setup();
    const response = await app.inject({ url: "/api/agents", headers: { ...headers, "x-organization-id": "victim", "x-actor-id": "operator", "x-kasitek-operator": "true" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ organizationId: "workspace-1", actorId: "account-1", source: "browser", operator: false });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect((await app.inject({ url: "/v1/agents" })).json()).toEqual({ machineRoute: true });
    expect((await app.inject({ url: "/api/agents/operator/summary", headers })).statusCode).toBe(404);
  });
  it("rejects requests without a session, regardless of machine headers", async () => {
    const { app } = setup();
    expect((await app.inject({ url: "/api/agents", headers: { "x-organization-id": "forged", "x-actor-id": "forged" } })).statusCode).toBe(401);
  });
  it("allows viewer reads but denies writes", async () => {
    const { app } = setup("viewer");
    expect((await app.inject({ url: "/api/agents", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/agents/models/catalog", headers, payload: { provider: "openai", credentialReference: "credential-1" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/agents", headers, payload: { name: "Denied" } })).statusCode).toBe(403);
  });
  it("admits member run recovery controls and rejects viewer or cross-origin writes", async () => {
    const { app } = setup();
    const viewer = setup("viewer").app;
    for (const action of ["cancel", "retry", "external-event"]) {
      const url = `/api/agents/runs/run-1/${action}`;
      const response = await app.inject({ method: "POST", url, headers, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json().scopes).toContain(action === "cancel" ? "runs:cancel" : action === "external-event" ? "runs:write" : "chat:write");
      expect((await viewer.inject({ method: "POST", url, headers, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url, headers: { ...headers, origin: "https://foreign.example" }, payload: {} })).statusCode).toBe(403);
    }
  });
  it("admits scoped knowledge reads and writes through the explicit browser aliases", async () => {
    const { app } = setup();
    const viewer = setup("viewer").app;
    expect((await app.inject({ url: "/api/agents/knowledge/sources?agentId=agent-1", headers })).statusCode).toBe(200);
    const create = await app.inject({ method: "POST", url: "/api/agents/knowledge/sources", headers, payload: { agentId: "agent-1", name: "FAQ", sourceType: "manual" } });
    expect(create.statusCode).toBe(200);
    expect(create.json().scopes).toContain("agents:write");
    expect((await viewer.inject({ method: "POST", url: "/api/agents/knowledge/sources", headers, payload: { agentId: "agent-1" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/agents/knowledge/sources", headers: { ...headers, origin: "https://foreign.example" }, payload: {} })).statusCode).toBe(403);
  });
  it("admits tool connections, grants and approvals with member and origin checks", async () => {
    const { app } = setup();
    const viewer = setup("viewer").app;
    const read = "/api/agents/installations/install-1/integrations";
    expect((await viewer.inject({ url: read, headers })).statusCode).toBe(200);
    for (const url of ["/api/agents/installations/install-1/integrations/google.calendar/oauth/start", "/api/agents/installations/install-1/tools", "/api/agents/runs/run-1/approval-group"]) {
      const response = await app.inject({ method: "POST", url, headers, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json().scopes).toContain(url.endsWith("approval-group") ? "runs:approve" : "agents:write");
      expect((await viewer.inject({ method: "POST", url, headers, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url, headers: { ...headers, origin: "https://foreign.example" }, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url, headers: { origin: headers.origin }, payload: {} })).statusCode).toBe(401);
    }
    expect((await app.inject({ url: "/api/agents/installations/install-1/integrations/google.calendar/oauth/start", headers })).statusCode).toBe(404);
  });

  it("admits teammate inbox commands while rejecting viewers and foreign origins", async () => {
    const { app } = setup(); const viewer = setup("viewer").app;
    expect((await viewer.inject({ url: "/api/agents/conversations/customer", headers })).statusCode).toBe(200);
    for (const url of ["/api/agents/conversations/conv-1/takeover", "/api/agents/conversations/conv-1/notes", "/api/agents/conversations/handoffs/handoff-1/messages"]) {
      expect((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode).toBe(200);
      expect((await viewer.inject({ method: "POST", url, headers, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url, headers: { ...headers, origin: "https://foreign.example" }, payload: {} })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: "POST", url: "/api/agents/channels/delivery-status", headers, payload: {} })).statusCode).toBe(404);
  });
  it("admits explicit MCP setup routes without exposing global revocation", async () => {
    const { app } = setup(); const viewer = setup("viewer").app;
    expect((await viewer.inject({ url: "/api/agents/mcp/providers", headers })).statusCode).toBe(200);
    for (const [method, url] of [
      ["POST", "/api/agents/mcp/providers"],
      ["POST", "/api/agents/mcp/providers/provider-1/discover"],
      ["POST", "/api/agents/mcp/providers/provider-1/health"],
      ["POST", "/api/agents/mcp/providers/provider-1/versions/version-1/publish"],
      ["POST", "/api/agents/agent-versions/agent-version-1/mcp-providers/version-1"],
      ["DELETE", "/api/agents/agent-versions/agent-version-1/mcp-providers/version-1"],
    ] as const) {
      expect((await app.inject({ method, url, headers, payload: {} })).statusCode).toBe(200);
      expect((await viewer.inject({ method, url, headers, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method, url, headers: { ...headers, origin: "https://foreign.example" }, payload: {} })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: "POST", url: "/api/agents/mcp/providers/provider-1/revoke", headers, payload: {} })).statusCode).toBe(404);
  });

  it("rejects foreign origins before checking memberships", async () => {
    const { app, check } = setup();
    const response = await app.inject({ method: "POST", url: "/api/agents", headers: { ...headers, origin: "https://foreign.example" }, payload: {} });
    expect(response.statusCode).toBe(403);
    expect(check).not.toHaveBeenCalled();
  });
  it("allows scoped channel setup without exposing channel ingestion", async () => {
    const { app } = setup(), viewer = setup("viewer").app;
    const path = "/api/agents/installations/install-1/channels";
    const read = await viewer.inject({ url: path, headers });
    expect(read.statusCode).toBe(200);
    expect(read.json().scopes).toContain("channels:read");
    expect(read.json().scopes).not.toContain("channels:write");
    for (const [method, url] of [["POST", path], ["POST", `${path}/connection-1/pairing`], ["DELETE", `${path}/connection-1`], ["DELETE", "/api/agents/channel-bindings/binding-1"]] as const) {
      const response = await app.inject({ method, url, headers, ...(method === "POST" ? {payload:{}} : {}) });
      expect(response.statusCode).toBe(200);
      expect(response.json().scopes).toContain("channels:write");
      expect(response.json().scopes).not.toContain("channels:ingest");
      expect((await viewer.inject({ method, url, headers })).statusCode).toBe(403);
      expect((await app.inject({ method, url, headers: {...headers, origin:"https://foreign.example"} })).statusCode).toBe(403);
    }
    expect((await app.inject({method:"POST",url:"/api/agents/channel-pairing/consume",headers,payload:{}})).statusCode).toBe(404);
  });
  it("requires member access and same origin for publishing and changing website chat", async () => {
    const { app } = setup(), viewer = setup("viewer").app;
    const path = "/api/agents/installations/install-1/website-deployments";
    expect((await viewer.inject({ url: path, headers })).statusCode).toBe(200);
    for (const [method, url] of [["POST", path], ["PATCH", `${path}/deployment-1`], ["POST", `${path}/deployment-1/status/PAUSED`]] as const) {
      expect((await app.inject({ method, url, headers, payload: {} })).statusCode).toBe(200);
      expect((await viewer.inject({ method, url, headers, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method, url, headers: { ...headers, origin: "https://foreign.example" }, payload: {} })).statusCode).toBe(403);
    }
  });
  it("admits Live deployment checks and changes only to same-origin workspace members", async () => {
    const { app } = setup(), viewer = setup("viewer").app;
    const actions = [
      ["preflight", "agents:read"],
      ["promote", "agents:write"],
      ["rollback", "agents:write"],
    ] as const;
    for (const [action, scope] of actions) {
      const url = `/api/agents/installations/live-1/${action}`;
      const response = await app.inject({ method: "POST", url, headers, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json().scopes).toContain(scope);
      if (action !== "preflight") expect((await viewer.inject({ method: "POST", url, headers, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url, headers: { ...headers, origin: "https://foreign.example" }, payload: {} })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: "POST", url: "/api/agents/installations/live-1/promote", headers: { origin: headers.origin }, payload: {} })).statusCode).toBe(401);
  });
  it("rechecks streaming authorization and rejects changed workspace context", async () => {
    const { app } = setup();
    expect((await app.inject({ url: "/api/agents/runs/run-1/events/stream", headers })).statusCode).toBe(403);
  });
});
