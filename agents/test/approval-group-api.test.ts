import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/http/app";
import type { AppConfig } from "../src/config";
import { ToolRegistry } from "../src/tools/registry";

const organizationId = "org-approval-api";
const installationId = "install-approval-api";
const runId = "run-approval-api";
const groupId = randomUUID();
const planDigest = "a".repeat(64);
const capability = "test.approval_effect";
const argumentsValue = { postId: "resource-1" };
const resourceSnapshot = { capability, request: argumentsValue };

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  HOST: "127.0.0.1",
  AGENTS_DATABASE_URL: "postgres://unused",
  AGENTS_DATABASE_POOL_MAX: 1,
  TEMPORAL_ENABLED: true,
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "approval-api",
  INTERNAL_AUTH_AUDIENCE: "approval-api",
  AUTH_MODE: "headers",
  LOG_LEVEL: "silent",
};

const fakePool = { query: async () => ({ rows: [] }) } as never;

function group(status: "pending" | "approved" = "pending") {
  return {
    id: groupId,
    organization_id: organizationId,
    installation_id: installationId,
    run_id: runId,
    batch_id: `${runId}:batch:1`,
    turn_key: "model-turn:1",
    plan_digest: planDigest,
    policy_revision: "v1",
    status,
    selected_operation_ids: status === "approved" ? ["operation-1"] : [],
    decision: status === "approved" ? "approved" : null,
    decided_by: status === "approved" ? "operator-1" : null,
    decision_idempotency_key: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    created_at: new Date().toISOString(),
    decided_at: null,
    consumed_at: null,
  };
}

function operation() {
  return {
    id: "approval-1",
    organization_id: organizationId,
    installation_id: installationId,
    run_id: runId,
    approval_group_id: groupId,
    provider_tool_call_id: "provider-1",
    runtime_operation_id: "operation-1",
    capability,
    capability_version: "1.0.0",
    arguments_hash: "b".repeat(64),
    resource_snapshot: resourceSnapshot,
    preview_revision: "preview-1",
    approved_by: null,
    policy_revision: "v1",
    permitted_effect_key: "effect-1",
    status: "pending",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    created_at: new Date().toISOString(),
    decided_at: null,
    consumed_at: null,
  };
}

function buildFixture(currentSnapshot = resourceSnapshot) {
  const currentGroup = group();
  const currentOperation = { ...operation(), resource_snapshot: currentSnapshot };
  const getGroup = vi.fn(async (organization: string) => organization === organizationId ? currentGroup : null);
  const listGroupOperations = vi.fn(async () => [currentOperation]);
  const decideGroup = vi.fn(async (input: { approvedBy: string }) => ({
    accepted: true,
    group: { ...currentGroup, status: "approved", decision: "approved", decided_by: input.approvedBy, selected_operation_ids: ["operation-1"] },
    approvals: [{ ...currentOperation, status: "approved", approved_by: input.approvedBy }],
  }));
  const invalidateGroup = vi.fn(async () => ({ ...currentGroup, status: "invalidated", decision: "rejected" }));
  const signalApprovalGroup = vi.fn(async () => undefined);
  const appendEvent = vi.fn(async () => undefined);
  const registry = new ToolRegistry();
  registry.registerManifest({
    name: capability,
    version: "1.0.0",
    description: "Approval API test capability",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 1_000,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    manifest: {
      ownerService: "test",
      requiredScope: "test.approval.write",
      execution: "durable",
      idempotency: "required",
      approval: "always",
      auditClassification: "full",
      redaction: [],
    },
  });
  const app = buildApp({
    config,
    pool: fakePool,
    agents: { getInstallation: async () => ({ id: installationId, organization_id: organizationId, agent_definition_id: "agent-1", agent_version_id: "version-1", status: "active" }) } as never,
    runs: {
      getRun: async () => ({ id: runId, organization_id: organizationId, installation_id: installationId, agent_definition_id: "agent-1", agent_version_id: "version-1", conversation_id: null, trigger_type: "manual", status: "awaiting_approval", input: {}, output: null, error: null, correlation_id: randomUUID(), causation_id: null, created_by: "user-1", created_at: new Date().toISOString(), started_at: null, finished_at: null, updated_at: new Date().toISOString() }),
      appendEvent,
    } as never,
    approvals: { getGroup, listGroupOperations, decideGroup, invalidateGroup } as never,
    toolInvocations: { getProposal: async () => ({ organizationId, runId, providerToolCallId: "provider-1", runtimeOperationId: "operation-1", sequenceNumber: 1, toolName: capability, toolVersion: "1.0.0", riskClass: "external-effect", argumentsHash: "b".repeat(64), arguments: argumentsValue, requiresApproval: true }) } as never,
    toolGrants: { effectiveTools: async () => new Set([capability]) } as never,
    installationGrants: { effective: async () => ({ resources: [], connectors: [] }) } as never,
    toolRegistry: registry,
    effectReceipts: { markNotExecuted: async () => undefined } as never,
    signalApprovalGroup,
  });
  return { app, getGroup, listGroupOperations, decideGroup, invalidateGroup, signalApprovalGroup, appendEvent };
}

describe("approval-group API", () => {
  it("invalidates a group when the reviewed resource changed before approval", async () => {
    const fixture = buildFixture({ capability, request: { resourceId: "changed-resource" } });
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/approval-group`,
        headers: { "x-organization-id": organizationId, "x-actor-id": "operator-1" },
        payload: { groupId, planDigest, decision: "approved" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "approval_group_invalidated" });
      expect(fixture.invalidateGroup).toHaveBeenCalledWith(organizationId, runId, groupId, "resource_snapshot_changed");
      expect(fixture.decideGroup).not.toHaveBeenCalled();
      expect(fixture.signalApprovalGroup).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });

  it("accepts a matching group decision once and signals the durable workflow", async () => {
    const fixture = buildFixture();
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/approval-group`,
        headers: { "x-organization-id": organizationId, "x-actor-id": "operator-1", "idempotency-key": "approval-api-1" },
        payload: { groupId, planDigest, decision: "approved" },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ runId, groupId, status: "approval_group_signalled", decision: "approved" });
      expect(fixture.decideGroup).toHaveBeenCalledTimes(1);
      expect(fixture.signalApprovalGroup).toHaveBeenCalledWith(runId, expect.objectContaining({ groupId, planDigest, decision: "approved" }));
      expect(fixture.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "agent.approval.group.approved" }));
    } finally {
      await fixture.app.close();
    }
  });

  it("does not expose a group across organizations", async () => {
    const fixture = buildFixture();
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/approval-group`,
        headers: { "x-organization-id": "other-org", "x-actor-id": "operator-1" },
        payload: { groupId, planDigest, decision: "approved" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: "approval_group_not_found" });
      expect(fixture.decideGroup).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });
});
