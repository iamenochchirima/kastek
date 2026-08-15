import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { buildApp } from "../src/http/app";
import { issueInstallationToken } from "../src/auth/installation-token";
import { ToolRegistry } from "../src/tools/registry";
import type { AppConfig } from "../src/config";

const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
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
  INSTALLATION_TOKEN_PRIVATE_KEY: keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  INSTALLATION_TOKEN_ISSUER: "mcp-2026-test",
};

const pool = { query: async () => ({ rows: [{ ok: 1 }] }) } as never;
const token = issueInstallationToken({
  privateKeyPem: config.INSTALLATION_TOKEN_PRIVATE_KEY!,
  issuer: config.INSTALLATION_TOKEN_ISSUER,
  installationId: "install-1",
  organizationId: "org-1",
  credentialId: "credential-1",
  audience: "mcp",
}).accessToken;

const metadata = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "mcp-2026-test", version: "1.0.0" },
};

const taskMetadata = {
  ...metadata,
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { "io.modelcontextprotocol/tasks": {} },
  },
};

function headers(extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${token}`,
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": "server/discover",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    config,
    pool,
    agents: {
      getInstallation: async () => ({ id: "install-1", organization_id: "org-1", status: "active", agent_version_id: "version-1" }),
    },
    installationCredentials: {
      getActiveForToken: async () => ({
        id: "credential-1",
        installation_id: "install-1",
        organization_id: "org-1",
        status: "active",
        mcp_scopes: ["mcp:read", "mcp:write"],
      }),
    },
    ...overrides,
  };
}

describe("MCP 2026 stateless contract", () => {
  it("serves server/discover without an initialize handshake", async () => {
    const app = buildApp(dependencies());
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers(),
      payload: {
        jsonrpc: "2.0",
        id: "discover-1",
        method: "server/discover",
        params: { _meta: metadata },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(response.json()).toMatchObject({
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28", "2025-06-18"],
        capabilities: { tools: { listChanged: false } },
        cacheScope: "private",
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "kasitek-agent-platform" } },
      },
    });
    await app.close();
  });

  it("returns deterministic, cacheable, installation-filtered tools", async () => {
    const registry = new ToolRegistry();
    registry.registerManifest({
      name: "platform.zeta",
      version: "1.0.0",
      description: "A bounded read",
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 5_000,
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object" },
      handler: async () => ({ ok: true }),
      manifest: {
        ownerService: "agents",
        requiredScope: "platform:read",
        execution: "immediate",
        idempotency: "not_applicable",
        approval: "none",
        auditClassification: "access",
        redaction: [],
      },
    });
    const app = buildApp(dependencies({
      toolRegistry: registry,
      toolGrants: { effectiveTools: async () => new Set(["platform.zeta"]) },
    }));
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers({ "mcp-method": "tools/list" }),
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: { _meta: metadata },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: {
        resultType: "complete",
        ttlMs: 30_000,
        cacheScope: "private",
        tools: [{ name: "platform.zeta" }],
      },
    });
    await app.close();
  });

  it("bounds oversized stateless results before they leave the Agent API", async () => {
    const registry = new ToolRegistry();
    registry.registerManifest({
      name: "platform.large-description",
      version: "1.0.0",
      description: "x".repeat(1_100_000),
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 5_000,
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object" },
      handler: async () => ({ ok: true }),
      manifest: {
        ownerService: "agents",
        requiredScope: "platform:read",
        execution: "immediate",
        idempotency: "not_applicable",
        approval: "none",
        auditClassification: "access",
        redaction: [],
      },
    });
    const app = buildApp(dependencies({
      toolRegistry: registry,
      toolGrants: { effectiveTools: async () => new Set(["platform.large-description"]) },
    }));
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers({ "mcp-method": "tools/list" }),
      payload: { jsonrpc: "2.0", id: 25, method: "tools/list", params: { _meta: metadata } },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: -32011, message: "mcp_response_too_large" } });
    await app.close();
  });

  it("rejects body/header disagreement before authentication or invocation", async () => {
    const app = buildApp(dependencies());
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers({ "mcp-method": "tools/call" }),
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "server/discover",
        params: { _meta: metadata },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: -32020 } });
    await app.close();
  });

  it("rejects sensitive custom MCP headers before authentication", async () => {
    const app = buildApp(dependencies());
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers({ "mcp-param-token": "should-not-forward" }),
      payload: { jsonrpc: "2.0", id: 31, method: "server/discover", params: { _meta: metadata } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: -32020 } });
    await app.close();
  });

  it("rejects initialize on the 2026 stateless path while preserving pre-2026 initialize", async () => {
    const app = buildApp(dependencies());
    const stateless = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers({ "mcp-method": "initialize" }),
      payload: { jsonrpc: "2.0", id: 4, method: "initialize", params: { _meta: metadata } },
    });
    expect(stateless.statusCode).toBe(404);
    expect(stateless.json()).toMatchObject({ error: { code: -32601, message: "method_not_found" } });

    const compatibility = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${token}`, "mcp-protocol-version": "2025-06-18" },
      payload: { jsonrpc: "2.0", id: 5, method: "initialize" },
    });
    expect(compatibility.statusCode).toBe(200);
    expect(compatibility.json()).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
    await app.close();
  });

  it("returns the supported-version list for an unsupported stateless revision", async () => {
    const app = buildApp(dependencies());
    const unsupportedMetadata = { ...metadata, "io.modelcontextprotocol/protocolVersion": "2025-11-25" };
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers({ "mcp-protocol-version": "2025-11-25" }),
      payload: { jsonrpc: "2.0", id: 6, method: "server/discover", params: { _meta: unsupportedMetadata } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: -32022, data: { supported: ["2026-07-28", "2025-06-18"], requested: "2025-11-25" } } });
    await app.close();
  });

  it("can roll back only the 2026 path while preserving compatibility initialize", async () => {
    const app = buildApp(dependencies({ config: { ...config, MCP_STATELESS_ENABLED: false } }));
    const stateless = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers(),
      payload: { jsonrpc: "2.0", id: 61, method: "server/discover", params: { _meta: metadata } },
    });
    expect(stateless.statusCode).toBe(400);
    expect(stateless.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(stateless.json()).toMatchObject({ error: { code: -32022, data: { supported: ["2025-06-18"] } } });

    const compatibility = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${token}`, "mcp-protocol-version": "2025-06-18" },
      payload: { jsonrpc: "2.0", id: 62, method: "initialize" },
    });
    expect(compatibility.statusCode).toBe(200);
    expect(compatibility.json()).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
    await app.close();
  });

  it("returns a durable Tasks handle only when the client opts into the extension", async () => {
    const app = buildApp(dependencies({
      installationInvocations: {
        accept: async () => ({
          accepted: { id: "run-task-1", status: "queued" },
          manifest: { requiresApproval: true },
        }),
      },
    }));
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers({ "mcp-method": "tools/call", "mcp-name": "platform.current_time" }),
      payload: {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { _meta: taskMetadata, name: "platform.current_time", arguments: {} },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: {
        resultType: "task",
        task: { taskId: "run-task-1", status: "working", pollIntervalMs: 2_000 },
      },
    });
    await app.close();
  });

  it("polls and cancels task-backed durable runs through the installation boundary", async () => {
    const signalCancellation = vi.fn(async () => undefined);
    let reads = 0;
    const app = buildApp(dependencies({
      runs: {
        getRun: async (_organizationId: string, runId: string) => ({
          id: runId,
          installation_id: "install-1",
          status: reads++ === 0 ? "completed" : "running",
          output: reads === 1 ? { message: "finished" } : null,
          error: null,
          updated_at: "2026-08-15T10:00:00.000Z",
        }),
      },
      signalCancellation,
    }));
    const polled = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers({ "mcp-method": "tasks/get" }),
      payload: { jsonrpc: "2.0", id: 8, method: "tasks/get", params: { _meta: taskMetadata, taskId: "run-task-1" } },
    });
    expect(polled.statusCode).toBe(200);
    expect(polled.json()).toMatchObject({ result: { resultType: "complete", task: { status: "completed" }, result: { message: "finished" } } });

    const cancelled = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers({ "mcp-method": "tasks/cancel" }),
      payload: { jsonrpc: "2.0", id: 9, method: "tasks/cancel", params: { _meta: taskMetadata, taskId: "run-task-1" } },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(signalCancellation).toHaveBeenCalledWith("run-task-1", expect.objectContaining({ reason: expect.stringContaining("cancelled by MCP client") }));

    const updated = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers({ "mcp-method": "tasks/update" }),
      payload: {
        jsonrpc: "2.0",
        id: 10,
        method: "tasks/update",
        params: { _meta: taskMetadata, taskId: "run-task-1", inputResponses: { approval: { action: "accept" } } },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ result: { resultType: "complete" } });
    await app.close();
  });
});
