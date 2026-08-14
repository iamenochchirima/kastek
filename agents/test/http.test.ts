import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/http/app";
import type { AgentRepository } from "../src/db/repositories/agent-repository";
import type { RunRepository } from "../src/db/repositories/run-repository";
import type { AppConfig } from "../src/config";
import type { PlatformChatRepository } from "../src/db/repositories/platform-chat-repository";
import { signInternalToken } from "../src/http/auth";
import { generateKeyPairSync, sign } from "node:crypto";
import { issueInstallationToken } from "../src/auth/installation-token";

const installationTokenKeyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const clientAssertionKeyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

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

const fakePool = {
  query: async () => ({ rows: [{ ok: 1 }] }),
} as never;

const mcpConfig: AppConfig = {
  ...config,
  INSTALLATION_TOKEN_PRIVATE_KEY: installationTokenKeyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  INSTALLATION_TOKEN_ISSUER: "test-agent-platform",
};

function mcpToken(input: { installationId?: string; organizationId?: string; credentialId?: string } = {}): string {
  return issueInstallationToken({
    privateKeyPem: mcpConfig.INSTALLATION_TOKEN_PRIVATE_KEY!,
    issuer: mcpConfig.INSTALLATION_TOKEN_ISSUER,
    installationId: input.installationId ?? "install-1",
    organizationId: input.organizationId ?? "org-1",
    credentialId: input.credentialId ?? "credential-1",
    audience: "mcp",
  }).accessToken;
}

function publicApiToken(input: { installationId?: string; organizationId?: string; credentialId?: string } = {}): string {
  return issueInstallationToken({
    privateKeyPem: mcpConfig.INSTALLATION_TOKEN_PRIVATE_KEY!,
    issuer: mcpConfig.INSTALLATION_TOKEN_ISSUER,
    installationId: input.installationId ?? "install-1",
    organizationId: input.organizationId ?? "org-1",
    credentialId: input.credentialId ?? "credential-1",
    audience: "kasitek-public-api",
  }).accessToken;
}

function clientAssertion(): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT", kid: "client-key-1" });
  const payload = encode({ iss: "client-key-1", sub: "credential-1", aud: "kasitek-agents-token", iat: now, exp: now + 120, jti: `assertion-${now}` });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: clientAssertionKeyPair.privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function mcpCredential(scopes: Array<"mcp:read" | "mcp:write"> = ["mcp:read", "mcp:write"]) {
  return {
    id: "credential-1",
    installation_id: "install-1",
    organization_id: "org-1",
    status: "active",
    mcp_scopes: scopes,
    api_scopes: ["api:read", "api:write"],
  };
}

