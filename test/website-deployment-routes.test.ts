import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { normalizeWebsiteOrigin, registerWebsiteDeploymentRoutes } from "../src/http/website-deployment-routes";
import type { WebsiteDeploymentRecord } from "../src/db/repositories/website-deployment-repository";

const source = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const record = { id, public_id: id, organization_id: "workspace", source_installation_id: source,
  installation_id: "33333333-3333-4333-8333-333333333333", channel_connection_id: id,
  status: "ACTIVE", allowed_origins: ["http://localhost:3200"], configuration: { displayName: "FAQ" },
  created_at: "2026-10-06", updated_at: "2026-10-06" } as WebsiteDeploymentRecord;
function setup() {
  const app = Fastify();
  app.setErrorHandler((error: any, _request, reply) => reply.code(error.statusCode ?? (error.name === "ZodError" ? 400 : 500)).send({ error: error.message }));
  const websites = { list: vi.fn().mockResolvedValue([record]), create: vi.fn().mockResolvedValue(record),
    update: vi.fn().mockResolvedValue(null), setStatus: vi.fn().mockResolvedValue(null) };
  registerWebsiteDeploymentRoutes(app, { websites, publicOrigin: "http://localhost:3100",
    authorize: (_request, writing) => ({ organizationId: "workspace", actorId: "member", scopes: [writing ? "agents:write" : "agents:read"] }) });
  return { app, websites };
}
describe("website deployment management", () => {
  it("publishes only validated origins and reports the separate live installation", async () => {
    const { app, websites } = setup();
    try {
      const response = await app.inject({ method: "POST", url: `/v1/installations/${source}/website-deployments`,
        payload: { allowedOrigins: ["http://localhost:3200/"], displayName: "FAQ", appearance: { borderRadius: 20 } } });
      expect(response.statusCode).toBe(201);
      expect(websites.create).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "workspace", actorId: "member",
        sourceInstallationId: source, origins: ["http://localhost:3200"], configuration: expect.objectContaining({ appearance: expect.objectContaining({ borderRadius: 20, windowWidth: 390 }) }) }));
      expect(response.json().deployment.installationId).not.toBe(source);
      expect(response.json().embedCode).toContain("http://localhost:3100/api/widget/v1/loader.js");
      const listed = await app.inject({ url: `/v1/installations/${source}/website-deployments` });
      expect(listed.json().deployments[0].embedCode).toContain("http://localhost:3100/api/widget/v1/loader.js");
      for (const origin of ["https://example.com/path", "https://user:password@example.com", "file:///tmp", "garbage"]) {
        expect((await app.inject({ method: "POST", url: `/v1/installations/${source}/website-deployments`, payload: { allowedOrigins: [origin] } })).statusCode).toBe(400);
      }
      expect(websites.create).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
  it("keeps updates scoped to the source installation and workspace", async () => {
    const { app, websites } = setup();
    try {
      expect((await app.inject({ method: "PATCH", url: `/v1/installations/${source}/website-deployments/${id}`, payload: { displayName: "Changed" } })).statusCode).toBe(404);
      expect(websites.update).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "workspace", sourceInstallationId: source, deploymentId: id }));
      expect((await app.inject({ method: "POST", url: `/v1/installations/${source}/website-deployments/${id}/status/PAUSED`, payload: {} })).statusCode).toBe(404);
      expect(websites.setStatus).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "workspace", sourceInstallationId: source, deploymentId: id, status: "PAUSED" }));
    } finally { await app.close(); }
  });
  it("rejects paths and credentials in origins", () => {
    expect(normalizeWebsiteOrigin("https://example.com:443/")).toBe("https://example.com");
    expect(() => normalizeWebsiteOrigin("https://example.com/?token=secret")).toThrow();
  });
});
