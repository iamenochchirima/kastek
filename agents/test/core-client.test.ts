import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { KasitekCoreReadClient } from "../src/core/client";

const context = {
  organizationId: "org-1",
  agentId: "agent-1",
  agentVersionId: "version-1",
  installationId: "install-1",
  runId: "run-1",
  actorId: "user-1",
  correlationId: "corr-1",
};

describe("kasitek-core read boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends scoped service authentication and returns a customer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ customer: { id: "cust-1" }, identities: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test/",
      KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
    });
    const result = await new KasitekCoreReadClient(config).getCustomer(context, "cust-1");
    expect(result.customer.id).toBe("cust-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://core.example.test/api/internal/agents/v1/customers/cust-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer internal-token",
          "x-organization-id": "org-1",
          "x-actor-id": "user-1",
          "x-agent-run-id": "run-1",
          "x-correlation-id": "corr-1",
        }),
      }),
    );
  });

  it("rejects an unconfigured boundary instead of silently falling back", async () => {
    const config = loadConfig({ AGENTS_DATABASE_URL: "postgres://localhost/agents" });
    await expect(new KasitekCoreReadClient(config).getCustomer(context, "cust-1")).rejects.toMatchObject({ code: "CORE_UNAVAILABLE" });
  });

  it("reads a workspace status snapshot through the scoped boundary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ organizationId: "org-1", connections: [] }), { status: 200 })));
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test",
      KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
    });
    await expect(new KasitekCoreReadClient(config).getWorkspaceStatus(context)).resolves.toMatchObject({ organizationId: "org-1" });
    expect(fetch).toHaveBeenCalledWith("https://core.example.test/api/internal/agents/v1/workspace/status", expect.any(Object));
  });
});