describe("Agent Platform HTTP foundation", () => {
  it("serves the MCP initialize contract without requiring tenant credentials", async () => {
    const app = buildApp({
      config: mcpConfig,
      pool: fakePool,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => mcpCredential() } as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${mcpToken()}` },
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { capabilities: { tools: { listChanged: false } } } });
    await app.close();
  });

  it("returns a structured MCP error when the scoped MCP feature flag is disabled", async () => {
    const app = buildApp({
      config: mcpConfig,
      pool: fakePool,
      controls: { isFeatureEnabled: vi.fn(async (_organizationId: string, flagKey: string) => flagKey !== "mcp_enabled") } as never,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => mcpCredential() } as never,
    });
    const response = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${mcpToken()}` }, payload: { jsonrpc: "2.0", id: 9, method: "initialize" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ error: { code: -32031, message: "mcp_feature_disabled", data: { code: "MCP_FEATURE_DISABLED" } } });
    await app.close();
  });

  it("requires the configured gateway secret before accepting MCP traffic", async () => {
    const app = buildApp({ config: { ...mcpConfig, AGENT_GATEWAY_SHARED_SECRET: "gateway-secret" }, pool: fakePool });
    const response = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 4, method: "initialize" } });
    expect(response.json()).toMatchObject({ error: { code: -32003 } });
    await app.close();
  });

  it("publishes protected-resource metadata for MCP clients", async () => {
    const app = buildApp({ config, pool: fakePool });
    const response = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      resource: "/mcp",
      bearer_methods_supported: ["header"],
      installation_token_exchange_endpoint: "/v1/installation-tokens/exchange",
    });
    await app.close();
  });

  it("keeps platform operator projections behind a distinct operator principal", async () => {
    const app = buildApp({ config, pool: fakePool });
    const denied = await app.inject({ method: "GET", url: "/v1/operator/health", headers: { "x-organization-id": "platform", "x-actor-id": "admin-1" } });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({ method: "GET", url: "/v1/operator/health", headers: { "x-organization-id": "platform", "x-actor-id": "admin-1", "x-kasitek-operator": "true" } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ scope: "platform", status: "ready", database: { status: "ready" } });
    await app.close();
  });

  it("keeps feature-flag and incident-hold projections behind operator:read", async () => {
    const app = buildApp({
      config,
      pool: fakePool,
      controls: {
        listFeatureFlags: vi.fn(async () => [{ id: "flag-1", scope_type: "organization", scope_id: "org-1", flag_key: "mcp_enabled", enabled: false }]),
        listHolds: vi.fn(async () => [{ id: "hold-1", organization_id: "org-1", scope_type: "run", scope_id: "run-1", hold_type: "execution", status: "active" }]),
      } as never,
    });
    const denied = await app.inject({ method: "GET", url: "/v1/operator/feature-flags", headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" } });
    expect(denied.statusCode).toBe(403);
    const flags = await app.inject({ method: "GET", url: "/v1/operator/feature-flags?limit=10", headers: { "x-organization-id": "platform", "x-actor-id": "admin-1", "x-kasitek-operator": "true" } });
    expect(flags.statusCode).toBe(200);
    expect(flags.json()).toEqual({ featureFlags: [{ id: "flag-1", scope_type: "organization", scope_id: "org-1", flag_key: "mcp_enabled", enabled: false }] });
    const holds = await app.inject({ method: "GET", url: "/v1/operator/holds?limit=10", headers: { "x-organization-id": "platform", "x-actor-id": "admin-1", "x-kasitek-operator": "true" } });
    expect(holds.statusCode).toBe(200);
    expect(holds.json()).toMatchObject({ holds: [{ id: "hold-1", organization_id: "org-1", status: "active" }] });
    await app.close();
  });

  it("rejects operator commands without an idempotency key before touching storage", async () => {
    const app = buildApp({ config, pool: fakePool });
    const response = await app.inject({
      method: "POST",
      url: "/v1/operator/commands",
      headers: { "x-organization-id": "platform", "x-actor-id": "admin-1", "x-kasitek-operator": "true" },
      payload: { commandType: "cancel_run", targetId: "run-1" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "idempotency-key must be 8-240 characters" });
    await app.close();
  });

  it("uses the read operator scope for command inspection", async () => {
    const hmacConfig: AppConfig = {
      ...config,
      AUTH_MODE: "hmac",
      INTERNAL_AUTH_SECRET: "test-secret",
      INTERNAL_AUTH_AUDIENCE: "test",
    };
    const app = buildApp({ config: hmacConfig, pool: fakePool });
    const token = signInternalToken({
      organizationId: "platform",
      actorId: "admin-1",
      audience: "test",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      scopes: ["operator:read"],
      operator: true,
    }, "test-secret");
    const response = await app.inject({
      method: "GET",
      url: "/v1/operator/commands/command-1",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("keeps projection rebuild and notification reads behind the operator boundary", async () => {
    const app = buildApp({ config, pool: fakePool });
    const denied = await app.inject({ method: "GET", url: "/v1/operator/projections/summary", headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" } });
    expect(denied.statusCode).toBe(403);
    const invalid = await app.inject({ method: "GET", url: "/v1/operator/projections/not-a-projection", headers: { "x-organization-id": "platform", "x-actor-id": "admin-1", "x-kasitek-operator": "true" } });
    expect(invalid.statusCode).toBe(400);
    const notifications = await app.inject({ method: "GET", url: "/v1/operator/notifications", headers: { "x-organization-id": "platform", "x-actor-id": "admin-1", "x-kasitek-operator": "true" } });
    expect(notifications.statusCode).toBe(200);
    await app.close();
  });

  it("exchanges a registered client assertion once and rejects its replay", async () => {
    const getActiveForClientAssertion = vi.fn(async () => ({ ...mcpCredential(), client_key_id: "client-key-1", client_public_key: clientAssertionKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString() }));
    const consumeClientAssertionReplay = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const markUsed = vi.fn().mockResolvedValue(undefined);
    const app = buildApp({
      config: mcpConfig,
      pool: fakePool,
      installationCredentials: { getActiveForClientAssertion, consumeClientAssertionReplay, markUsed } as never,
    });
    const payload = { clientAssertion: clientAssertion(), audience: "mcp" };
    const first = await app.inject({ method: "POST", url: "/v1/installation-tokens/exchange", payload });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ tokenType: "Bearer", audience: "mcp" });
    expect(getActiveForClientAssertion).toHaveBeenCalledWith({ credentialId: "credential-1", clientKeyId: "client-key-1" });
    expect(markUsed).toHaveBeenCalledWith("credential-1");
    const replay = await app.inject({ method: "POST", url: "/v1/installation-tokens/exchange", payload });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ error: "invalid_installation_client_assertion" });
    await app.close();
  });

  it("negotiates the supported MCP protocol revision and rejects incompatible clients", async () => {
    const app = buildApp({
      config: mcpConfig,
      pool: fakePool,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => mcpCredential() } as never,
    });
    const supported = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${mcpToken()}`, "mcp-protocol-version": "2025-06-18" }, payload: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    expect(supported.statusCode).toBe(200);
    expect(supported.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(supported.json()).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
    const incompatible = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${mcpToken()}`, "mcp-protocol-version": "2099-01-01" }, payload: { jsonrpc: "2.0", id: 2, method: "initialize" } });
    expect(incompatible.statusCode).toBe(200);
    expect(incompatible.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(incompatible.json()).toMatchObject({ error: { code: -32602, message: "unsupported_mcp_protocol_version" } });
    await app.close();
  });

  it("accepts JSON-RPC notifications without emitting a response body", async () => {
    const app = buildApp({
      config: mcpConfig,
      pool: fakePool,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => mcpCredential() } as never,
    });
    const response = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${mcpToken()}` }, payload: { jsonrpc: "2.0", method: "notifications/initialized" } });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    await app.close();
  });

  it("returns a structured JSON-RPC error for malformed MCP envelopes", async () => {
    const app = buildApp({ config: mcpConfig, pool: fakePool });
    const response = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "1.0", method: "initialize" } });
    expect(response.statusCode).toBe(400);
    expect(response.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(response.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid_mcp_request" } });
    await app.close();
  });

  it("returns a structured method-not-found error for an authenticated MCP client", async () => {
    const app = buildApp({
      config: mcpConfig,
      pool: fakePool,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => mcpCredential() } as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${mcpToken()}` },
      payload: { jsonrpc: "2.0", id: 33, method: "not/a/method" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ jsonrpc: "2.0", id: 33, error: { code: -32601, message: "method_not_found" } });
    await app.close();
  });

  it("filters MCP tools by the installation grant set", async () => {
    const app = buildApp({
      config: mcpConfig,
      pool: fakePool,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_definition_id: "agent-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      toolGrants: { effectiveTools: async () => new Set(["platform.current_time"]) } as never,
      installationCredentials: { getActiveForToken: async () => mcpCredential() } as never,
    });
    const response = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${mcpToken()}` }, payload: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual(["platform.current_time"]);
    const denied = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${mcpToken()}` }, payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kasitek.core.customer_get", arguments: { customerId: "customer-1" } } } });
    expect(denied.json()).toMatchObject({ jsonrpc: "2.0", id: 3, error: { code: -32001 } });
    await app.close();
  });

  it("enforces a scoped MCP kill switch before serving methods and resumes after it is cleared", async () => {
    const isBlocked = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const app = buildApp({
      config: mcpConfig,
      pool: fakePool,
      killSwitches: { isBlocked } as never,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_definition_id: "agent-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      toolGrants: { effectiveTools: async () => new Set(["platform.current_time"]) } as never,
      installationCredentials: { getActiveForToken: async () => mcpCredential() } as never,
    });
    const blocked = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${mcpToken()}` }, payload: { jsonrpc: "2.0", id: 20, method: "tools/list" } });
    expect(blocked.json()).toMatchObject({ error: { code: -32030, message: "mcp_kill_switch_active", data: { code: "MCP_KILL_SWITCH_ACTIVE" } } });
    const resumed = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${mcpToken()}` }, payload: { jsonrpc: "2.0", id: 21, method: "tools/list" } });
    expect(resumed.json()).toMatchObject({ result: { tools: [{ name: "platform.current_time" }] } });
    expect(isBlocked).toHaveBeenCalledWith({ organizationId: "org-1", agentId: "agent-1", installationId: "install-1" });
    await app.close();
  });

  it("revalidates an installation credential before core-facing capability discovery", async () => {
    const getActiveForToken = vi.fn()
      .mockResolvedValueOnce(mcpCredential())
      .mockResolvedValueOnce(mcpCredential())
      .mockResolvedValueOnce(null);
    const app = buildApp({
      config: { ...config, AUTH_MODE: "headers" as const },
      pool: fakePool,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      toolGrants: { effectiveTools: async () => new Set(["platform.current_time"]) } as never,
      installationCredentials: { getActiveForToken } as never,
    });
    const active = await app.inject({ method: "GET", url: "/v1/installations/install-1/capabilities?credentialId=credential-1", headers: { "x-organization-id": "org-1", "x-actor-id": "core" } });
    const revoked = await app.inject({ method: "GET", url: "/v1/installations/install-1/capabilities?credentialId=credential-1", headers: { "x-organization-id": "org-1", "x-actor-id": "core" } });
    expect(active.statusCode).toBe(200);
    expect(active.json()).toMatchObject({ apiScopes: ["api:read", "api:write"] });
    const currentTimeCapability = active.json().capabilities.find((capability: { name: string }) => capability.name === "platform.current_time");
    expect(currentTimeCapability).toMatchObject({
      name: "platform.current_time",
      availability: "available",
      permission: { scope: "platform.time.read", label: "Platform Time Read permission" },
      audit: { classification: "access" },
      documentation: { title: "Platform Current Time" },
    });
    expect(revoked.statusCode).toBe(401);
    await app.close();
  });

  it("rejects HMAC and cross-installation credentials from MCP", async () => {
    const app = buildApp({
      config: { ...mcpConfig, AUTH_MODE: "hmac", INTERNAL_AUTH_SECRET: "internal-secret" },
      pool: fakePool,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => mcpCredential() } as never,
    });
    const internal = signInternalToken({ organizationId: "org-1", actorId: "internal", audience: "test", expiresAt: Math.floor(Date.now() / 1000) + 60, scopes: ["mcp:read"] }, "internal-secret");
    const internalResponse = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${internal}` }, payload: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    expect(internalResponse.json()).toMatchObject({ error: { code: -32003, message: "Invalid MCP installation token" } });
    const mismatch = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${mcpToken()}` }, payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: { installationId: "install-2" } } });
    expect(mismatch.json()).toMatchObject({ error: { code: -32602 } });
    await app.close();
  });

  it("applies the credential MCP policy at call time", async () => {
    const app = buildApp({
      config: mcpConfig,
      pool: fakePool,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_definition_id: "agent-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => mcpCredential(["mcp:read"]) } as never,
      toolGrants: { effectiveTools: async () => new Set(["platform.current_time"]) } as never,
    });
    const response = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${mcpToken()}` }, payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "platform.current_time", arguments: {} } } });
    expect(response.json()).toMatchObject({ error: { code: -32003, message: "MCP credential is missing scope: mcp:write" } });
    await app.close();
  });

  it("routes MCP tool calls through a durable Agent run", async () => {
    const startWorkflow = vi.fn().mockResolvedValue(undefined);
    const runs = { createRun: vi.fn().mockResolvedValue({ id: "run-mcp-1", status: "received", created: true }) } as unknown as RunRepository;
    const app = buildApp({
      config: { ...mcpConfig, TEMPORAL_ENABLED: true },
      pool: fakePool,
      runs,
      startWorkflow,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_definition_id: "agent-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => mcpCredential() } as never,
      toolGrants: { effectiveTools: async () => new Set(["platform.current_time"]) } as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${mcpToken()}` },
      payload: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "platform.current_time", arguments: {}, idempotencyKey: "request-1" } },
    });
    expect(response.json()).toMatchObject({ result: { structuredContent: { runId: "run-mcp-1", status: "received", statusReference: { method: "tools/status", params: { runId: "run-mcp-1" } } } } });
    expect(runs.createRun).toHaveBeenCalledWith("org-1", "installation:install-1", expect.objectContaining({ installationId: "install-1", idempotencyKey: "mcp:credential-1:request-1", input: { mcpTool: expect.objectContaining({ name: "platform.current_time" }) } }));
    expect(startWorkflow).toHaveBeenCalledWith("run-mcp-1");
    await app.close();
  });

  it("cancels only the authenticated installation's durable MCP operation", async () => {
    const signalCancellation = vi.fn().mockResolvedValue(undefined);
    const getRun = vi.fn().mockResolvedValue({ id: "run-mcp-1", organization_id: "org-1", installation_id: "install-1", status: "running" });
    const runs = {
      getRun,
    } as unknown as RunRepository;
    const app = buildApp({
      config: { ...mcpConfig, TEMPORAL_ENABLED: true },
      pool: fakePool,
      runs,
      signalCancellation,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => mcpCredential() } as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${mcpToken()}` },
      payload: { jsonrpc: "2.0", method: "notifications/cancelled", params: { runId: "run-mcp-1", reason: "client stopped" } },
    });
    expect(response.statusCode).toBe(204);
    expect(signalCancellation).toHaveBeenCalledWith("run-mcp-1", { reason: "installation:install-1: client stopped" });
    getRun.mockResolvedValueOnce({ id: "run-other", organization_id: "org-1", installation_id: "install-other", status: "running" });
    const denied = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${mcpToken()}` },
      payload: { jsonrpc: "2.0", id: 8, method: "notifications/cancelled", params: { runId: "run-other" } },
    });
    expect(denied.json()).toMatchObject({ error: { code: -32004, message: "operation_not_found" } });
    getRun.mockResolvedValueOnce({ id: "run-completed", organization_id: "org-1", installation_id: "install-1", status: "completed" });
    const completed = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${mcpToken()}` },
      payload: { jsonrpc: "2.0", id: 10, method: "notifications/cancelled", params: { runId: "run-completed" } },
    });
    expect(completed.json()).toMatchObject({ result: { runId: "run-completed", status: "completed" } });
    expect(signalCancellation).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("returns a scoped MCP operation status with its durable approval reference", async () => {
    const app = buildApp({
      config: mcpConfig,
      pool: fakePool,
      runs: { getRun: async () => ({ id: "run-mcp-approval", organization_id: "org-1", installation_id: "install-1", status: "awaiting_approval" }) } as unknown as RunRepository,
      approvals: { getForRun: async () => ({ status: "pending", provider_tool_call_id: "call-approval", capability: "kasitek.core.content_post_publish", expires_at: "2026-08-13T12:00:00.000Z" }) } as never,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => mcpCredential() } as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${mcpToken()}` },
      payload: { jsonrpc: "2.0", id: 9, method: "tools/status", params: { runId: "run-mcp-approval" } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: {
        structuredContent: {
          runId: "run-mcp-approval",
          status: "awaiting_approval",
          terminal: false,
          approval: { status: "pending", providerToolCallId: "call-approval" },
        },
      },
    });
    await app.close();
  });

  it("routes public API tool calls through the same durable Agent run boundary", async () => {
    const startWorkflow = vi.fn().mockResolvedValue(undefined);
    const runs = { createRun: vi.fn().mockResolvedValue({ id: "run-api-1", status: "received", created: true }) } as unknown as RunRepository;
    const app = buildApp({
      config: { ...mcpConfig, TEMPORAL_ENABLED: true },
      pool: fakePool,
      runs,
      startWorkflow,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_definition_id: "agent-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => mcpCredential() } as never,
      toolGrants: { effectiveTools: async () => new Set(["platform.current_time"]) } as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/installations/install-1/tools/call",
      headers: { authorization: `Bearer ${publicApiToken()}` },
      payload: { name: "platform.current_time", arguments: {}, idempotencyKey: "api-request-1" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ operationId: "run-api-1", runId: "run-api-1", durable: true });
    expect(runs.createRun).toHaveBeenCalledWith("org-1", "installation:install-1", expect.objectContaining({ idempotencyKey: "api:credential-1:api-request-1", input: { mcpTool: expect.objectContaining({ name: "platform.current_time" }) } }));
    expect(startWorkflow).toHaveBeenCalledWith("run-api-1");
    await app.close();
  });

  it("keeps MCP and public REST protocol adapters on the same acceptance contract", async () => {
    const accept = vi.fn().mockResolvedValue({
      accepted: { id: "run-parity-1", status: "received" },
      manifest: { requiresApproval: false },
    });
    const app = buildApp({
      config: { ...mcpConfig, TEMPORAL_ENABLED: true },
      pool: fakePool,
      installationInvocations: { accept } as never,
      killSwitches: { isBlocked: async () => false } as never,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_definition_id: "agent-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => mcpCredential() } as never,
      toolGrants: { effectiveTools: async () => new Set(["platform.current_time"]) } as never,
    });

    const mcp = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${mcpToken()}` },
      payload: {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "platform.current_time", arguments: {}, toolCallId: "shared-call-1", idempotencyKey: "shared-key-1" },
      },
    });
    const rest = await app.inject({
      method: "POST",
      url: "/v1/installations/install-1/tools/call",
      headers: { authorization: `Bearer ${publicApiToken()}` },
      payload: { name: "platform.current_time", arguments: {}, toolCallId: "shared-call-1", idempotencyKey: "shared-key-1" },
    });

    expect(mcp.statusCode).toBe(200);
    expect(rest.statusCode).toBe(202);
    expect(mcp.json()).toMatchObject({ result: { structuredContent: { runId: "run-parity-1", status: "received" } } });
    expect(rest.json()).toMatchObject({ operationId: "run-parity-1", runId: "run-parity-1", status: "received" });
    expect(accept).toHaveBeenCalledTimes(2);
    const [mcpInput, restInput] = accept.mock.calls.map(([input]) => input as Record<string, unknown>);
    expect(mcpInput).toMatchObject({
      organizationId: "org-1",
      actorId: "installation:install-1",
      installationId: "install-1",
      name: "platform.current_time",
      argumentsValue: {},
      toolCallId: "shared-call-1",
    });
    expect(restInput).toMatchObject({
      organizationId: mcpInput?.organizationId,
      actorId: mcpInput?.actorId,
      installationId: mcpInput?.installationId,
      name: mcpInput?.name,
      argumentsValue: mcpInput?.argumentsValue,
      toolCallId: mcpInput?.toolCallId,
    });
    expect(mcpInput?.idempotencyKey).toBe("mcp:credential-1:shared-key-1");
    expect(restInput?.idempotencyKey).toBe("api:credential-1:shared-key-1");
    await app.close();
  });

  it("rejects malformed MCP idempotency keys instead of silently generating a new operation", async () => {
    const accept = vi.fn();
    const app = buildApp({
      config: mcpConfig,
      pool: fakePool,
      installationInvocations: { accept } as never,
      killSwitches: { isBlocked: async () => false } as never,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_definition_id: "agent-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => mcpCredential() } as never,
      toolGrants: { effectiveTools: async () => new Set(["platform.current_time"]) } as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${mcpToken()}` },
      payload: { jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "platform.current_time", arguments: {}, idempotencyKey: "short" } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ jsonrpc: "2.0", id: 32, error: { code: -32602, message: "idempotencyKey must be 8-240 characters when provided" } });
    expect(accept).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects malformed REST idempotency keys before capability dispatch", async () => {
    const accept = vi.fn();
    const app = buildApp({
      config: mcpConfig,
      pool: fakePool,
      installationInvocations: { accept } as never,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_definition_id: "agent-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => mcpCredential() } as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/installations/install-1/tools/call",
      headers: { authorization: `Bearer ${publicApiToken()}` },
      payload: { name: "platform.current_time", arguments: {}, idempotencyKey: "short" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Invalid request");
    expect(accept).not.toHaveBeenCalled();
    await app.close();
  });

  it("discovers only the tools granted to an installation over the public API", async () => {
    const app = buildApp({
      config: mcpConfig,
      pool: fakePool,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => ({ ...mcpCredential(), api_scopes: ["api:read"] }) } as never,
      toolGrants: { effectiveTools: async () => new Set(["platform.current_time"]) } as never,
    });
    const response = await app.inject({ method: "GET", url: "/v1/installations/install-1/tools", headers: { authorization: `Bearer ${publicApiToken()}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ installationId: "install-1", tools: [{
      name: "platform.current_time",
      riskClass: "read",
      permission: { scope: "platform.time.read" },
      audit: { classification: "access" },
    }] });
    expect(response.json().tools).toHaveLength(1);
    await app.close();
  });

  it("rejects invalid, expired, and wrong-audience public API installation principals", async () => {
    const app = buildApp({
      config: mcpConfig,
      pool: fakePool,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => ({ ...mcpCredential(), api_scopes: ["api:read"] }) } as never,
      toolGrants: { effectiveTools: async () => new Set(["platform.current_time"]) } as never,
    });
    const expired = issueInstallationToken({
      privateKeyPem: mcpConfig.INSTALLATION_TOKEN_PRIVATE_KEY!,
      issuer: mcpConfig.INSTALLATION_TOKEN_ISSUER,
      installationId: "install-1",
      organizationId: "org-1",
      credentialId: "credential-1",
      audience: "kasitek-public-api",
      now: Math.floor(Date.now() / 1000) - 3_600,
    }).accessToken;
    const wrongAudience = mcpToken();
    const invalid = "eyJhbGciOiJFUzI1NiJ9.invalid.signature";
    for (const token of [expired, wrongAudience, invalid]) {
      const response = await app.inject({ method: "GET", url: "/v1/installations/install-1/tools", headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(401);
    }
    await app.close();
  });

  it("rejects a credential or installation record whose ownership disagrees with token claims", async () => {
    const app = buildApp({
      config: mcpConfig,
      pool: fakePool,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-2", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => ({ ...mcpCredential(), organization_id: "org-2" }) } as never,
    });
    const response = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${mcpToken()}` }, payload: { jsonrpc: "2.0", id: 34, method: "initialize" } });
    expect(response.json()).toMatchObject({ error: { code: -32003, message: "MCP installation credential is no longer active" } });
    await app.close();
  });

  it("lists an installation's durable runs without crossing installation boundaries", async () => {
    const runs = { listInstallationRuns: vi.fn().mockResolvedValue([{ id: "run-1", installation_id: "install-1", status: "completed" }]), listOrganizationRuns: vi.fn().mockResolvedValue([{ id: "run-1", organization_id: "org-1", installation_id: "install-1", status: "completed" }]) } as unknown as RunRepository;
    const app = buildApp({
      config,
      pool: fakePool,
      runs,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", status: "active" }) } as unknown as AgentRepository,
    });
    const response = await app.inject({ method: "GET", url: "/v1/installations/install-1/runs?limit=20", headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ installationId: "install-1", runs: [{ id: "run-1", installation_id: "install-1" }] });
    expect(runs.listInstallationRuns).toHaveBeenCalledWith("org-1", "install-1", 20);
    await app.close();
  });

  it("lists recent runs for the authenticated organization", async () => {
    const listOrganizationRuns = vi.fn().mockResolvedValue([
      { id: "run-1", organization_id: "org-1", installation_id: "install-1", status: "completed", agent_name: "KasiAi" },
    ]);
    const app = buildApp({
      config,
      pool: fakePool,
      runs: { listOrganizationRuns } as unknown as RunRepository,
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/operations/runs?limit=25",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ runs: [{ id: "run-1", organization_id: "org-1", agent_name: "KasiAi" }] });
    expect(listOrganizationRuns).toHaveBeenCalledWith("org-1", 25);
    await app.close();
  });

  it("lets a read-only public API credential invoke reads but not mutations", async () => {
    const startWorkflow = vi.fn().mockResolvedValue(undefined);
    const app = buildApp({
      config: { ...mcpConfig, TEMPORAL_ENABLED: true },
      pool: fakePool,
      runs: { createRun: vi.fn().mockResolvedValue({ id: "run-read-1", status: "received", created: true }) } as unknown as RunRepository,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => ({ ...mcpCredential(), api_scopes: ["api:read"] }) } as never,
      toolGrants: { effectiveTools: async () => new Set(["platform.current_time", "kasitek.core.content_post_draft"]) } as never,
      startWorkflow,
    });
    const read = await app.inject({
      method: "POST",
      url: "/v1/installations/install-1/tools/call",
      headers: { authorization: `Bearer ${publicApiToken()}` },
      payload: { name: "platform.current_time", arguments: {}, idempotencyKey: "api-read-only-1" },
    });
    expect(read.statusCode).toBe(202);
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/installations/install-1/tools/call",
      headers: { authorization: `Bearer ${publicApiToken()}` },
      payload: { name: "platform.current_time", arguments: { unexpected: true }, idempotencyKey: "api-read-only-invalid" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "invalid_tool_arguments" });
    const write = await app.inject({
      method: "POST",
      url: "/v1/installations/install-1/tools/call",
      headers: { authorization: `Bearer ${publicApiToken()}` },
      payload: { name: "kasitek.core.content_post_draft", arguments: { content: { text: "draft" } }, idempotencyKey: "api-read-only-2" },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ error: "Public API credential is missing scope: api:write" });
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("exposes installation-scoped operation status and cancellation over the public API", async () => {
    const signalCancellation = vi.fn().mockResolvedValue(undefined);
    const getRun = vi.fn().mockResolvedValue({ id: "run-api-1", organization_id: "org-1", installation_id: "install-1", status: "running" });
    const runs = {
      getRun,
      listEvents: vi.fn().mockResolvedValue([{ event_type: "run.started" }]),
      listEventsAfter: vi.fn().mockResolvedValue([{ sequence_number: 2, event_type: "tool.completed", payload: { message: "safe", secret: "redacted" }, created_at: "2026-08-13T00:00:00.000Z" }]),
    } as unknown as RunRepository;
    const app = buildApp({
      config: { ...mcpConfig, TEMPORAL_ENABLED: true },
      pool: fakePool,
      runs,
      approvals: { getForRun: async () => ({ status: "approved", provider_tool_call_id: "call-api", capability: "test.effect", expires_at: "2026-08-13T12:00:00.000Z" }) } as never,
      signalCancellation,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => mcpCredential() } as never,
    });
    const status = await app.inject({ method: "GET", url: "/v1/installations/install-1/operations/run-api-1", headers: { authorization: `Bearer ${publicApiToken()}` } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ operationId: "run-api-1", run: { id: "run-api-1" }, approval: { status: "approved", providerToolCallId: "call-api" }, events: [{ event_type: "run.started" }] });
    const events = await app.inject({ method: "GET", url: "/v1/installations/install-1/operations/run-api-1/events?after=1", headers: { authorization: `Bearer ${publicApiToken()}` } });
    expect(events.statusCode).toBe(200);
    expect(events.json()).toMatchObject({ operationId: "run-api-1", nextAfter: 2, events: [{ event_type: "tool.completed", payload: { message: "safe" } }] });
    expect(events.json().events[0].payload).not.toHaveProperty("secret");
    const cancelled = await app.inject({ method: "POST", url: "/v1/installations/install-1/operations/run-api-1/cancel", headers: { authorization: `Bearer ${publicApiToken()}` }, payload: { reason: "client stopped" } });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ operationId: "run-api-1", status: "cancellation_signalled" });
    expect(signalCancellation).toHaveBeenCalledWith("run-api-1", { reason: "installation:install-1: client stopped" });
    getRun.mockResolvedValueOnce({ id: "run-other", organization_id: "org-1", installation_id: "install-other", status: "running" });
    const denied = await app.inject({ method: "GET", url: "/v1/installations/install-1/operations/run-other", headers: { authorization: `Bearer ${publicApiToken()}` } });
    expect(denied.statusCode).toBe(404);
    await app.close();
  });

  it("resumes a human handoff through the scoped event boundary", async () => {
    const signalExternalEvent = vi.fn().mockResolvedValue(undefined);
    const app = buildApp({
      config: { ...config, TEMPORAL_ENABLED: true },
      pool: fakePool,
      runs: { getRun: async () => ({ id: "handoff-1", organization_id: "org-1", installation_id: "install-1", status: "awaiting_human" }) } as unknown as RunRepository,
      signalExternalEvent,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/runs/handoff-1/external-event",
      headers: { "x-organization-id": "org-1", "x-actor-id": "operator-1" },
      payload: { key: "support.resolved", payload: { resolution: "accepted" } },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ runId: "handoff-1", status: "handoff_signalled", key: "support.resolved" });
    expect(signalExternalEvent).toHaveBeenCalledWith("handoff-1", { key: "support.resolved", payload: { resolution: "accepted" } });
    await app.close();
  });

  it("requires an explicit organization and actor scope", async () => {
    const app = buildApp({ config, pool: fakePool });
    const response = await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "Test" } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("creates an agent through the scoped control-plane contract", async () => {
    const agents = {
      createAgent: async () => ({ id: "agent-1", name: "Test" }),
    } as unknown as AgentRepository;
    const app = buildApp({ config, pool: fakePool, agents });
    const response = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
      payload: { name: "Test agent" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: "agent-1" });
    await app.close();
  });

  it("ensures the protected KasiAi installation for the authenticated organization", async () => {
    const agents = {
      ensureSystemInstallation: async (input: { organizationId: string; actorId: string }) => ({
        id: "installation-1",
        organization_id: input.organizationId,
        created: true,
        created_by: input.actorId,
        agent_slug: "kasiai",
      }),
    } as unknown as AgentRepository;
    const app = buildApp({ config, pool: fakePool, agents });
    const response = await app.inject({
      method: "POST",
      url: "/v1/system-agents/kasiai/installation",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
      payload: { language: "en", tone: "balanced" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: "installation-1",
      organization_id: "org-1",
      created_by: "user-1",
      agent_slug: "kasiai",
    });
    await app.close();
  });

  it("loads a non-mutating, owner-scoped KasiAi home payload", async () => {
    const agents = {
      getInstallation: async (organizationId: string, installationId: string) => ({ id: installationId, organization_id: organizationId, status: "active" }),
    } as unknown as AgentRepository;
    const app = buildApp({
      config,
      pool: fakePool,
      agents,
      conversations: {
        listOwnerConversations: async (_organizationId: string, _installationId: string, ownerActorId: string) => [
          { id: "chat-1", owner_actor_id: ownerActorId, status: "active", is_primary: true },
          { id: "chat-2", owner_actor_id: ownerActorId, status: "archived", is_primary: false },
        ],
      } as never,
      kasiaiPreferences: { get: async (_organizationId: string, _installationId: string, ownerActorId: string) => ({ owner_actor_id: ownerActorId, tone: "balanced" }) } as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/installations/install-1/kasiai/home",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      conversations: [{ id: "chat-1", owner_actor_id: "user-1" }],
      archivedConversations: [{ id: "chat-2" }],
      channelDefaultConversationId: "chat-1",
      preferences: { tone: "balanced" },
    });
    await app.close();
  });

  it("accepts a run and keeps it queued for Temporal when disabled locally", async () => {
    const runs = {
      createRun: async () => ({ id: "run-1", status: "received" }),
    } as unknown as RunRepository;
    const app = buildApp({ config, pool: fakePool, runs });
    const response = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
      payload: { installationId: "11111111-1111-4111-8111-111111111111" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ runId: "run-1", durable: false });
    await app.close();
  });

  it("resolves a user's platform conversation and accepts an idempotent chat message", async () => {
    const started: string[] = [];
    const platformChat = {
      resolveConversation: async () => ({
        conversation: { id: "conversation-1" },
        userParticipant: { id: "user-participant-1" },
        agentParticipant: { id: "agent-participant-1" },
      }),
      acceptMessage: async () => ({
        conversation: { id: "conversation-1" },
        userParticipant: { id: "user-participant-1" },
        agentParticipant: { id: "agent-participant-1" },
        message: { id: "message-1", content: { text: "Hello" } },
        run: { id: "run-1", status: "received" },
        created: true,
      }),
    } as unknown as PlatformChatRepository;
    const app = buildApp({
      config: { ...config, TEMPORAL_ENABLED: true },
      pool: fakePool,
      platformChat,
      conversations: { listMessages: async () => [] } as never,
      startWorkflow: async (runId) => { started.push(runId); },
    });
    const resolved = await app.inject({
      method: "POST",
      url: "/v1/installations/install-1/platform/conversation",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/installations/install-1/platform/messages",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
      payload: { message: "Hello", idempotencyKey: "message-key-1", createNew: true, context: { route: "/dashboard" } },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ conversation: { id: "conversation-1" }, messages: [] });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ runId: "run-1", created: true, durable: true });
    expect(started).toEqual(["run-1"]);
    await app.close();
  });

  it("enforces scopes on HMAC platform routes", async () => {
    const agents = {
      getSystemInstallation: async () => ({ id: "installation-1" }),
    } as unknown as AgentRepository;
    const platformChat = {
      resolveConversation: async () => ({ conversation: { id: "conversation-1" }, userParticipant: {}, agentParticipant: {} }),
    } as unknown as PlatformChatRepository;
    const hmacConfig = { ...config, AUTH_MODE: "hmac" as const, INTERNAL_AUTH_SECRET: "test-secret" };
    const readToken = signInternalToken({ organizationId: "org-1", actorId: "user-1", audience: "test", expiresAt: Math.floor(Date.now() / 1000) + 60, scopes: ["chat:read"] }, "test-secret");
    const noScopeToken = signInternalToken({ organizationId: "org-1", actorId: "user-1", audience: "test", expiresAt: Math.floor(Date.now() / 1000) + 60, scopes: [] }, "test-secret");
    const app = buildApp({ config: hmacConfig, pool: fakePool, agents, platformChat, conversations: { listMessages: async () => [] } as never });
    const allowed = await app.inject({ method: "POST", url: "/v1/installations/install-1/platform/conversation", headers: { authorization: `Bearer ${readToken}` } });
    const denied = await app.inject({ method: "POST", url: "/v1/installations/install-1/platform/conversation", headers: { authorization: `Bearer ${noScopeToken}` } });
    expect(allowed.statusCode).toBe(200);
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it("enforces scopes on agent lifecycle routes", async () => {
    const hmacConfig = { ...config, AUTH_MODE: "hmac" as const, INTERNAL_AUTH_SECRET: "test-secret" };
    const noScopeToken = signInternalToken({ organizationId: "org-1", actorId: "user-1", audience: "test", expiresAt: Math.floor(Date.now() / 1000) + 60, scopes: [] }, "test-secret");
    const app = buildApp({ config: hmacConfig, pool: fakePool });
    const headers = { authorization: `Bearer ${noScopeToken}` };
    const deniedRoutes: Array<{ method: "GET" | "POST"; url: string; payload?: Record<string, unknown> }> = [
      { method: "POST", url: "/v1/agents", payload: { name: "should-not-create", slug: "should-not-create" } },
      { method: "GET", url: "/v1/agents/agent-1/versions" },
      { method: "POST", url: "/v1/installations", payload: { agentVersionId: "version-1", scopeType: "organization" } },
      { method: "GET", url: "/v1/installations/install-1/credentials" },
      { method: "GET", url: "/v1/installations/install-1/grants" },
      { method: "GET", url: "/v1/installations/install-1/schedules" },
      { method: "POST", url: "/v1/installations/install-1/schedules", payload: { expression: "every 5 minutes" } },
      { method: "GET", url: "/v1/knowledge/sources?agentId=00000000-0000-0000-0000-000000000001" },
      { method: "POST", url: "/v1/knowledge/sources", payload: { name: "blocked", sourceType: "manual", agentId: "00000000-0000-0000-0000-000000000001" } },
      { method: "GET", url: "/v1/memory?agentId=00000000-0000-0000-0000-000000000001" },
      { method: "POST", url: "/v1/runs", payload: { installationId: "install-1", triggerType: "manual", input: {} } },
      { method: "POST", url: "/v1/evaluations/scenarios", payload: { name: "blocked" } },
    ];
    for (const route of deniedRoutes) {
      const denied = await app.inject({ ...route, headers, ...(route.payload ? { payload: route.payload } : {}) });
      expect(denied.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(denied.json(), `${route.method} ${route.url}`).toMatchObject({ error: expect.stringContaining("Missing internal scope") });
    }
    await app.close();
  });

  it("returns a copy-once secret when rotating an installation credential", async () => {
    const rotate = vi.fn(async () => ({ credential: { id: "credential-2", label: "Local client", status: "active" }, secret: "ksi_rotated" }));
    const app = buildApp({
      config,
      pool: fakePool,
      installationCredentials: { rotate } as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/installations/install-1/credentials/credential-1/rotate",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ credential: { id: "credential-2", label: "Local client", status: "active" }, secret: "ksi_rotated" });
    expect(rotate).toHaveBeenCalledWith({ organizationId: "org-1", installationId: "install-1", credentialId: "credential-1", actorId: "user-1" });
    await app.close();
  });

  it("signals approval and cancellation without handling either in process memory", async () => {
    const signals: Array<{ type: string; value: unknown }> = [];
    const runs = {
      getRun: async (_organizationId: string, runId: string) => ({
        id: runId,
        organization_id: "org-1",
        installation_id: "install-1",
        status: runId === "approval-run" ? "awaiting_approval" : "running",
      }),
    } as unknown as RunRepository;
    const app = buildApp({
      config,
      pool: fakePool,
      runs,
      agents: { getInstallation: async () => ({ id: "install-1", status: "active", agent_version_id: "version-1" }) } as never,
      approvals: {
        getForRun: async () => ({ installation_id: "install-1", provider_tool_call_id: "approval-call", arguments_hash: "a".repeat(64), capability: "kasitek.core.content_post_draft", capability_version: "1.0.0", status: "pending", resource_snapshot: { capability: "kasitek.core.content_post_draft", request: { postId: "post-1" } } }),
        decide: async () => ({ approval: { expires_at: new Date(Date.now() + 60_000).toISOString(), resource_snapshot: { capability: "kasitek.core.content_post_draft", request: { postId: "post-1" } } }, accepted: true }),
      } as never,
      toolInvocations: { getProposal: async () => ({ organizationId: "org-1", runId: "approval-run", providerToolCallId: "approval-call", toolName: "kasitek.core.content_post_draft", toolVersion: "1.0.0", argumentsHash: "a".repeat(64), arguments: { content: "draft", channels: ["threads"] } }) } as never,
      toolGrants: { effectiveTools: async () => new Set(["kasitek.core.content_post_draft"]) } as never,
      installationGrants: { effective: async () => ({ resources: [], connectors: [] }) } as never,
      signalApproval: async (runId, value) => signals.push({ type: `approval:${runId}`, value }),
      signalCancellation: async (runId, value) => signals.push({ type: `cancel:${runId}`, value }),
    });
    const approval = await app.inject({
      method: "POST",
      url: "/v1/runs/approval-run/approval",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
      payload: { decision: "approved", providerToolCallId: "approval-call", argumentsHash: "a".repeat(64) },
    });
    const cancellation = await app.inject({
      method: "POST",
      url: "/v1/runs/running-run/cancel",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
      payload: { reason: "operator stop" },
    });
    expect(approval.statusCode).toBe(202);
    expect(cancellation.statusCode).toBe(202);
    expect(signals).toEqual([
      { type: "approval:approval-run", value: expect.objectContaining({ decision: "approved", providerToolCallId: "approval-call", argumentsHash: "a".repeat(64), approvedBy: "user-1", resourceSnapshot: { capability: "kasitek.core.content_post_draft", request: { postId: "post-1" } } }) },
      { type: "cancel:running-run", value: { reason: "user-1: operator stop" } },
    ]);
    await app.close();
  });

  it("requires runs:approve before a request can signal a workflow approval", async () => {
    const signals: unknown[] = [];
    const hmacConfig = { ...config, AUTH_MODE: "hmac" as const, INTERNAL_AUTH_SECRET: "test-secret" };
    const app = buildApp({
      config: hmacConfig,
      pool: fakePool,
      runs: { getRun: async () => ({ id: "approval-run", organization_id: "org-1", installation_id: "install-1", status: "awaiting_approval" }) } as unknown as RunRepository,
      agents: { getInstallation: async () => ({ id: "install-1", status: "active", agent_version_id: "version-1" }) } as never,
      approvals: { getForRun: async () => ({ installation_id: "install-1", provider_tool_call_id: "approval-call", arguments_hash: "a".repeat(64), capability: "kasitek.core.content_post_draft", capability_version: "1.0.0", status: "pending" }), decide: async () => ({ approval: { expires_at: new Date(Date.now() + 60_000).toISOString() }, accepted: true }) } as never,
      toolInvocations: { getProposal: async () => ({ organizationId: "org-1", runId: "approval-run", providerToolCallId: "approval-call", toolName: "kasitek.core.content_post_draft", toolVersion: "1.0.0", argumentsHash: "a".repeat(64), arguments: { content: "draft", channels: ["threads"] } }) } as never,
      toolGrants: { effectiveTools: async () => new Set(["kasitek.core.content_post_draft"]) } as never,
      installationGrants: { effective: async () => ({ resources: [], connectors: [] }) } as never,
      signalApproval: async (_runId, signal) => signals.push(signal),
    });
    const noScope = signInternalToken({ organizationId: "org-1", actorId: "user-1", audience: "test", expiresAt: Math.floor(Date.now() / 1000) + 60, scopes: [] }, "test-secret");
    const approved = signInternalToken({ organizationId: "org-1", actorId: "user-1", audience: "test", expiresAt: Math.floor(Date.now() / 1000) + 60, scopes: ["runs:approve"] }, "test-secret");
    const denied = await app.inject({
      method: "POST",
      url: "/v1/runs/approval-run/approval",
      headers: { authorization: `Bearer ${noScope}` },
      payload: { decision: "approved", providerToolCallId: "approval-call", argumentsHash: "a".repeat(64) },
    });
    expect(denied.statusCode).toBe(403);
    expect(signals).toEqual([]);
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/runs/approval-run/approval",
      headers: { authorization: `Bearer ${approved}` },
      payload: { decision: "approved", providerToolCallId: "approval-call", argumentsHash: "a".repeat(64) },
    });
    expect(accepted.statusCode).toBe(202);
    expect(signals).toEqual([expect.objectContaining({ decision: "approved", providerToolCallId: "approval-call", argumentsHash: "a".repeat(64), approvedBy: "user-1" })]);
    await app.close();
  });

  it("rejects an approval when its installation grant was revoked after proposal", async () => {
    const signalApproval = vi.fn();
    const token = signInternalToken({ organizationId: "org-1", actorId: "user-1", audience: "test", expiresAt: Math.floor(Date.now() / 1000) + 60, scopes: ["runs:approve"] }, "test-secret");
    const app = buildApp({
      config: { ...config, AUTH_MODE: "hmac" as const, INTERNAL_AUTH_SECRET: "test-secret" },
      pool: fakePool,
      runs: { getRun: async () => ({ id: "approval-run", organization_id: "org-1", installation_id: "install-1", status: "awaiting_approval" }) } as unknown as RunRepository,
      agents: { getInstallation: async () => ({ id: "install-1", status: "active", agent_version_id: "version-1" }) } as never,
      approvals: { getForRun: async () => ({ installation_id: "install-1", provider_tool_call_id: "call-1", arguments_hash: "a".repeat(64), capability: "test.effect", capability_version: "1.0.0", status: "pending" }), decide: vi.fn() } as never,
      toolInvocations: { getProposal: async () => ({ organizationId: "org-1", runId: "approval-run", providerToolCallId: "call-1", toolName: "test.effect", toolVersion: "1.0.0", argumentsHash: "a".repeat(64), arguments: {} }) } as never,
      toolGrants: { effectiveTools: async () => new Set<string>() } as never,
      signalApproval,
    });
    const response = await app.inject({ method: "POST", url: "/v1/runs/approval-run/approval", headers: { authorization: `Bearer ${token}` }, payload: { decision: "approved", providerToolCallId: "call-1", argumentsHash: "a".repeat(64) } });
    expect(response.statusCode).toBe(403);
    expect(signalApproval).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects self-approval before changing durable approval state or signalling Temporal", async () => {
    const decide = vi.fn();
    const signalApproval = vi.fn();
    const hmacConfig = { ...config, AUTH_MODE: "hmac" as const, INTERNAL_AUTH_SECRET: "test-secret" };
    const token = signInternalToken({ organizationId: "org-1", actorId: "user-1", audience: "test", expiresAt: Math.floor(Date.now() / 1000) + 60, scopes: ["runs:approve"] }, "test-secret");
    const app = buildApp({
      config: hmacConfig,
      pool: fakePool,
      runs: { getRun: async () => ({ id: "approval-run", organization_id: "org-1", installation_id: "install-1", status: "awaiting_approval", created_by: "user-1" }) } as unknown as RunRepository,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_version_id: "version-1", status: "active" }) } as never,
      approvals: { getForRun: async () => ({ installation_id: "install-1", provider_tool_call_id: "approval-call", arguments_hash: "a".repeat(64), capability: "kasitek.core.content_post_draft", capability_version: "1.0.0", status: "pending" }), decide } as never,
      signalApproval,
    });
    const response = await app.inject({ method: "POST", url: "/v1/runs/approval-run/approval", headers: { authorization: `Bearer ${token}` }, payload: { decision: "approved", providerToolCallId: "approval-call", argumentsHash: "a".repeat(64) } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "approval_self_approval_forbidden", code: "SEPARATION_OF_DUTIES_REQUIRED" });
    expect(decide).not.toHaveBeenCalled();
    expect(signalApproval).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns an existing approval decision without signalling Temporal twice", async () => {
    const signals: unknown[] = [];
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const decide = vi
      .fn()
      .mockResolvedValueOnce({ approval: { expires_at: expiresAt, approved_by: "user-1" }, accepted: true })
      .mockResolvedValueOnce({ approval: { expires_at: expiresAt, approved_by: "user-1" }, accepted: false });
    const hmacConfig = { ...config, AUTH_MODE: "hmac" as const, INTERNAL_AUTH_SECRET: "test-secret" };
    const token = signInternalToken({ organizationId: "org-1", actorId: "user-1", audience: "test", expiresAt: Math.floor(Date.now() / 1000) + 60, scopes: ["runs:approve"] }, "test-secret");
    const app = buildApp({
      config: hmacConfig,
      pool: fakePool,
      runs: { getRun: async () => ({ id: "approval-run", organization_id: "org-1", installation_id: "install-1", status: "awaiting_approval" }) } as unknown as RunRepository,
      agents: { getInstallation: async () => ({ id: "install-1", status: "active", agent_version_id: "version-1" }) } as never,
      approvals: { getForRun: async () => ({ installation_id: "install-1", provider_tool_call_id: "approval-call", arguments_hash: "a".repeat(64), capability: "kasitek.core.content_post_draft", capability_version: "1.0.0", status: "pending" }), decide } as never,
      toolInvocations: { getProposal: async () => ({ organizationId: "org-1", runId: "approval-run", providerToolCallId: "approval-call", toolName: "kasitek.core.content_post_draft", toolVersion: "1.0.0", argumentsHash: "a".repeat(64), arguments: { content: "draft", channels: ["threads"] } }) } as never,
      toolGrants: { effectiveTools: async () => new Set(["kasitek.core.content_post_draft"]) } as never,
      installationGrants: { effective: async () => ({ resources: [], connectors: [] }) } as never,
      signalApproval: async (_runId, signal) => signals.push(signal),
    });
    const request = {
      method: "POST" as const,
      url: "/v1/runs/approval-run/approval",
      headers: { authorization: `Bearer ${token}` },
      payload: { decision: "approved", providerToolCallId: "approval-call", argumentsHash: "a".repeat(64) },
    };

    const first = await app.inject(request);
    const retry = await app.inject(request);

    expect(first.statusCode).toBe(202);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ status: "approval_already_signalled", decision: "approved", approvedBy: "user-1", expiresAt });
    expect(decide).toHaveBeenCalledTimes(2);
    expect(signals).toEqual([expect.objectContaining({ decision: "approved", approvedBy: "user-1" })]);
    await app.close();
  });

  it("rate limits repeated approval decisions before the durable state transition", async () => {
    const decide = vi.fn().mockResolvedValue({ approval: { expires_at: new Date(Date.now() + 60_000).toISOString() }, accepted: true });
    const app = buildApp({
      config: { ...mcpConfig, APPROVAL_DECISION_RATE_LIMIT_PER_WINDOW: 1 },
      pool: fakePool,
      runs: { getRun: async () => ({ id: "approval-rate-run", organization_id: "org-1", installation_id: "install-1", status: "awaiting_approval" }) } as unknown as RunRepository,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      approvals: { getForRun: async () => ({ installation_id: "install-1", provider_tool_call_id: "approval-call", arguments_hash: "a".repeat(64), capability: "kasitek.core.content_post_draft", capability_version: "1.0.0", status: "pending" }), decide } as never,
      toolInvocations: { getProposal: async () => ({ organizationId: "org-1", runId: "approval-rate-run", providerToolCallId: "approval-call", toolName: "kasitek.core.content_post_draft", toolVersion: "1.0.0", argumentsHash: "a".repeat(64), arguments: { content: "draft", channels: ["threads"] } }) } as never,
      toolGrants: { effectiveTools: async () => new Set(["kasitek.core.content_post_draft"]) } as never,
      installationGrants: { effective: async () => ({ resources: [] }) } as never,
      toolRegistry: { get: () => ({ name: "kasitek.core.content_post_draft", version: "1.0.0", requiresApproval: false, manifest: { availability: "available" } }) } as never,
      signalApproval: vi.fn(),
    });
    const request = { method: "POST" as const, url: "/v1/runs/approval-rate-run/approval", headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" }, payload: { decision: "approved", providerToolCallId: "approval-call", argumentsHash: "a".repeat(64) } };
    const first = await app.inject(request);
    const second = await app.inject(request);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
    expect(second.json()).toMatchObject({ error: "approval_rate_limited" });
    expect(decide).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("does not reveal cross-organization approval run ids", async () => {
    const hmacConfig = { ...config, AUTH_MODE: "hmac" as const, INTERNAL_AUTH_SECRET: "test-secret" };
    const token = signInternalToken({ organizationId: "org-2", actorId: "user-2", audience: "test", expiresAt: Math.floor(Date.now() / 1000) + 60, scopes: ["runs:approve"] }, "test-secret");
    const getRun = vi.fn(async (organizationId: string) => organizationId === "org-1" ? { id: "cross-org-run", organization_id: "org-1", installation_id: "install-1", status: "awaiting_approval" } : null);
    const app = buildApp({
      config: hmacConfig,
      pool: fakePool,
      runs: { getRun } as never,
      approvals: { getForRun: vi.fn() } as never,
      signalApproval: vi.fn(),
    });
    const response = await app.inject({ method: "POST", url: "/v1/runs/cross-org-run/approval", headers: { authorization: `Bearer ${token}` }, payload: { decision: "approved", providerToolCallId: "call-1", argumentsHash: "a".repeat(64) } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "run_not_found" });
    expect(getRun).toHaveBeenCalledWith("org-2", "cross-org-run");
    await app.close();
  });

  it("returns the resolved durable effect outcome after reconciliation", async () => {
    const reconcile = vi.fn();
    const auditQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const hmacConfig = { ...config, AUTH_MODE: "hmac" as const, INTERNAL_AUTH_SECRET: "test-secret" };
    const token = signInternalToken({ organizationId: "org-1", actorId: "user-1", audience: "test", expiresAt: Math.floor(Date.now() / 1000) + 60, scopes: ["agents:write"] }, "test-secret");
    const app = buildApp({
      config: hmacConfig,
      pool: { query: auditQuery } as never,
      effectReceipts: { reconcile } as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/operations/effects/effect-1/reconcile",
      headers: { authorization: `Bearer ${token}` },
      payload: { outcome: "succeeded", providerReceipt: { providerId: "receipt-1" } },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ effectId: "effect-1", status: "succeeded", reconciliationRequired: false });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-1", effectId: "effect-1", outcome: "succeeded" }));
    expect(auditQuery).toHaveBeenCalledWith(expect.stringContaining("agent_effect.reconciliation_resolved"), expect.arrayContaining(["org-1", "user-1", "effect-1"]));
    await app.close();
  });

  it("keeps reconciliation inspection read-only", async () => {
    const pendingReconciliation = vi.fn(async () => [{ id: "effect-1", status: "unknown", reconciliation_required: true }]);
    const countPendingReconciliation = vi.fn(async () => 1);
    const mutatingMethod = vi.fn(() => { throw new Error("GET must not mutate effect state"); });
    const app = buildApp({
      config,
      pool: fakePool,
      effectReceipts: {
        pendingReconciliation,
        countPendingReconciliation,
        markStaleExecutingUnknown: mutatingMethod,
        reconcile: mutatingMethod,
      } as never,
      runs: { operationalSummary: async () => ({}) } as never,
      modelCalls: { usageSummary: async () => ({}) } as never,
      toolInvocations: { outcomeSummary: async () => ({}) } as never,
    });
    const headers = { "x-organization-id": "org-1", "x-actor-id": "user-1" };
    const list = await app.inject({ method: "GET", url: "/v1/operations/effects/reconciliation", headers });
    const summary = await app.inject({ method: "GET", url: "/v1/operations/summary", headers });
    expect(list.statusCode).toBe(200);
    expect(summary.statusCode).toBe(200);
    expect(pendingReconciliation).toHaveBeenCalledWith("org-1", 100);
    expect(countPendingReconciliation).toHaveBeenCalledWith("org-1");
    expect(mutatingMethod).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns a durable run timeline assembled from events, steps, and tool calls", async () => {
    const app = buildApp({
      config,
      pool: fakePool,
      runs: {
        getRun: async () => ({ id: "run-1", status: "completed" }),
        listEvents: async () => [{ event_type: "run.completed" }],
      } as unknown as RunRepository,
      runSteps: { listSteps: async () => [{ sequence_number: 1, step_type: "context" }] } as never,
      toolInvocations: { list: async () => [{ tool_name: "platform.current_time", arguments: { apiKey: "do-not-leak" } }] } as never,
      effectReceipts: { listForRun: async () => [{ id: "effect-1", capability: "test.effect", status: "succeeded", provider_receipt: { accessToken: "do-not-leak" } }] } as never,
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/runs/run-1/timeline",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      run: { id: "run-1" },
      events: [{ event_type: "run.completed" }],
      steps: [{ step_type: "context" }],
      toolCalls: [{ tool_name: "platform.current_time", arguments: { apiKey: "[REDACTED]" } }],
      effects: [{ provider_receipt: { accessToken: "[REDACTED]" } }],
    });
    await app.close();
  });

  it("returns an organization-scoped operational summary", async () => {
    const app = buildApp({
      config,
      pool: fakePool,
      runs: { operationalSummary: async () => ({ runsByStatus: [{ status: "completed", count: 2 }], oldestQueuedAt: null }) } as never,
      modelCalls: { usageSummary: async () => ({ inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedCostUsd: 0.01, failedCalls: 0 }) } as never,
      toolInvocations: { outcomeSummary: async () => [{ status: "completed", count: 1 }] } as never,
    });
    const response = await app.inject({ method: "GET", url: "/v1/operations/summary", headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ organizationId: "org-1", runs: { runsByStatus: [{ status: "completed", count: 2 }] }, models: { totalTokens: 15 }, tools: [{ status: "completed", count: 1 }] });
    await app.close();
  });

  it("reports dependency health without exposing provider credentials", async () => {
    const app = buildApp({ config, pool: fakePool });
    const response = await app.inject({ method: "GET", url: "/v1/operations/health", headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ready",
      database: { status: "ready" },
      temporal: { enabled: false },
      model: { provider: "openrouter", credentialConfigured: expect.any(Boolean) },
    });
    expect(JSON.stringify(response.json())).not.toContain("API_KEY");
    await app.close();
  });

  it("exposes organization-scoped audit records with filters", async () => {
    const app = buildApp({
      config,
      pool: fakePool,
      audits: { list: async (input: { organizationId: string; action?: string }) => [{ organization_id: input.organizationId, action: input.action ?? "agent.created" }] } as never,
    });
    const response = await app.inject({ method: "GET", url: "/v1/audit?action=agent.created", headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ records: [{ organization_id: "org-1", action: "agent.created" }] });
    await app.close();
  });

  it("exposes only opaque credential records", async () => {
    const app = buildApp({
      config,
      pool: fakePool,
      credentials: {
        store: async () => ({ id: "credential-1", provider: "openai", label: "test", funding_source: "user", status: "active" }),
        list: async () => [{ id: "credential-1", provider: "openai", label: "test", funding_source: "user", status: "active" }],
        revoke: async () => undefined,
      } as never,
    });
    const created = await app.inject({ method: "POST", url: "/v1/credentials", headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" }, payload: { provider: "openai", apiKey: "secret-key", label: "test" } });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain("secret-key");
    const listed = await app.inject({ method: "GET", url: "/v1/credentials", headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" } });
    expect(listed.body).not.toContain("secret-key");
    await app.close();
  });

  it("records a deterministic evaluation run", async () => {
    const app = buildApp({
      config,
      pool: fakePool,
      evaluations: {
        getScenario: async () => ({ id: "scenario-1", assertions: [{ path: "answer", operator: "equals", expected: "ok" }] }),
        recordRun: async (input: { status: string }) => ({ id: "evaluation-run-1", status: input.status }),
      } as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/evaluations/scenarios/scenario-1/runs",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
      payload: { actualOutput: { answer: "ok" } },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: "evaluation-run-1", status: "passed" });
    await app.close();
  });

  it("creates and pauses an installation schedule", async () => {
    const app = buildApp({
      config,
      pool: fakePool,
      schedules: {
        create: async () => ({ id: "schedule-1", status: "active" }),
        setStatus: async (_org: string, _id: string, status: string) => ({ id: "schedule-1", status }),
        list: async () => [],
      } as never,
    });
    const created = await app.inject({ method: "POST", url: "/v1/installations/install-1/schedules", headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" }, payload: { expression: "every 5 minutes" } });
    expect(created.statusCode).toBe(201);
    const paused = await app.inject({ method: "POST", url: "/v1/schedules/schedule-1/status/paused", headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" } });
    expect(paused.json()).toMatchObject({ id: "schedule-1", status: "paused" });
    await app.close();
  });

  it("supports organization kill-switch controls and rejects global scope from org auth", async () => {
    const app = buildApp({
      config,
      pool: fakePool,
      killSwitches: {
        set: async () => ({ id: "switch-1", scope_type: "agent", enabled: true }),
        list: async () => [{ id: "switch-1", enabled: true }],
        disable: async () => undefined,
      } as never,
    });
    const created = await app.inject({ method: "POST", url: "/v1/operations/kill-switches", headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" }, payload: { scopeType: "agent", scopeId: "agent-1", reason: "incident" } });
    expect(created.statusCode).toBe(201);
    const global = await app.inject({ method: "POST", url: "/v1/operations/kill-switches", headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" }, payload: { scopeType: "global", scopeId: "global", reason: "incident" } });
    expect(global.statusCode).toBe(500);
    await app.close();
  });

  it("exposes scoped memory and knowledge inspection contracts", async () => {
    const app = buildApp({
      config,
      pool: fakePool,
      memory: { listMemory: async () => [{ id: "memory-1" }], deleteMemory: async () => undefined, revalidateMemory: async () => ({ id: "memory-1" }) } as never,
      knowledge: { listSources: async () => [{ id: "source-1" }] } as never,
    });
    const agentId = "11111111-1111-4111-8111-111111111111";
    const memories = await app.inject({ method: "GET", url: `/v1/memory?agentId=${agentId}`, headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" } });
    const sources = await app.inject({ method: "GET", url: "/v1/knowledge/sources", headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" } });
    expect(memories.json()).toMatchObject({ memories: [{ id: "memory-1" }] });
    expect(sources.json()).toMatchObject({ sources: [{ id: "source-1" }] });
    await app.close();
  });

  it("supports conversation archive and channel binding revocation", async () => {
    const lifecycleCalls: Array<{ organizationId: string; id: string; ownerActorId: string; status: string }> = [];
    const app = buildApp({
      config,
      pool: fakePool,
      conversations: {
        setOwnedStatus: async (organizationId: string, id: string, ownerActorId: string, status: string) => {
          lifecycleCalls.push({ organizationId, id, ownerActorId, status });
          return { id, status };
        },
      } as never,
      channels: { revokeOwnerBinding: async () => undefined } as never,
    });
    const archived = await app.inject({ method: "POST", url: "/v1/conversations/conversation-1/status/archived", headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" } });
    const revoked = await app.inject({ method: "DELETE", url: "/v1/channel-bindings/binding-1", headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" } });
    expect(archived.json()).toMatchObject({ id: "conversation-1", status: "archived" });
    expect(lifecycleCalls).toEqual([{ organizationId: "org-1", id: "conversation-1", ownerActorId: "user-1", status: "archived" }]);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ disconnected: true });
    await app.close();
  });
});
