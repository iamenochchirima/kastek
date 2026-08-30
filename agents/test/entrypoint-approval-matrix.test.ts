import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/http/app";
import type { AppConfig } from "../src/config";
import { issueInstallationToken } from "../src/auth/installation-token";
import { ToolPolicyError } from "../src/tools/types";
import { ToolRegistry, hashToolArguments } from "../src/tools/registry";

const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const installationId = "install-entrypoint-matrix";
const hostedInstallationId = "install-hosted-entrypoint-matrix";
const organizationId = "org-entrypoint-matrix";
const credentialId = "credential-entrypoint-matrix";
const actorId = "entrypoint-initiator";
const approverId = "entrypoint-approver";
const privateKey = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 4100,
  HOST: "127.0.0.1",
  AGENTS_DATABASE_URL: "postgres://unused",
  AGENTS_DATABASE_POOL_MAX: 1,
  TEMPORAL_ENABLED: true,
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "entrypoint-matrix",
  INTERNAL_AUTH_AUDIENCE: "entrypoint-matrix",
  AUTH_MODE: "headers",
  INSTALLATION_TOKEN_PRIVATE_KEY: privateKey,
  INSTALLATION_TOKEN_ISSUER: "entrypoint-matrix",
  LOG_LEVEL: "silent",
};

const fakePool = { query: async () => ({ rows: [] }) } as never;

type Decision = "approved" | "rejected";
type Source = "hosted" | "mcp" | "rest" | "kasiai" | "channel";
type Operation = {
  source: Source;
  decision: Decision;
  tag: string;
  runId: string;
  providerToolCallId: string;
  argumentsHash: string;
};

function token(audience: "mcp" | "kasitek-public-api"): string {
  return issueInstallationToken({
    privateKeyPem: privateKey,
    issuer: config.INSTALLATION_TOKEN_ISSUER,
    installationId,
    organizationId,
    credentialId,
    audience,
  }).accessToken;
}

