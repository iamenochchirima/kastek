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
  app.post("/v1/runs/:runId/retry", request => browserAuthContext(request));
  app.post("/v1/runs/:runId/cancel", request => browserAuthContext(request));
  app.get("/v1/knowledge/sources", request => browserAuthContext(request));
  app.post("/v1/knowledge/sources", request => browserAuthContext(request));
  app.get("/v1/runs/:runId/events/stream", async request => {
    session.activeOrganizationId = "another-workspace";
    await recheckBrowserRequest(request);
    return { unexpected: true };
  });
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
    expect((await app.inject({ method: "POST", url: "/api/agents", headers, payload: { name: "Denied" } })).statusCode).toBe(403);
  });
  it("admits member run recovery controls and rejects viewer or cross-origin writes", async () => {
    const { app } = setup();
    const viewer = setup("viewer").app;
    for (const action of ["cancel", "retry"]) {
      const url = `/api/agents/runs/run-1/${action}`;
      const response = await app.inject({ method: "POST", url, headers, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json().scopes).toContain(action === "cancel" ? "runs:cancel" : "chat:write");
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
  it("rejects foreign origins before checking memberships", async () => {
    const { app, check } = setup();
    const response = await app.inject({ method: "POST", url: "/api/agents", headers: { ...headers, origin: "https://foreign.example" }, payload: {} });
    expect(response.statusCode).toBe(403);
    expect(check).not.toHaveBeenCalled();
  });
  it("rechecks streaming authorization and rejects changed workspace context", async () => {
    const { app } = setup();
    expect((await app.inject({ url: "/api/agents/runs/run-1/events/stream", headers })).statusCode).toBe(403);
  });
});
