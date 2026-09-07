import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/http/app";
import type { AppConfig } from "../src/config";
import { issueInstallationToken } from "../src/auth/installation-token";
import { createDefaultTools } from "../src/temporal/activities";
import { InstallationCapabilityInvocationService } from "../src/invocation/installation-capability";
import { InstallationImmediateReadService } from "../src/invocation/immediate-read";
import type { KasitekCoreReadClient } from "../src/core/client";
import { createCapabilityRuntime } from "../src/capabilities/runtime";

const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const privateKey = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

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
  AUTH_MODE: "headers",
  LOG_LEVEL: "silent",
  INSTALLATION_TOKEN_PRIVATE_KEY: privateKey,
  INSTALLATION_TOKEN_ISSUER: "local-parity",
};

const context = {
  organizationId: "org-local-parity",
  installationId: "install-local-parity",
  credentialId: "credential-local-parity",
  agentDefinitionId: "agent-local-parity",
};

const parityCases = [
  { name: "kasitek.core.workspace_status", method: "getWorkspaceStatus", args: {}, output: { organizationId: context.organizationId, connections: [] } },
  { name: "kasitek.core.connections_list", method: "listWorkspaceConnections", args: { provider: "FACEBOOK", limit: 25 }, output: { organizationId: context.organizationId, connections: [] } },
  {
    name: "kasitek.core.workspace_report",
    method: "getWorkspaceReport",
    args: {},
    output: { organizationId: context.organizationId, connections: {}, content: {}, contacts: {}, inbox: {}, bookings: {}, campaigns: {}, templates: {} },
  },
  { name: "kasitek.core.booking_services_list", method: "listBookingServices", args: { limit: 25 }, output: { services: [], total: 0, hasMore: false } },
  { name: "kasitek.core.bookings_list", method: "listBookings", args: { limit: 25 }, output: { bookings: [] } },
  { name: "kasitek.core.campaigns_list", method: "listCampaigns", args: { limit: 25 }, output: { campaigns: [] } },
  { name: "kasitek.core.templates_list", method: "listTemplates", args: { status: "APPROVED", limit: 25 }, output: { templates: [] } },
  { name: "kasitek.core.contacts_list", method: "listContacts", args: { q: "Ada", optIn: "true", limit: 25 }, output: { contacts: [], totalContacts: 0 } },
  { name: "kasitek.core.inbox_conversations_list", method: "listInboxConversations", args: { limit: 25 }, output: { conversations: [], total: 0, hasMore: false } },
  { name: "kasitek.core.content_posts_list", method: "listContentPosts", args: {}, output: { posts: [] } },
] as const;

function token(audience: "mcp" | "kasitek-public-api"): string {
  return issueInstallationToken({
    privateKeyPem: privateKey,
    issuer: config.INSTALLATION_TOKEN_ISSUER,
    installationId: context.installationId,
    organizationId: context.organizationId,
    credentialId: context.credentialId,
    audience,
  }).accessToken;
}

function createLocalParityApp() {
  const coreMethods: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const testCase of parityCases) coreMethods[testCase.method] = vi.fn().mockResolvedValue(testCase.output);
  const toolRegistry = createDefaultTools(coreMethods as unknown as KasitekCoreReadClient);
  const runsById = new Map<string, Record<string, unknown>>();
  let sequence = 0;
  const runs = {
    createRun: vi.fn(async (organizationId: string, actorId: string, input: { installationId?: string; idempotencyKey?: string; triggerType?: string }) => {
      const id = `local-parity-run-${++sequence}`;
      const run = {
        id,
        organization_id: organizationId,
        agent_definition_id: context.agentDefinitionId,
        agent_version_id: "version-local-parity",
        installation_id: input.installationId,
        conversation_id: null,
        created_by: actorId,
        trigger_type: input.triggerType ?? "manual",
        status: "received" as const,
        correlation_id: `correlation-${id}`,
        causation_id: null,
        created: true,
      };
      runsById.set(id, run);
      return run;
    }),
    transitionRun: vi.fn(async (id: string, _from: string, status: string) => {
      const run = runsById.get(id);
      if (run) run.status = status;
      return run;
    }),
    completeRun: vi.fn(async (id: string, input: { output?: unknown }) => {
      const run = runsById.get(id)!;
      run.status = "completed";
      run.output = input.output;
      return run;
    }),
    getRun: vi.fn(async (organizationId: string, id: string) => {
      const run = runsById.get(id);
      return run?.organization_id === organizationId ? run : null;
    }),
  };
  const toolInvocations = {
    recordProposal: vi.fn(async () => undefined),
    recordCompleted: vi.fn(async () => undefined),
    recordFailed: vi.fn(async () => undefined),
  };
  const immediateRead = new InstallationImmediateReadService({ runs: runs as never, toolInvocations: toolInvocations as never, capabilities: createCapabilityRuntime({ registry: toolRegistry }) });
  const installationInvocations = new InstallationCapabilityInvocationService({
    agents: { getInstallation: vi.fn(async () => ({ id: context.installationId, organization_id: context.organizationId, agent_definition_id: context.agentDefinitionId, agent_version_id: "version-local-parity", status: "active", execution_mode: "external_connected" as const, agent_owner_type: "organization", agent_protected: false, agent_slug: "local-parity" })) } as never,
    runs: runs as never,
    toolGrants: { effectiveTools: vi.fn(async () => new Set(parityCases.map((testCase) => testCase.name))) } as never,
    installationGrants: { effective: vi.fn(async () => ({ resources: [] })) } as never,
    killSwitches: { isBlocked: vi.fn(async () => false) } as never,
    tools: toolRegistry,
    temporalEnabled: false,
    immediateRead: (input) => immediateRead.execute({ ...input, agentId: context.agentDefinitionId, agentVersionId: "version-local-parity" }),
  });
  const app = buildApp({
    config,
    pool: { query: vi.fn(async () => ({ rows: [] })) } as never,
    toolRegistry,
    installationInvocations,
    runs: runs as never,
    toolInvocations: toolInvocations as never,
    agents: { getInstallation: vi.fn(async () => ({ id: context.installationId, organization_id: context.organizationId, agent_definition_id: context.agentDefinitionId, agent_version_id: "version-local-parity", status: "active", execution_mode: "external_connected" as const, agent_owner_type: "organization", agent_protected: false, agent_slug: "local-parity" })) } as never,
    installationCredentials: { getActiveForToken: vi.fn(async () => ({ id: context.credentialId, installation_id: context.installationId, organization_id: context.organizationId, status: "active", mcp_scopes: ["mcp:read", "mcp:write"], api_scopes: ["api:read", "api:write"] })) } as never,
    controls: { isFeatureEnabled: vi.fn(async () => true) } as never,
  });
  return { app, coreMethods, runs, toolInvocations };
}

