import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/http/app";
import type { AppConfig } from "../src/config";

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 4100,
  HOST: "127.0.0.1",
  AGENTS_DATABASE_URL: "postgres://unused",
  AGENTS_DATABASE_POOL_MAX: 1,
  TEMPORAL_ENABLED: false,
  TEMPORAL_MODE: "local",
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "test",
  KASIAI_MODEL_PROVIDER: "openrouter",
  KASIAI_MODEL: "openai/gpt-4o-mini",
  INTERNAL_AUTH_AUDIENCE: "test",
  AUTH_MODE: "headers",
  LOG_LEVEL: "silent",
};

const pool = { query: async () => ({ rows: [{ ok: 1 }] }) } as never;

afterEach(() => vi.unstubAllGlobals());

describe("organization provider model catalogs", () => {
  it("uses only an active credential owned by the authenticated organization", async () => {
    const credentials = {
      list: vi.fn(async (organizationId: string) => organizationId === "org-1"
        ? [{ id: "credential-1", provider: "openai", status: "active" }]
        : []),
      resolve: vi.fn(async () => ({ apiKey: "private-organization-key", fundingSource: "user" as const })),
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-organization-key");
      return new Response(JSON.stringify({ data: [{ id: "org-openai-model", name: "Organization Model" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = buildApp({ config, pool, credentials: credentials as never });

    const response = await app.inject({
      method: "POST",
      url: "/v1/models/catalog",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
      payload: { provider: "openai", credentialReference: "credential-1" },
    });
    const denied = await app.inject({
      method: "POST",
      url: "/v1/models/catalog",
      headers: { "x-organization-id": "org-2", "x-actor-id": "user-2" },
      payload: { provider: "openai", credentialReference: "credential-1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ provider: "openai", source: "live", models: [{ model: "org-openai-model" }] });
    expect(response.body).not.toContain("private-organization-key");
    expect(denied.statusCode).toBe(404);
    expect(credentials.resolve).toHaveBeenCalledTimes(1);
    expect(credentials.resolve).toHaveBeenCalledWith("org-1", "openai", "credential-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
