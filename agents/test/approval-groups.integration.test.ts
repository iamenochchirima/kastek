import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApprovalRepository, type ApprovalGroupProposal } from "../src/db/repositories/approval-repository";
import { RunRepository } from "../src/db/repositories/run-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("durable approval groups (PostgreSQL integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const runs = new RunRepository(pool);
  const approvals = new ApprovalRepository(pool);
  const organizationId = `approval-group-test-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();

  beforeAll(async () => {
    const setup = await pool.connect();
    try {
      await setup.query("CREATE TEMP TABLE analytics_outbox (LIKE public.analytics_outbox INCLUDING DEFAULTS INCLUDING IDENTITY INCLUDING CONSTRAINTS INCLUDING INDEXES) ON COMMIT PRESERVE ROWS");
      await setup.query("CREATE TRIGGER analytics_outbox_updated_at_trigger BEFORE UPDATE ON analytics_outbox FOR EACH ROW EXECUTE FUNCTION analytics_outbox_set_updated_at()");
      await setup.query("CREATE TRIGGER analytics_outbox_content_trigger BEFORE UPDATE OR DELETE ON analytics_outbox FOR EACH ROW EXECUTE FUNCTION analytics_outbox_protect_content()");
    } finally {
      setup.release();
    }
    await pool.query("INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1, $2, 'Approval group test', $3, 'test')", [agentId, organizationId, `approval-group-${agentId}`]);
    await pool.query("INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status) VALUES ($1, $2, 1, 'test', 'approval-group-test', 'test', 'published')", [versionId, agentId]);
    await pool.query("INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, settings, created_by) VALUES ($1, $2, $3, $4, 'organization', $4, 'kasitek_hosted', $5::jsonb, 'test')", [installationId, agentId, versionId, organizationId, JSON.stringify({ environment: "playground" })]);
  });

  afterAll(async () => {
    await pool.end();
  });

  function proposals(count: number, prefix: string): ApprovalGroupProposal[] {
    return Array.from({ length: count }, (_, index) => ({
      providerToolCallId: `${prefix}-provider-${index}`,
      runtimeOperationId: `${prefix}-operation-${index}`,
      capability: "kasitek.calendar.delete",
      capabilityVersion: "1.0.0",
      argumentsHash: (String(index).padStart(64, "0")),
      resourceSnapshot: { resource: `${prefix}-event-${index}` },
      previewRevision: `preview-${index}`,
      policyRevision: "v1",
      permittedEffectKey: `${prefix}:effect:${index}`,
    }));
  }

  async function createRun(idempotencyKey: string) {
    const run = await runs.createRun(organizationId, "test-user", {
      installationId,
      idempotencyKey,
      input: { message: "approval group integration" },
      triggerType: "manual",
    });
    return run.id;
  }

  it("persists and consumes an 18-operation group with selected approval", async () => {
    const runId = await createRun(`group-18-${randomUUID()}`);
    const input = proposals(18, "group-18");
    const created = await approvals.createGroup({
      organizationId,
      installationId,
      runId,
      batchId: `${runId}:batch:1`,
      turnKey: "model-turn:1",
      policyRevision: "v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      proposals: input,
    });
    expect(created.approvals).toHaveLength(18);
    expect((await approvals.listGroupOperations(organizationId, created.group.id))).toHaveLength(18);

    const selectedOperationIds = created.approvals.slice(0, 9).map((approval) => approval.runtime_operation_id);
    const decision = await approvals.decideGroup({
      organizationId,
      runId,
      groupId: created.group.id,
      planDigest: created.group.plan_digest,
      decision: "approved",
      selectedOperationIds,
      approvedBy: "operator-1",
      idempotencyKey: `decision-${randomUUID()}`,
    });
    expect(decision.accepted).toBe(true);
    expect(decision.group.status).toBe("partially_approved");
    expect(decision.approvals.filter((approval) => approval.status === "approved")).toHaveLength(9);
    expect(decision.approvals.filter((approval) => approval.status === "denied")).toHaveLength(9);

    const duplicate = await approvals.decideGroup({
      organizationId,
      runId,
      groupId: created.group.id,
      planDigest: created.group.plan_digest,
      decision: "approved",
      selectedOperationIds,
      approvedBy: "operator-1",
    });
    expect(duplicate.accepted).toBe(false);

    const approvedOperations = decision.approvals.filter((candidate) => candidate.status === "approved");
    for (const approval of approvedOperations) {
      await approvals.consume({
        organizationId,
        installationId,
        runId,
        providerToolCallId: approval.provider_tool_call_id,
        runtimeOperationId: approval.runtime_operation_id,
        argumentsHash: approval.arguments_hash,
        capability: approval.capability,
        capabilityVersion: approval.capability_version,
        resourceSnapshot: approval.resource_snapshot,
        previewRevision: approval.preview_revision,
        policyRevision: approval.policy_revision,
        permittedEffectKey: approval.permitted_effect_key,
      });
    }
    expect((await approvals.getGroup(organizationId, created.group.id))?.status).toBe("consumed");
    const consumed = approvedOperations[0]!;
    await expect(approvals.consume({
      organizationId,
      installationId,
      runId,
      providerToolCallId: consumed.provider_tool_call_id,
      runtimeOperationId: consumed.runtime_operation_id,
      argumentsHash: consumed.arguments_hash,
      capability: consumed.capability,
      capabilityVersion: consumed.capability_version,
      resourceSnapshot: consumed.resource_snapshot,
      previewRevision: consumed.preview_revision,
      policyRevision: consumed.policy_revision,
      permittedEffectKey: consumed.permitted_effect_key,
    })).rejects.toThrow("already consumed");
  });

  it("serializes concurrent group decisions into one accepted decision", async () => {
    const runId = await createRun(`concurrent-${randomUUID()}`);
    const created = await approvals.createGroup({
      organizationId,
      installationId,
      runId,
      batchId: `${runId}:batch:1`,
      turnKey: "model-turn:1",
      policyRevision: "v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      proposals: proposals(18, "concurrent"),
    });
    const results = await Promise.all([
      approvals.decideGroup({ organizationId, runId, groupId: created.group.id, planDigest: created.group.plan_digest, decision: "approved", approvedBy: "operator-1" }),
      approvals.decideGroup({ organizationId, runId, groupId: created.group.id, planDigest: created.group.plan_digest, decision: "approved", approvedBy: "operator-1" }),
    ]);
    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.filter((result) => !result.accepted)).toHaveLength(1);
    expect((await approvals.getGroup(organizationId, created.group.id))?.selected_operation_ids).toHaveLength(18);
  });

  it("makes rejection terminal and returns an idempotent result for the same decision", async () => {
    const runId = await createRun(`reject-terminal-${randomUUID()}`);
    const created = await approvals.createGroup({
      organizationId,
      installationId,
      runId,
      batchId: `${runId}:batch:1`,
      turnKey: "model-turn:1",
      policyRevision: "v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      proposals: proposals(4, "reject-terminal"),
    });

    const rejected = await approvals.decideGroup({
      organizationId,
      runId,
      groupId: created.group.id,
      planDigest: created.group.plan_digest,
      decision: "rejected",
      approvedBy: "operator-1",
    });
    expect(rejected.accepted).toBe(true);
    expect(rejected.group.status).toBe("rejected");
    expect(rejected.approvals.every((approval) => approval.status === "denied")).toBe(true);

    const replay = await approvals.decideGroup({
      organizationId,
      runId,
      groupId: created.group.id,
      planDigest: created.group.plan_digest,
      decision: "rejected",
      approvedBy: "operator-1",
    });
    expect(replay.accepted).toBe(false);
    await expect(approvals.decideGroup({
      organizationId,
      runId,
      groupId: created.group.id,
      planDigest: created.group.plan_digest,
      decision: "approved",
      approvedBy: "operator-2",
    })).rejects.toThrow("APPROVAL_GROUP_NOT_PENDING");
  });

  it.each([32, 64, 128, 256])("persists and lists a %d-operation approval group", async (count) => {
    const runId = await createRun(`scale-${count}-${randomUUID()}`);
    const created = await approvals.createGroup({
      organizationId,
      installationId,
      runId,
      batchId: `${runId}:batch:1`,
      turnKey: "model-turn:1",
      policyRevision: "v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      proposals: proposals(count, `scale-${count}`),
    });

    expect(created.approvals).toHaveLength(count);
    expect(await approvals.listGroupOperations(organizationId, created.group.id)).toHaveLength(count);
  });

  it("changes the plan digest when reviewed identity or policy changes", async () => {
    const firstRunId = await createRun(`digest-first-${randomUUID()}`);
    const first = await approvals.createGroup({
      organizationId,
      installationId,
      runId: firstRunId,
      batchId: `${firstRunId}:batch:1`,
      turnKey: "model-turn:1",
      policyRevision: "v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      proposals: proposals(1, "digest-first"),
    });
    const secondRunId = await createRun(`digest-second-${randomUUID()}`);
    const changed = proposals(1, "digest-second").map((proposal) => ({
      ...proposal,
      argumentsHash: "f".repeat(64),
      policyRevision: "v2",
    }));
    const second = await approvals.createGroup({
      organizationId,
      installationId,
      runId: secondRunId,
      batchId: `${secondRunId}:batch:1`,
      turnKey: "model-turn:1",
      policyRevision: "v2",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      proposals: changed,
    });
    expect(second.group.plan_digest).not.toBe(first.group.plan_digest);
  });

  it("rejects a reordered replay and tampered operation selections", async () => {
    const runId = await createRun(`selection-integrity-${randomUUID()}`);
    const input = proposals(3, "selection-integrity");
    const created = await approvals.createGroup({
      organizationId,
      installationId,
      runId,
      batchId: `${runId}:batch:1`,
      turnKey: "model-turn:1",
      policyRevision: "v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      proposals: input,
    });

    await expect(approvals.createGroup({
      organizationId,
      installationId,
      runId,
      batchId: `${runId}:batch:1`,
      turnKey: "model-turn:1",
      policyRevision: "v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      proposals: [...input].reverse(),
    })).rejects.toThrow("stale or conflicts");

    await expect(approvals.decideGroup({
      organizationId,
      runId,
      groupId: created.group.id,
      planDigest: created.group.plan_digest,
      decision: "approved",
      selectedOperationIds: [],
      approvedBy: "operator-1",
    })).rejects.toThrow("APPROVAL_GROUP_SELECTION_EMPTY");

    await expect(approvals.decideGroup({
      organizationId,
      runId,
      groupId: created.group.id,
      planDigest: created.group.plan_digest,
      decision: "approved",
      selectedOperationIds: [created.approvals[0]!.runtime_operation_id, created.approvals[0]!.runtime_operation_id],
      approvedBy: "operator-1",
    })).rejects.toThrow("APPROVAL_GROUP_SELECTION_DUPLICATE");

    await expect(approvals.decideGroup({
      organizationId,
      runId,
      groupId: created.group.id,
      planDigest: created.group.plan_digest,
      decision: "approved",
      selectedOperationIds: ["not-in-group"],
      approvedBy: "operator-1",
    })).rejects.toThrow("APPROVAL_GROUP_OPERATION_NOT_FOUND");
  });

  it("materializes expiration before rejecting a late decision", async () => {
    const runId = await createRun(`expire-late-${randomUUID()}`);
    const created = await approvals.createGroup({
      organizationId,
      installationId,
      runId,
      batchId: `${runId}:batch:1`,
      turnKey: "model-turn:1",
      policyRevision: "v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      proposals: proposals(3, "expire-late"),
    });
    await pool.query("UPDATE agent_approval_groups SET expires_at = now() - interval '1 second' WHERE id = $1", [created.group.id]);

    await expect(approvals.decideGroup({
      organizationId,
      runId,
      groupId: created.group.id,
      planDigest: created.group.plan_digest,
      decision: "approved",
      approvedBy: "operator-1",
    })).rejects.toThrow("APPROVAL_GROUP_EXPIRED");
    expect((await approvals.getGroup(organizationId, created.group.id))?.status).toBe("expired");
    expect((await approvals.listGroupOperations(organizationId, created.group.id)).every((approval) => approval.status === "expired")).toBe(true);
  });

  it("invalidates a changed plan and cancels every unexecuted child", async () => {
    const runId = await createRun(`invalidate-${randomUUID()}`);
    const created = await approvals.createGroup({
      organizationId,
      installationId,
      runId,
      batchId: `${runId}:batch:1`,
      turnKey: "model-turn:1",
      policyRevision: "v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      proposals: proposals(4, "invalidate"),
    });
    const invalidated = await approvals.invalidateGroup(organizationId, runId, created.group.id, "resource_changed");
    expect(invalidated?.status).toBe("invalidated");
    expect((await approvals.listGroupOperations(organizationId, created.group.id)).every((approval) => approval.status === "cancelled")).toBe(true);
    await expect(approvals.decideGroup({
      organizationId,
      runId,
      groupId: created.group.id,
      planDigest: created.group.plan_digest,
      decision: "approved",
      approvedBy: "operator-1",
    })).rejects.toThrow("APPROVAL_GROUP_NOT_PENDING");
    expect((await approvals.invalidateGroup(organizationId, runId, created.group.id, "repeat"))?.status).toBe("invalidated");
  });

  it("cancels a pending group and rejects later approval without changing terminal evidence", async () => {
    const runId = await createRun(`cancel-${randomUUID()}`);
    const created = await approvals.createGroup({
      organizationId,
      installationId,
      runId,
      batchId: `${runId}:batch:1`,
      turnKey: "model-turn:1",
      policyRevision: "v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      proposals: proposals(4, "cancel"),
    });
    await approvals.cancelGroup(organizationId, runId, created.group.id);
    expect((await approvals.getGroup(organizationId, created.group.id))?.status).toBe("cancelled");
    expect((await approvals.listGroupOperations(organizationId, created.group.id)).every((approval) => approval.status === "cancelled")).toBe(true);
    await expect(approvals.decideGroup({
      organizationId,
      runId,
      groupId: created.group.id,
      planDigest: created.group.plan_digest,
      decision: "approved",
      approvedBy: "operator-1",
    })).rejects.toThrow("APPROVAL_GROUP_NOT_PENDING");
    await approvals.cancelGroup(organizationId, runId, created.group.id);
    expect((await approvals.getGroup(organizationId, created.group.id))?.status).toBe("cancelled");
  });

  it("expires pending groups and every child operation exactly once", async () => {
    const runId = await createRun(`expire-sweep-${randomUUID()}`);
    const created = await approvals.createGroup({
      organizationId,
      installationId,
      runId,
      batchId: `${runId}:batch:1`,
      turnKey: "model-turn:1",
      policyRevision: "v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      proposals: proposals(4, "expire-sweep"),
    });
    await pool.query("UPDATE agent_approval_groups SET expires_at = now() - interval '1 second' WHERE id = $1", [created.group.id]);
    const expired = await approvals.expireGroups();
    expect(expired.map((group) => group.id)).toContain(created.group.id);
    expect((await approvals.getGroup(organizationId, created.group.id))?.status).toBe("expired");
    expect((await approvals.listGroupOperations(organizationId, created.group.id)).every((approval) => approval.status === "expired")).toBe(true);
    expect(await approvals.expireGroups()).toEqual([]);
  });
});