describe("local MCP and installation REST outcome parity", () => {
  it("executes bounded reads through one acceptance service and records durable evidence", async () => {
    const { app, coreMethods, runs, toolInvocations } = createLocalParityApp();
    try {
      for (const [index, testCase] of parityCases.entries()) {
        const mcp = await app.inject({
          method: "POST",
          url: "/mcp",
          headers: { authorization: `Bearer ${token("mcp")}` },
          payload: { jsonrpc: "2.0", id: index + 1, method: "tools/call", params: { name: testCase.name, arguments: testCase.args, idempotencyKey: `local-mcp-${index}-key` } },
        });
        const rest = await app.inject({
          method: "POST",
          url: `/v1/installations/${context.installationId}/tools/call`,
          headers: { authorization: `Bearer ${token("kasitek-public-api")}` },
          payload: { name: testCase.name, arguments: testCase.args, idempotencyKey: `local-rest-${index}-key` },
        });

        expect(mcp.statusCode, testCase.name).toBe(200);
        expect(rest.statusCode, testCase.name).toBe(202);
        expect(mcp.json()).toMatchObject({ result: { structuredContent: { status: "completed", approvalRequired: false, output: testCase.output } } });
        expect(rest.json()).toMatchObject({ status: "completed", approvalRequired: false, output: testCase.output });
        expect(coreMethods[testCase.method], testCase.method).toHaveBeenCalledTimes(2);
      }

      expect(runs.createRun).toHaveBeenCalledTimes(parityCases.length * 2);
      expect(runs.transitionRun).toHaveBeenCalledTimes(parityCases.length * 4);
      expect(runs.completeRun).toHaveBeenCalledTimes(parityCases.length * 2);
      expect(toolInvocations.recordProposal).toHaveBeenCalledTimes(parityCases.length * 2);
      expect(toolInvocations.recordCompleted).toHaveBeenCalledTimes(parityCases.length * 2);
      expect(toolInvocations.recordFailed).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("keeps the operation argument and installation context identical across transports", async () => {
    const { app, coreMethods } = createLocalParityApp();
    try {
      const testCase = parityCases.find((candidate) => candidate.name === "kasitek.core.contacts_list")!;
      await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${token("mcp")}` },
        payload: { jsonrpc: "2.0", id: 81, method: "tools/call", params: { name: testCase.name, arguments: testCase.args, idempotencyKey: "same-transport-key" } },
      });
      await app.inject({
        method: "POST",
        url: `/v1/installations/${context.installationId}/tools/call`,
        headers: { authorization: `Bearer ${token("kasitek-public-api")}` },
        payload: { name: testCase.name, arguments: testCase.args, idempotencyKey: "same-transport-key" },
      });

      const calls = coreMethods.listContacts!.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[1]).toEqual({ q: "Ada", optIn: "true", excluded: undefined, tag: undefined, location: undefined, listLabel: undefined, limit: 25 });
      expect(calls[1]?.[1]).toEqual(calls[0]?.[1]);
      expect(calls[0]?.[0]).toMatchObject({ organizationId: context.organizationId, installationId: context.installationId, actorId: `installation:${context.installationId}` });
      expect(calls[1]?.[0]).toMatchObject({ organizationId: context.organizationId, installationId: context.installationId, actorId: `installation:${context.installationId}` });
    } finally {
      await app.close();
    }
  });
});
