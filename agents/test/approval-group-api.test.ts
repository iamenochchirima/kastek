import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/http/app";
import type { AppConfig } from "../src/config";
import { signInternalToken } from "../src/http/auth";
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

type FixtureGroupStatus = "pending" | "approved" | "partially_approved" | "rejected" | "expired" | "cancelled" | "invalidated" | "consumed";

function group(status: FixtureGroupStatus = "pending", expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  const decided = status !== "pending";
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
    decision: status === "approved" ? "approved" : decided ? "rejected" : null,
    decided_by: decided ? "operator-1" : null,
    decision_idempotency_key: null,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
    decided_at: decided ? new Date().toISOString() : null,
    consumed_at: null,
  };
}

function operation(index = 1) {
  return {
    id: `approval-${index}`,
    organization_id: organizationId,
    installation_id: installationId,
    run_id: runId,
    approval_group_id: groupId,
    provider_tool_call_id: `provider-${index}`,
    runtime_operation_id: `operation-${index}`,
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

function buildFixture(currentSnapshot = resourceSnapshot, options: { status?: FixtureGroupStatus; expiresAt?: string; runStatus?: string; decideError?: string; operationCount?: number; runInstallationId?: string; authMode?: "headers" | "token" } = {}) {
  const currentGroup = group(options.status, options.expiresAt);
  const currentOperations = Array.from({ length: options.operationCount ?? 1 }, (_, index) => ({
    ...operation(index + 1),
    resource_snapshot: index === 0 ? currentSnapshot : { ...resourceSnapshot, operationId: index + 1 },
  }));
  const getGroup = vi.fn(async (organization: string) => organization === organizationId ? currentGroup : null);
  const listGroupOperations = vi.fn(async () => currentOperations);
  const decideGroup = vi.fn(async (input: { approvedBy: string; decision: "approved" | "rejected" }) => {
    if (options.decideError) throw new Error(options.decideError);
    if (currentGroup.status !== "pending") {
      return {
        accepted: false,
        group: currentGroup,
        approvals: currentOperations.map((operation) => ({ ...operation, status: currentGroup.status === "approved" ? "approved" : "denied", approved_by: currentGroup.decided_by })),
      };
    }
    const approved = input.decision === "approved";
    return {
      accepted: true,
      group: {
        ...currentGroup,
        status: approved ? "approved" : "rejected",
        decision: input.decision,
        decided_by: input.approvedBy,
        selected_operation_ids: approved ? ["operation-1"] : [],
      },
      approvals: currentOperations.map((operation) => ({
        ...operation,
        status: approved ? "approved" : "denied",
        approved_by: input.approvedBy,
      })),
    };
  });
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
  const fixtureConfig: AppConfig = options.authMode === "token"
    ? { ...config, AUTH_MODE: "token", INTERNAL_AUTH_SECRET: "approval-api-secret" }
    : config;
  const app = buildApp({
    config: fixtureConfig,
    pool: fakePool,
    agents: { getInstallation: async () => ({ id: installationId, organization_id: organizationId, agent_definition_id: "agent-1", agent_version_id: "version-1", status: "active" }) } as never,
    runs: {
      getRun: async () => ({ id: runId, organization_id: organizationId, installation_id: options.runInstallationId ?? installationId, agent_definition_id: "agent-1", agent_version_id: "version-1", conversation_id: null, trigger_type: "manual", status: options.runStatus ?? "awaiting_approval", input: {}, output: null, error: null, correlation_id: randomUUID(), causation_id: null, created_by: "user-1", created_at: new Date().toISOString(), started_at: null, finished_at: null, updated_at: new Date().toISOString() }),
      listEvents: async () => [],
      appendEvent,
    } as never,
    approvals: {
      getGroup,
      listGroupOperations,
      getForRun: async () => null,
      getActiveGroup: async () => ["pending", "approved", "partially_approved"].includes(currentGroup.status)
        ? { group: currentGroup, approvals: currentOperations }
        : null,
      listGroups: async () => [currentGroup],
      decideGroup,
      invalidateGroup,
    } as never,
    toolInvocations: { getProposal: async () => ({ organizationId, runId, providerToolCallId: "provider-1", runtimeOperationId: "operation-1", sequenceNumber: 1, toolName: capability, toolVersion: "1.0.0", riskClass: "external-effect", argumentsHash: "b".repeat(64), arguments: argumentsValue, requiresApproval: true }) } as never,
    toolGrants: { effectiveTools: async () => new Set([capability]) } as never,
    installationGrants: { effective: async () => ({ resources: [], connectors: [] }) } as never,
    toolRegistry: registry,
    effectReceipts: { markNotExecuted: async () => undefined } as never,
    signalApprovalGroup,
  });
  return { app, config: fixtureConfig, getGroup, listGroupOperations, decideGroup, invalidateGroup, signalApprovalGroup, appendEvent };
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
      expect(fixture.signalApprovalGroup).toHaveBeenCalledWith(runId, expect.objectContaining({ groupId, decision: "invalidated" }));
      expect(fixture.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "agent.approval.group.invalidated" }));
      expect(fixture.decideGroup).not.toHaveBeenCalled();
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
      expect(fixture.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
        eventType: "agent.approval.group.approved",
        payload: expect.objectContaining({
          approvalGroupId: groupId,
          runId,
          batchId: `${runId}:batch:1`,
          planDigest,
          policyRevision: "v1",
          operationCount: 1,
          selectedCount: 1,
          actor: "operator-1",
          approvedBy: "operator-1",
        }),
      }));
      expect(fixture.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
        eventType: "agent.approval.group.resumed",
        payload: expect.objectContaining({ operationCount: 1, selectedCount: 1, actor: "operator-1" }),
      }));
    } finally {
      await fixture.app.close();
    }
  });

  it("accepts a rejected group decision and signals every operation as denied", async () => {
    const fixture = buildFixture();
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/approval-group`,
        headers: { "x-organization-id": organizationId, "x-actor-id": "operator-1" },
        payload: { groupId, planDigest, decision: "rejected" },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        runId,
        groupId,
        status: "approval_group_signalled",
        decision: "rejected",
        selectedOperationIds: [],
      });
      expect(fixture.decideGroup).toHaveBeenCalledWith(expect.objectContaining({ decision: "rejected" }));
      expect(fixture.signalApprovalGroup).toHaveBeenCalledWith(runId, expect.objectContaining({ decision: "rejected", selectedOperationIds: [] }));
      expect(fixture.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
        eventType: "agent.approval.group.rejected",
        payload: expect.objectContaining({ selectedCount: 0, actor: "operator-1" }),
      }));
    } finally {
      await fixture.app.close();
    }
  });

  it("records a stale digest decision conflict without signaling the workflow", async () => {
    const fixture = buildFixture();
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/approval-group`,
        headers: { "x-organization-id": organizationId, "x-actor-id": "operator-1" },
        payload: { groupId, planDigest: "c".repeat(64), decision: "approved" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "approval_group_digest_mismatch" });
      expect(fixture.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "agent.approval.group.decision_conflict" }));
      expect(fixture.signalApprovalGroup).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });

  it("returns an idempotent already-signalled response without creating another decision", async () => {
    const fixture = buildFixture(resourceSnapshot, { status: "approved" });
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/approval-group`,
        headers: { "x-organization-id": organizationId, "x-actor-id": "operator-1" },
        payload: { groupId, planDigest, decision: "approved", selectedOperationIds: ["operation-1"] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "approval_group_already_signalled", decision: "approved" });
      expect(fixture.decideGroup).toHaveBeenCalledTimes(1);
      expect(fixture.signalApprovalGroup).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.app.close();
    }
  });

  it("returns an explicit expired outcome from a late decision", async () => {
    const fixture = buildFixture(resourceSnapshot, {
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      decideError: "APPROVAL_GROUP_EXPIRED",
    });
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/approval-group`,
        headers: { "x-organization-id": organizationId, "x-actor-id": "operator-1" },
        payload: { groupId, planDigest, decision: "approved" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "approval_group_expired" });
      expect(fixture.signalApprovalGroup).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });

  it("rejects a decision after cancellation as a terminal conflict", async () => {
    const fixture = buildFixture(resourceSnapshot, { status: "cancelled", decideError: "APPROVAL_GROUP_NOT_PENDING" });
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/approval-group`,
        headers: { "x-organization-id": organizationId, "x-actor-id": "operator-1" },
        payload: { groupId, planDigest, decision: "approved" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "approval_group_not_pending" });
      expect(fixture.signalApprovalGroup).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });

  it("projects the complete active group and historical group summaries in run detail", async () => {
    const fixture = buildFixture();
    try {
      const response = await fixture.app.inject({
        method: "GET",
        url: `/v1/runs/${runId}`,
        headers: { "x-organization-id": organizationId, "x-actor-id": "operator-1" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        approvalGroup: { id: groupId, operations: [{ runtimeOperationId: "operation-1" }] },
        approvalGroups: [{ id: groupId, operations: [{ runtimeOperationId: "operation-1" }] }],
      });
    } finally {
      await fixture.app.close();
    }
  });

  it("projects all operations in a large historical group", async () => {
    const fixture = buildFixture(resourceSnapshot, { status: "consumed", runStatus: "completed", operationCount: 256 });
    try {
      const response = await fixture.app.inject({
        method: "GET",
        url: `/v1/runs/${runId}`,
        headers: { "x-organization-id": organizationId, "x-actor-id": "operator-1" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ approvalGroup: null, approvalGroups: [{ id: groupId, operations: expect.any(Array) }] });
      expect(response.json().approvalGroups[0].operations).toHaveLength(256);
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

  it("does not approve a group bound to a different run installation", async () => {
    const fixture = buildFixture(resourceSnapshot, { runInstallationId: "other-installation" });
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/approval-group`,
        headers: { "x-organization-id": organizationId, "x-actor-id": "operator-1" },
        payload: { groupId, planDigest, decision: "approved" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: "approval_group_not_found" });
      expect(fixture.decideGroup).not.toHaveBeenCalled();
      expect(fixture.signalApprovalGroup).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });

  it("does not expose a group through a different run id", async () => {
    const fixture = buildFixture();
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: "/v1/runs/other-run/approval-group",
        headers: { "x-organization-id": organizationId, "x-actor-id": "operator-1" },
        payload: { groupId, planDigest, decision: "approved" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: "approval_group_not_found" });
      expect(fixture.decideGroup).not.toHaveBeenCalled();
      expect(fixture.signalApprovalGroup).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });

  it("requires the approval scope for token-authenticated callers", async () => {
    const fixture = buildFixture(resourceSnapshot, { authMode: "token" });
    const token = signInternalToken({
      organizationId,
      actorId: "operator-without-approval-scope",
      audience: fixture.config.INTERNAL_AUTH_AUDIENCE,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      scopes: [],
    }, fixture.config.INTERNAL_AUTH_SECRET!);
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/approval-group`,
        headers: { authorization: `Bearer ${token}` },
        payload: { groupId, planDigest, decision: "approved" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "Missing internal scope: runs:approve" });
      expect(fixture.decideGroup).not.toHaveBeenCalled();
      expect(fixture.signalApprovalGroup).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });

  it("does not approve a pending group after its run has completed", async () => {
    const fixture = buildFixture(resourceSnapshot, { runStatus: "completed" });
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/approval-group`,
        headers: { "x-organization-id": organizationId, "x-actor-id": "operator-1" },
        payload: { groupId, planDigest, decision: "approved" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "run_not_awaiting_approval" });
      expect(fixture.decideGroup).not.toHaveBeenCalled();
      expect(fixture.signalApprovalGroup).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });
});
