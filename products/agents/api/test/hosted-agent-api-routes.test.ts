import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { installationApiAuthContext, recheckAdmittedRequest } from "../src/http/auth";
import { registerHostedAgentApiRoutes } from "../src/http/hosted-agent-api-routes";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const id = "33333333-3333-4333-8333-333333333333";
function fixture() {
  const app = Fastify(); apps.push(app);
  let active = true;
  registerHostedAgentApiRoutes(app, {
    keys: { authenticate: async secret => secret === "test-key" && active ? {
      id, organization_id: "workspace", installation_id: "installation", created_by: "owner",
    } as never : null, recordUse: async () => undefined },
    runs: { getRun: async (_org, runId) => ({ installation_id: runId === id ? "installation" : "other" }) as never },
    conversations: { getConversation: async () => ({ installation_id: "other" }) as never },
  });
  app.get("/v1/runs/:runId", request => installationApiAuthContext(request) ?? { machine: true });
  app.get("/v1/runs/:runId/events/stream", async request => { active = false; await recheckAdmittedRequest(request); return {}; });
  app.post("/v1/installations/:installationId/platform/messages", request => ({ params: request.params, body: request.body }));
  return app;
}
const headers = { authorization: "Bearer test-key" };
describe("hosted agent API admission", () => {
  it("uses key scope, ignores forged headers and does not grant machine-route admission", async () => {
    const app = fixture();
    const response = await app.inject({ url: `/api/v1/agent/runs/${id}`, headers: { ...headers, "x-organization-id": "victim", "x-kasitek-operator": "true" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ organizationId: "workspace", actorId: "owner", operator: false, source: "installation_api" });
    expect((await app.inject({ url: `/v1/runs/${id}`, headers })).json()).toEqual({ machine: true });
    expect((await app.inject({ url: "/api/v1/agent/runs/44444444-4444-4444-8444-444444444444", headers })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/v1/agent/runs/${id}` })).statusCode).toBe(401);
  });
  it("binds messages to the key installation and rejects cross-installation conversations or model overrides", async () => {
    const app = fixture();
    const request = { method: "POST" as const, url: "/api/v1/agent/messages", headers };
    const valid = await app.inject({ ...request, payload: { message: "Hello", idempotencyKey: "request-123", createNew: true } });
    expect(valid.statusCode).toBe(200);
    expect(valid.json().params.installationId).toBe("installation");
    const other = await app.inject({ ...request, payload: { message: "Hello", idempotencyKey: "request-123", conversationId: id } });
    expect(other.statusCode).toBe(404);
    const override = await app.inject({ ...request, payload: { message: "Hello", idempotencyKey: "request-123", createNew: true, modelProvider: "openai" } });
    expect(override.statusCode).not.toBe(200);
  });
  it("denies browser use and rechecks revocation on an admitted stream", async () => {
    const app = fixture();
    expect((await app.inject({ url: `/api/v1/agent/runs/${id}`, headers: { ...headers, origin: "http://localhost:3100" } })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/v1/agent/runs/${id}/events/stream`, headers })).statusCode).toBe(401);
  });
});