function approvalManifest() {
  return {
    name: "test.entrypoint_effect",
    version: "1.0.0",
    description: "Matrix-only approval-gated effect.",
    riskClass: "external-effect" as const,
    requiresApproval: true,
    timeoutMs: 2_000,
    inputSchema: {
      type: "object",
      properties: { resourceId: { type: "string", minLength: 1 } },
      required: ["resourceId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { ok: { type: "boolean" }, source: { type: "string" } },
      required: ["ok", "source"],
      additionalProperties: false,
    },
    handler: vi.fn(async (_context, argumentsValue: Record<string, unknown>) => ({ ok: true, source: argumentsValue.resourceId as string })),
    manifest: {
      ownerService: "entrypoint-matrix",
      requiredScope: "test.entrypoint.write",
      execution: "durable" as const,
      idempotency: "required" as const,
      approval: "always" as const,
      auditClassification: "full" as const,
      redaction: [],
    },
  };
}

function installation(id = installationId) {
  return {
    id,
    organization_id: organizationId,
    agent_definition_id: "agent-entrypoint-matrix",
    agent_version_id: "version-entrypoint-matrix",
    status: "active",
    execution_mode: id === installationId ? "external_connected" : "kasitek_hosted",
    agent_owner_type: "organization",
    agent_protected: false,
    agent_slug: "entrypoint-matrix",
  };
}

function credential() {
  return {
    id: credentialId,
    installation_id: installationId,
    organization_id: organizationId,
    status: "active",
    mcp_scopes: ["mcp:read", "mcp:write"],
    api_scopes: ["api:read", "api:write"],
  };
}

function runFor(operation: Operation) {
  return {
    id: operation.runId,
    organization_id: organizationId,
    installation_id: installationId,
    agent_definition_id: "agent-entrypoint-matrix",
    agent_version_id: "version-entrypoint-matrix",
    conversation_id: null,
    trigger_type: operation.source === "channel" || operation.source === "kasiai" ? "message" : "manual",
    status: "awaiting_approval",
    input: { source: operation.source, resourceId: operation.tag },
    output: null,
    error: null,
    correlation_id: randomUUID(),
    causation_id: null,
    created_by: `${operation.source}:${actorId}`,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    updated_at: new Date().toISOString(),
  };
}

describe("cross-entrypoint approval and effect matrix", () => {
  it("keeps hosted, MCP, REST, KasiAi, and channel actions on one approval boundary", async () => {
    const registry = new ToolRegistry();
    const manifest = approvalManifest();
    registry.registerManifest(manifest);
    const operations = new Map<string, Operation>();
    const signalApproval = vi.fn(async () => undefined);
    const markNotExecuted = vi.fn(async () => undefined);
    const accepts = vi.fn(async (input: { actorId: string; argumentsValue: Record<string, unknown>; toolCallId: string }) => {
      const tag = String(input.argumentsValue.resourceId);
      const source = tag.split("-")[0] as Source;
      const decision = tag.endsWith("approved") ? "approved" : "rejected";
      const operation: Operation = {
        source,
        decision,
        tag,
        runId: `entrypoint-${tag}`,
        providerToolCallId: input.toolCallId,
        argumentsHash: hashToolArguments(input.argumentsValue),
      };
      operations.set(operation.runId, operation);
      return { accepted: { id: operation.runId, status: "awaiting_approval" }, manifest };
    });

    const platformChat = {
      acceptMessage: vi.fn(async (input: { message: string }) => {
        const tag = input.message;
        const operation = await accepts({ actorId, argumentsValue: { resourceId: tag }, toolCallId: `call-${tag}` });
        const current = operations.get(operation.accepted.id)!;
        return {
          conversation: { id: `conversation-${tag}` },
          userParticipant: { id: `user-${tag}` },
          agentParticipant: { id: `agent-${tag}` },
          message: { id: `message-${tag}` },
          run: runFor(current),
          created: true,
        };
      }),
      acceptExternalMessage: vi.fn(async (input: { content: Record<string, unknown> }) => {
        const tag = String(input.content.text);
        const operation = await accepts({ actorId, argumentsValue: { resourceId: tag }, toolCallId: `call-${tag}` });
        const current = operations.get(operation.accepted.id)!;
        return {
          conversation: { id: `conversation-${tag}` },
          userParticipant: { id: `user-${tag}` },
          agentParticipant: { id: `agent-${tag}` },
          sourceParticipant: { id: `source-${tag}` },
          message: { id: `message-${tag}` },
          run: runFor(current),
          created: true,
        };
      }),
    };

    const runs = {
      getRun: vi.fn(async (_organization: string, runId: string) => {
        const operation = operations.get(runId);
        return operation ? runFor(operation) : null;
      }),
    };
    const approvalRecord = (operation: Operation) => ({
      id: `approval-${operation.runId}`,
      organization_id: organizationId,
      installation_id: installationId,
      run_id: operation.runId,
      provider_tool_call_id: operation.providerToolCallId,
      capability: manifest.name,
      capability_version: manifest.version,
      arguments_hash: operation.argumentsHash,
      resource_snapshot: { source: operation.source, resourceId: operation.tag },
      preview_revision: operation.argumentsHash,
      approved_by: null,
      policy_revision: "matrix-v1",
      permitted_effect_key: `${operation.runId}:${operation.providerToolCallId}`,
      status: "pending",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      created_at: new Date().toISOString(),
      decided_at: null,
      consumed_at: null,
    });
    const approvals = {
      getForRun: vi.fn(async (_organization: string, runId: string) => {
        const operation = operations.get(runId);
        return operation ? approvalRecord(operation) : null;
      }),
      decide: vi.fn(async (input: { runId: string; decision: Decision }) => {
        const operation = operations.get(input.runId)!;
        return { accepted: true, approval: { ...approvalRecord(operation), status: input.decision === "approved" ? "approved" : "denied", approved_by: approverId } };
      }),
    };
    const toolInvocations = {
      getProposal: vi.fn(async (_organization: string, runId: string, providerToolCallId: string) => {
        const operation = operations.get(runId);
        if (!operation || operation.providerToolCallId !== providerToolCallId) return null;
        return {
          organizationId,
          runId,
          providerToolCallId,
          sequenceNumber: 1,
          toolName: manifest.name,
          toolVersion: manifest.version,
          riskClass: manifest.riskClass,
          argumentsHash: operation.argumentsHash,
          arguments: { resourceId: operation.tag },
          requiresApproval: true,
        };
      }),
    };
    const app = buildApp({
      config,
      pool: fakePool,
      agents: { getInstallation: async (_organizationId: string, requestedInstallationId: string) => installation(requestedInstallationId) } as never,
      platformChat: platformChat as never,
      installationCredentials: { getActiveForToken: async () => credential() } as never,
      installationInvocations: { accept: accepts } as never,
      toolRegistry: registry,
      toolGrants: { effectiveTools: async () => new Set([manifest.name]) } as never,
      installationGrants: { effective: async () => ({ resources: [], connectors: [] }) } as never,
      killSwitches: { isBlocked: async () => false } as never,
      controls: { isFeatureEnabled: async () => true } as never,
      runs: runs as never,
      approvals: approvals as never,
      toolInvocations: toolInvocations as never,
      effectReceipts: { markNotExecuted } as never,
      signalApproval,
    });

    const authHeaders = { "x-organization-id": organizationId, "x-actor-id": actorId };
    const accepted: Record<Source, { approved: Operation; rejected: Operation }> = {} as never;
    try {
      const hosted = await accepts({ actorId, argumentsValue: { resourceId: "hosted-approved" }, toolCallId: "call-hosted-approved" });
      await accepts({ actorId, argumentsValue: { resourceId: "hosted-rejected" }, toolCallId: "call-hosted-rejected" });
      const mcpApproved = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${token("mcp")}` },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: manifest.name, arguments: { resourceId: "mcp-approved" }, toolCallId: "call-mcp-approved", idempotencyKey: "matrix-mcp-approved" } },
      });
      const mcpRejected = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${token("mcp")}` },
        payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: manifest.name, arguments: { resourceId: "mcp-rejected" }, toolCallId: "call-mcp-rejected", idempotencyKey: "matrix-mcp-rejected" } },
      });
      const restApproved = await app.inject({
        method: "POST",
        url: `/v1/installations/${installationId}/tools/call`,
        headers: { authorization: `Bearer ${token("kasitek-public-api")}` },
        payload: { name: manifest.name, arguments: { resourceId: "rest-approved" }, toolCallId: "call-rest-approved", idempotencyKey: "matrix-rest-approved" },
      });
      const restRejected = await app.inject({
        method: "POST",
        url: `/v1/installations/${installationId}/tools/call`,
        headers: { authorization: `Bearer ${token("kasitek-public-api")}` },
        payload: { name: manifest.name, arguments: { resourceId: "rest-rejected" }, toolCallId: "call-rest-rejected", idempotencyKey: "matrix-rest-rejected" },
      });
      const kasiaiApproved = await app.inject({
        method: "POST",
        url: `/v1/installations/${hostedInstallationId}/platform/messages`,
        headers: authHeaders,
        payload: { message: "kasiai-approved", createNew: true, idempotencyKey: "matrix-kasiai-approved" },
      });
      const kasiaiRejected = await app.inject({
        method: "POST",
        url: `/v1/installations/${hostedInstallationId}/platform/messages`,
        headers: authHeaders,
        payload: { message: "kasiai-rejected", createNew: true, idempotencyKey: "matrix-kasiai-rejected" },
      });
      const channelApproved = await app.inject({
        method: "POST",
        url: `/v1/installations/${hostedInstallationId}/channels/inbound`,
        headers: authHeaders,
        payload: { channelType: "telegram", provider: "telegram", providerEventId: "matrix-channel-approved", providerMessageId: "matrix-channel-approved", externalIdentity: "customer-approved", externalConversationId: "thread-approved", occurredAt: "2026-08-30T20:24:01.327+00:00", content: { text: "channel-approved" } },
      });
      const channelRejected = await app.inject({
        method: "POST",
        url: `/v1/installations/${hostedInstallationId}/channels/inbound`,
        headers: authHeaders,
        payload: { channelType: "telegram", provider: "telegram", providerEventId: "matrix-channel-rejected", providerMessageId: "matrix-channel-rejected", externalIdentity: "customer-rejected", externalConversationId: "thread-rejected", content: { text: "channel-rejected" } },
      });

      expect(mcpApproved.statusCode).toBe(200);
      expect(mcpRejected.statusCode).toBe(200);
      expect(restApproved.statusCode).toBe(202);
      expect(restRejected.statusCode).toBe(202);
      expect(kasiaiApproved.statusCode).toBe(202);
      expect(kasiaiRejected.statusCode).toBe(202);
      expect(channelApproved.statusCode).toBe(202);
      expect(channelRejected.statusCode).toBe(202);
      expect(hosted.accepted.status).toBe("awaiting_approval");
      expect(operations).toHaveLength(10);

      for (const source of ["hosted", "mcp", "rest", "kasiai", "channel"] as const) {
        accepted[source] = {
          approved: [...operations.values()].find((operation) => operation.source === source && operation.decision === "approved")!,
          rejected: [...operations.values()].find((operation) => operation.source === source && operation.decision === "rejected")!,
        };
      }
      expect(Object.values(accepted).every(({ approved, rejected }) => approved && rejected)).toBe(true);

      for (const operation of [...operations.values()]) {
        const response = await app.inject({
          method: "POST",
          url: `/v1/runs/${operation.runId}/approval`,
          headers: { ...authHeaders, "x-actor-id": approverId },
          payload: { decision: operation.decision, providerToolCallId: operation.providerToolCallId, argumentsHash: operation.argumentsHash },
        });
        expect(response.statusCode, `${operation.source}/${operation.decision}`).toBe(202);
        expect(response.json()).toMatchObject({ runId: operation.runId, status: "approval_signalled" });
      }
      expect(approvals.decide).toHaveBeenCalledTimes(10);
      expect(signalApproval).toHaveBeenCalledTimes(10);
      expect(markNotExecuted).toHaveBeenCalledTimes(5);

      for (const operation of [...operations.values()]) {
        const effectHook = vi.fn();
        if (operation.decision === "approved") {
          const result = await registry.invoke({
            name: manifest.name,
            arguments: { resourceId: operation.tag },
            context: { organizationId, agentId: "agent-entrypoint-matrix", agentVersionId: "version-entrypoint-matrix", installationId, runId: operation.runId, actorId: approverId, correlationId: randomUUID() },
            grantedTools: new Set([manifest.name]),
            approval: { approvedBy: approverId, argumentsHash: operation.argumentsHash, expiresAt: new Date(Date.now() + 60_000).toISOString() },
            beforeEffect: effectHook,
          });
          expect(result.output).toMatchObject({ ok: true, source: operation.tag });
          expect(effectHook).toHaveBeenCalledTimes(1);
        } else {
          await expect(registry.invoke({
            name: manifest.name,
            arguments: { resourceId: operation.tag },
            context: { organizationId, agentId: "agent-entrypoint-matrix", agentVersionId: "version-entrypoint-matrix", installationId, runId: operation.runId, actorId: approverId, correlationId: randomUUID() },
            grantedTools: new Set([manifest.name]),
            beforeEffect: effectHook,
          })).rejects.toMatchObject<ToolPolicyError>({ code: "APPROVAL_REQUIRED" });
          expect(effectHook).not.toHaveBeenCalled();
        }
      }
    } finally {
      await app.close();
    }
  });
});
