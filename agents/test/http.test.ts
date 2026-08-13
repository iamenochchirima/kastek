import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/http/app";
import type { AgentRepository } from "../src/db/repositories/agent-repository";
import type { RunRepository } from "../src/db/repositories/run-repository";
import type { AppConfig } from "../src/config";
import type { PlatformChatRepository } from "../src/db/repositories/platform-chat-repository";
import { signInternalToken } from "../src/http/auth";
import { generateKeyPairSync } from "node:crypto";
import { issueInstallationToken } from "../src/auth/installation-token";

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
    expect(response.json()).toMatchObject({ result: { structuredContent: { runId: "run-mcp-1", status: "received" } } });
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

  it("does not let a read-only public API credential invoke tools", async () => {
    const app = buildApp({
      config: { ...mcpConfig, TEMPORAL_ENABLED: true },
      pool: fakePool,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => ({ ...mcpCredential(), api_scopes: ["api:read"] }) } as never,
      toolGrants: { effectiveTools: async () => new Set(["platform.current_time"]) } as never,
      startWorkflow: vi.fn(),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/installations/install-1/tools/call",
      headers: { authorization: `Bearer ${publicApiToken()}` },
      payload: { name: "platform.current_time", arguments: {}, idempotencyKey: "api-read-only-1" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "Public API credential is missing scope: api:write" });
    await app.close();
  });

  it("exposes installation-scoped operation status and cancellation over the public API", async () => {
    const signalCancellation = vi.fn().mockResolvedValue(undefined);
    const getRun = vi.fn().mockResolvedValue({ id: "run-api-1", organization_id: "org-1", installation_id: "install-1", status: "running" });
    const runs = {
      getRun,
      listEvents: vi.fn().mockResolvedValue([{ event_type: "run.started" }]),
    } as unknown as RunRepository;
    const app = buildApp({
      config: { ...mcpConfig, TEMPORAL_ENABLED: true },
      pool: fakePool,
      runs,
      signalCancellation,
      agents: { getInstallation: async () => ({ id: "install-1", organization_id: "org-1", agent_version_id: "version-1", status: "active" }) } as unknown as AgentRepository,
      installationCredentials: { getActiveForToken: async () => mcpCredential() } as never,
    });
    const status = await app.inject({ method: "GET", url: "/v1/installations/install-1/operations/run-api-1", headers: { authorization: `Bearer ${publicApiToken()}` } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ operationId: "run-api-1", run: { id: "run-api-1" }, events: [{ event_type: "run.started" }] });
    const cancelled = await app.inject({ method: "POST", url: "/v1/installations/install-1/operations/run-api-1/cancel", headers: { authorization: `Bearer ${publicApiToken()}` }, payload: { reason: "client stopped" } });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ operationId: "run-api-1", status: "cancellation_signalled" });
    expect(signalCancellation).toHaveBeenCalledWith("run-api-1", { reason: "installation:install-1: client stopped" });
    getRun.mockResolvedValueOnce({ id: "run-other", organization_id: "org-1", installation_id: "install-other", status: "running" });
    const denied = await app.inject({ method: "GET", url: "/v1/installations/install-1/operations/run-other", headers: { authorization: `Bearer ${publicApiToken()}` } });
    expect(denied.statusCode).toBe(404);
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

  it("signals approval and cancellation without handling either in process memory", async () => {
    const signals: Array<{ type: string; value: unknown }> = [];
    const runs = {
      getRun: async (_organizationId: string, runId: string) => ({
        id: runId,
        status: runId === "approval-run" ? "awaiting_approval" : "running",
      }),
    } as unknown as RunRepository;
    const app = buildApp({
      config,
      pool: fakePool,
      runs,
      approvals: {
        decide: async () => ({ expires_at: new Date(Date.now() + 60_000).toISOString() }),
      } as never,
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
      { type: "approval:approval-run", value: expect.objectContaining({ decision: "approved", providerToolCallId: "approval-call", argumentsHash: "a".repeat(64), approvedBy: "user-1" }) },
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
      runs: { getRun: async () => ({ id: "approval-run", organization_id: "org-1", status: "awaiting_approval" }) } as unknown as RunRepository,
      approvals: { decide: async () => ({ expires_at: new Date(Date.now() + 60_000).toISOString() }) } as never,
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

  it("returns a durable run timeline assembled from events, steps, and tool calls", async () => {
    const app = buildApp({
      config,
      pool: fakePool,
      runs: {
        getRun: async () => ({ id: "run-1", status: "completed" }),
        listEvents: async () => [{ event_type: "run.completed" }],
      } as unknown as RunRepository,
      runSteps: { listSteps: async () => [{ sequence_number: 1, step_type: "context" }] } as never,
      toolInvocations: { list: async () => [{ tool_name: "platform.current_time" }] } as never,
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
      toolCalls: [{ tool_name: "platform.current_time" }],
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
