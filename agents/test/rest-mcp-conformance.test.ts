import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { buildApp } from "../src/http/app";
import type { AppConfig } from "../src/config";
import type { AgentRepository } from "../src/db/repositories/agent-repository";
import type { RunRepository } from "../src/db/repositories/run-repository";
import { signInternalToken } from "../src/http/auth";
import { issueInstallationToken } from "../src/auth/installation-token";

type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Route = { method: HttpMethod; path: string };

const installationTokenKeyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 4100,
  HOST: "127.0.0.1",
  AGENTS_DATABASE_URL: "postgres://unused",
  AGENTS_DATABASE_POOL_MAX: 1,
  TEMPORAL_ENABLED: false,
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "test",
  INTERNAL_AUTH_AUDIENCE: "test",
  AUTH_MODE: "headers",
  LOG_LEVEL: "silent",
};

const hmacConfig: AppConfig = {
  ...config,
  AUTH_MODE: "hmac",
  INTERNAL_AUTH_SECRET: "rest-mcp-conformance-secret",
  INSTALLATION_TOKEN_PRIVATE_KEY: installationTokenKeyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  INSTALLATION_TOKEN_ISSUER: "rest-mcp-conformance",
};

const fakePool = {
  query: async () => ({ rows: [{ ok: 1 }] }),
} as never;

const installationConfig: AppConfig = {
  ...config,
  INSTALLATION_TOKEN_PRIVATE_KEY: installationTokenKeyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  INSTALLATION_TOKEN_ISSUER: "rest-mcp-conformance",
};

function installationToken(audience: "mcp" | "kasitek-public-api", input: { installationId?: string; organizationId?: string; credentialId?: string } = {}): string {
  return issueInstallationToken({
    privateKeyPem: installationConfig.INSTALLATION_TOKEN_PRIVATE_KEY!,
    issuer: installationConfig.INSTALLATION_TOKEN_ISSUER,
    installationId: input.installationId ?? "install-1",
    organizationId: input.organizationId ?? "org-1",
    credentialId: input.credentialId ?? "credential-1",
    audience,
  }).accessToken;
}

function publicApiToken(input: { installationId?: string; organizationId?: string; credentialId?: string } = {}): string {
  return installationToken("kasitek-public-api", input);
}

function installationCredential(apiScopes: Array<"api:read" | "api:write"> = ["api:read", "api:write"]) {
  return {
    id: "credential-1",
    installation_id: "install-1",
    organization_id: "org-1",
    status: "active",
    mcp_scopes: ["mcp:read", "mcp:write"],
    api_scopes: apiScopes,
  };
}

function internalToken(scopes: string[] = [], operator = false): string {
  return signInternalToken({
    organizationId: "org-1",
    actorId: "actor-1",
    audience: hmacConfig.INTERNAL_AUTH_AUDIENCE,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    scopes,
    operator,
  }, hmacConfig.INTERNAL_AUTH_SECRET!);
}

function materialize(path: string): string {
  return path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    if (name === "status") return "active";
    if (name === "organizationId") return "org-1";
    return `sample-${name}`;
  });
}

function repositoryPath(relativePath: string): string {
  const cwd = process.cwd();
  const repositoryRoot = cwd.endsWith("/agents") ? resolve(cwd, "..") : cwd;
  return resolve(repositoryRoot, relativePath);
}

async function mountedAgentRoutes(): Promise<Route[]> {
  const source = await readFile(repositoryPath("agents/src/http/app.ts"), "utf8");
  const routePattern = /app\.(get|post|patch|put|delete)[\s\S]{0,220}?\(\s*["']([^"']+)["']/g;
  const routes: Route[] = [];
  for (const match of source.matchAll(routePattern)) {
    const method = match[1]?.toUpperCase() as HttpMethod | undefined;
    const path = match[2];
    if (method && path) routes.push({ method, path });
  }
  return routes;
}

const publicApiTransportPaths = new Set([
  "/v1/installations/:installationId/tools/call",
  "/v1/installations/:installationId/tools",
  "/v1/installations/:installationId/operations/:runId",
  "/v1/installations/:installationId/operations/:runId/events",
  "/v1/installations/:installationId/operations/:runId/cancel",
]);

function isPublicApiTransport(route: Route): boolean {
  return publicApiTransportPaths.has(route.path) && (
    route.path === "/v1/installations/:installationId/tools/call"
      ? route.method === "POST"
      : route.path === "/v1/installations/:installationId/tools"
        ? route.method === "GET"
        : route.method === "GET" || route.method === "POST"
  );
}

function isProviderWebhook(route: Route): boolean {
  return (route.path === "/v1/webhooks/telegram/:connectionId" || route.path === "/v1/webhooks/discord/:connectionId") && route.method === "POST";
}

function isPublicOAuthCallback(route: Route): boolean {
  return route.path === "/v1/integrations/google.calendar/oauth/callback" && route.method === "GET";
}

describe("Agent REST and MCP conformance matrices", () => {
  it("guards every mounted /v1 route before parsing input or touching dependencies", async () => {
    const routes = await mountedAgentRoutes();
    const protectedRoutes = routes.filter((route) => route.path.startsWith("/v1/") && route.path !== "/v1/installation-tokens/exchange" && !isPublicOAuthCallback(route));
    expect(routes).toHaveLength(201);
    expect(protectedRoutes).toHaveLength(194);

    const app = buildApp({ config, pool: fakePool });
    try {
      for (const route of protectedRoutes) {
        const response = await app.inject({ method: route.method, url: materialize(route.path) });
        expect(response.statusCode, `${route.method} ${route.path}`).toBe(401);
        expect(response.json()).toMatchObject({ error: expect.any(String) });
      }
    } finally {
      await app.close();
    }
  });

  it("enforces a non-empty scope on every internal HMAC route while keeping installation REST audience-specific", async () => {
    const routes = await mountedAgentRoutes();
    const directRoutes = routes.filter((route) =>
      route.path.startsWith("/v1/")
      && route.path !== "/v1/installation-tokens/exchange"
      && !isProviderWebhook(route)
      && !isPublicOAuthCallback(route)
      && !isPublicApiTransport(route),
    );
    expect(directRoutes).toHaveLength(187);

    const app = buildApp({ config: hmacConfig, pool: fakePool });
    try {
      for (const route of directRoutes) {
        const response = await app.inject({
          method: route.method,
          url: materialize(route.path),
          headers: { authorization: `Bearer ${internalToken()}` },
        });
        expect(response.statusCode, `${route.method} ${route.path}`).toBe(403);
      }

      for (const path of publicApiTransportPaths) {
        const route = routes.find((candidate) => candidate.path === path);
        expect(route, `missing public API route ${path}`).toBeDefined();
        const response = await app.inject({
          method: route!.method,
          url: materialize(path),
          headers: { authorization: `Bearer ${installationToken("mcp")}` },
        });
        expect(response.statusCode, `${route!.method} ${path}`).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it("covers installation REST ownership, feature, scope, cursor, and approval edge cases", async () => {
    const agents = {
      getInstallation: vi.fn(async () => ({ id: "install-1", organization_id: "org-1", agent_version_id: "version-1", status: "active", execution_mode: "external_connected" as const, agent_owner_type: "organization", agent_protected: false, agent_slug: "external-runtime" })),
    } as unknown as AgentRepository;
    const runs = {
      getRun: vi.fn(async () => ({ id: "run-1", organization_id: "org-1", installation_id: "install-1", status: "running" })),
      listEventsAfter: vi.fn(async () => []),
    } as unknown as RunRepository;
    const app = buildApp({
      config: installationConfig,
      pool: fakePool,
      agents,
      runs,
      installationCredentials: { getActiveForToken: async () => installationCredential() } as never,
      toolGrants: { effectiveTools: async () => new Set(["platform.current_time", "kasitek.core.content_post_publish"]) } as never,
      controls: { isFeatureEnabled: vi.fn(async () => true) } as never,
    });
    try {
      const wrongInstallation = await app.inject({
        method: "GET",
        url: "/v1/installations/install-2/tools",
        headers: { authorization: `Bearer ${publicApiToken()}` },
      });
      expect(wrongInstallation.statusCode).toBe(404);
      expect(wrongInstallation.json()).toEqual({ error: "installation_not_found" });

      const discovery = await app.inject({
        method: "GET",
        url: "/v1/installations/install-1/tools",
        headers: { authorization: `Bearer ${publicApiToken()}` },
      });
      expect(discovery.statusCode).toBe(200);

      const writeOnlyApp = buildApp({
        config: installationConfig,
        pool: fakePool,
        agents,
        installationCredentials: { getActiveForToken: async () => installationCredential(["api:write"]) } as never,
        toolGrants: { effectiveTools: async () => new Set(["platform.current_time"]) } as never,
        controls: { isFeatureEnabled: vi.fn(async () => true) } as never,
      });
      try {
        const writeOnlyDiscovery = await writeOnlyApp.inject({
          method: "GET",
          url: "/v1/installations/install-1/tools",
          headers: { authorization: `Bearer ${publicApiToken()}` },
        });
        expect(writeOnlyDiscovery.statusCode).toBe(403);
        expect(writeOnlyDiscovery.json()).toMatchObject({ error: "Public API credential is missing scope: api:read" });
      } finally {
        await writeOnlyApp.close();
      }

      const invalidCursor = await app.inject({
        method: "GET",
        url: "/v1/installations/install-1/operations/run-1/events?after=-1",
        headers: { authorization: `Bearer ${publicApiToken()}` },
      });
      expect(invalidCursor.statusCode).toBe(400);
      expect(invalidCursor.json()).toMatchObject({ error: "invalid_after_cursor" });

      const disabledApp = buildApp({
        config: installationConfig,
        pool: fakePool,
        agents,
        installationCredentials: { getActiveForToken: async () => installationCredential() } as never,
        controls: { isFeatureEnabled: vi.fn(async () => false) } as never,
      });
      try {
        const disabled = await disabledApp.inject({
          method: "GET",
          url: "/v1/installations/install-1/tools",
          headers: { authorization: `Bearer ${publicApiToken()}` },
        });
        expect(disabled.statusCode).toBe(403);
        expect(disabled.json()).toEqual({ error: "Public REST API is disabled by an active feature policy", code: "REST_FEATURE_DISABLED" });
      } finally {
        await disabledApp.close();
      }
    } finally {
      await app.close();
    }
  });

  it("keeps an approval-required operation equivalent across MCP and installation REST", async () => {
    const accept = vi.fn().mockResolvedValue({
      accepted: { id: "run-approval-parity", status: "awaiting_approval" },
      manifest: { requiresApproval: true },
    });
    const app = buildApp({
      config: { ...installationConfig, TEMPORAL_ENABLED: true },
      pool: fakePool,
      installationInvocations: { accept } as never,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_definition_id: "agent-1", agent_version_id: "version-1", status: "active", execution_mode: "external_connected" as const, agent_owner_type: "organization", agent_protected: false, agent_slug: "external-runtime" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => installationCredential() } as never,
      toolGrants: { effectiveTools: async () => new Set(["kasitek.core.content_post_publish"]) } as never,
      controls: { isFeatureEnabled: vi.fn(async () => true) } as never,
      killSwitches: { isBlocked: async () => false } as never,
    });
    try {
      const mcp = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${installationToken("mcp")}` },
        payload: {
          jsonrpc: "2.0",
          id: 81,
          method: "tools/call",
          params: { name: "kasitek.core.content_post_publish", arguments: { postId: "post-1", platform: "threads" }, idempotencyKey: "approval-parity-1" },
        },
      });
      const rest = await app.inject({
        method: "POST",
        url: "/v1/installations/install-1/tools/call",
        headers: { authorization: `Bearer ${publicApiToken()}` },
        payload: { name: "kasitek.core.content_post_publish", arguments: { postId: "post-1", platform: "threads" }, idempotencyKey: "approval-parity-1" },
      });

      expect(mcp.statusCode).toBe(200);
      expect(rest.statusCode).toBe(202);
      expect(mcp.json()).toMatchObject({ result: { structuredContent: { runId: "run-approval-parity", status: "awaiting_approval", approvalRequired: true } } });
      expect(rest.json()).toMatchObject({ operationId: "run-approval-parity", runId: "run-approval-parity", status: "awaiting_approval", approvalRequired: true });
      expect(accept).toHaveBeenCalledTimes(2);
      const [mcpInput, restInput] = accept.mock.calls.map(([input]) => input as Record<string, unknown>);
      expect(mcpInput).toMatchObject({ organizationId: "org-1", actorId: "installation:install-1", installationId: "install-1", name: "kasitek.core.content_post_publish", argumentsValue: { postId: "post-1", platform: "threads" } });
      expect(restInput).toMatchObject({ organizationId: mcpInput?.organizationId, actorId: mcpInput?.actorId, installationId: mcpInput?.installationId, name: mcpInput?.name, argumentsValue: mcpInput?.argumentsValue });
      expect(mcpInput?.idempotencyKey).toBe("mcp:credential-1:approval-parity-1");
      expect(restInput?.idempotencyKey).toBe("api:credential-1:approval-parity-1");
    } finally {
      await app.close();
    }
  });
});

describe("Core public v1 OpenAPI conformance", () => {
  it("matches every mounted route and documents a stable operation/error/security contract", async () => {
    const [source, openApiSource] = await Promise.all([
      readFile(repositoryPath("server/kasitek-core/src/api/public_v1.rs"), "utf8"),
      readFile(repositoryPath("server/kasitek-core/openapi/v1.json"), "utf8"),
    ]);
    const routePattern = /\.route\(\s*"([^"]+)"\s*,\s*web::(get|post|patch|put|delete)\(\)/g;
    const mounted = [...source.matchAll(routePattern)].map((match) => `${match[2]!.toUpperCase()} ${match[1]}`).sort();
    const document = JSON.parse(openApiSource) as {
      openapi: string;
      security?: unknown;
      paths: Record<string, Record<string, { operationId?: string; security?: unknown; responses?: Record<string, unknown> }>>;
    };
    const documented = Object.entries(document.paths).flatMap(([path, item]) => Object.entries(item)
      .filter(([method]) => ["get", "post", "patch", "put", "delete"].includes(method))
      .map(([method]) => `${method.toUpperCase()} ${path}`)).sort();

    expect(document.openapi).toBe("3.1.0");
    expect(document.security).toEqual([{ bearerInstallation: [] }, { productSession: [] }, { developerApiKey: [] }]);
    expect(documented).toEqual(mounted);
    expect(mounted).toHaveLength(22);

    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!["get", "post", "patch", "put", "delete"].includes(method)) continue;
        expect(operation.operationId, `${method.toUpperCase()} ${path} operationId`).toMatch(/^[A-Za-z][A-Za-z0-9]+$/);
        const responseCodes = Object.keys(operation.responses ?? {});
        expect(responseCodes.some((code) => code.startsWith("2")), `${method.toUpperCase()} ${path} success response`).toBe(true);
        if (path !== "/health" && path !== "/openapi.json") {
          expect(responseCodes, `${method.toUpperCase()} ${path} authentication response`).toContain("401");
          expect(operation.security, `${method.toUpperCase()} ${path} security inheritance`).toBeUndefined();
        } else {
          expect(operation.security, `${method.toUpperCase()} ${path} anonymous override`).toEqual([]);
        }
      }
    }
  });
});
