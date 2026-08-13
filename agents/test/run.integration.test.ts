import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunRepository } from "../src/db/repositories/run-repository";
import { RunStepRepository } from "../src/db/repositories/run-step-repository";
import { WorkflowStateRepository } from "../src/db/repositories/workflow-state-repository";
import { ModelCallRepository } from "../src/db/repositories/model-call-repository";
import { ApprovalRepository } from "../src/db/repositories/approval-repository";
import { EffectReceiptRepository } from "../src/db/repositories/effect-receipt-repository";
import { KillSwitchRepository } from "../src/db/repositories/kill-switch-repository";
import { createActivities } from "../src/temporal/activities";
import { ToolRegistry } from "../src/tools/registry";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("durable run invariants (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const runs = new RunRepository(pool);
  const steps = new RunStepRepository(pool);
  const workflowState = new WorkflowStateRepository(pool);
  const modelCalls = new ModelCallRepository(pool);
  const approvals = new ApprovalRepository(pool);
  const effectReceipts = new EffectReceiptRepository(pool);
  const killSwitches = new KillSwitchRepository(pool);
  const organizationId = `run-test-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  let runId = "";

  beforeAll(async () => {
    await pool.query("INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1, $2, 'Run test', $3, 'test')", [agentId, organizationId, `run-${agentId}`]);
    await pool.query("INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status) VALUES ($1, $2, 1, 'test', 'test', 'test', 'published')", [versionId, agentId]);
    await pool.query("INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, settings, created_by) VALUES ($1, $2, $3, $4, 'organization', $4, $5::jsonb, 'test')", [installationId, agentId, versionId, organizationId, JSON.stringify({ maxModelCalls: 1 })]);
  });

  it("deduplicates an idempotent start and persists ordered steps", async () => {
    const first = await runs.createRun(organizationId, "test-user", { installationId, idempotencyKey: "same-request", input: { message: "hello" }, triggerType: "manual" });
    runId = first.id;
    const second = await runs.createRun(organizationId, "test-user", { installationId, idempotencyKey: "same-request", input: { message: "different retry payload" }, triggerType: "manual" });
    expect(second.id).toBe(first.id);
    expect(first.created).toBe(true);
    expect((await runs.getRuntimeRun(organizationId, runId))?.installation_settings).toMatchObject({ maxModelCalls: 1 });
    expect(second.created).toBe(false);
    const context = await steps.startStep({ runId, organizationId, stepType: "context", input: { test: true } });
    const model = await steps.startStep({ runId, organizationId, stepType: "model" });
    expect(model.sequence_number).toBe(context.sequence_number + 1);
    await steps.finishStep({ stepId: context.id, status: "completed", output: { ok: true } });
    expect((await steps.listSteps(organizationId, runId)).map((step) => step.status)).toEqual(["completed", "started"]);
    const initialState = await workflowState.get(organizationId, runId);
    expect(initialState).toMatchObject({ revision: 0, state: {} });
    const updatedState = await workflowState.put({ organizationId, runId, expectedRevision: 0, state: { node: "model", attempt: 1 } });
    expect(updatedState).toMatchObject({ revision: 1, state: { node: "model", attempt: 1 } });
    await expect(workflowState.put({ organizationId, runId, expectedRevision: 0, state: { node: "stale" } })).rejects.toThrow("revision conflict");
    await pool.query("INSERT INTO model_calls (organization_id, run_id, provider, model, funding_source, total_tokens, estimated_cost_usd, status) VALUES ($1, $2, 'openai', 'test', 'kasitek', 10, 0.25, 'completed')", [organizationId, runId]);
    await expect(modelCalls.assertRunBudget({ organizationId, runId, maxRequests: 1 })).rejects.toThrow("REQUEST_BUDGET");
    const decisionCallId = "idempotent-decision-call";
    const decisionHash = "c".repeat(64);
    await approvals.createPending({
      organizationId,
      installationId,
      runId,
      providerToolCallId: decisionCallId,
      capability: "test.publish",
      capabilityVersion: "1.0.0",
      argumentsHash: decisionHash,
      resourceSnapshot: {},
      previewRevision: decisionHash,
      policyRevision: "v1",
      permittedEffectKey: `${runId}:${decisionCallId}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const decisions = await Promise.all([
      approvals.decide({ organizationId, runId, providerToolCallId: decisionCallId, argumentsHash: decisionHash, decision: "approved", approvedBy: "user-1" }),
      approvals.decide({ organizationId, runId, providerToolCallId: decisionCallId, argumentsHash: decisionHash, decision: "approved", approvedBy: "user-1" }),
    ]);
    expect(decisions.filter((entry) => entry.accepted)).toHaveLength(1);
    expect(decisions.filter((entry) => !entry.accepted)).toHaveLength(1);
    expect(decisions.map((entry) => entry.approval.status)).toEqual(["approved", "approved"]);

    const effectCallId = "atomic-effect-call";
    const effectHash = "d".repeat(64);
    const effectKey = `${runId}:test.publish:${effectHash}`;
    await effectReceipts.reserve({
      organizationId,
      installationId,
      runId,
      providerToolCallId: effectCallId,
      capability: "test.publish",
      capabilityVersion: "1.0.0",
      argumentsHash: effectHash,
      idempotencyKey: effectKey,
    });
    await approvals.createPending({
      organizationId,
      installationId,
      runId,
      providerToolCallId: effectCallId,
      capability: "test.publish",
      capabilityVersion: "1.0.0",
      argumentsHash: effectHash,
      resourceSnapshot: {},
      previewRevision: effectHash,
      policyRevision: "v1",
      permittedEffectKey: `${runId}:${effectCallId}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await approvals.decide({ organizationId, runId, providerToolCallId: effectCallId, argumentsHash: effectHash, decision: "approved", approvedBy: "user-1" });
    await expect(approvals.consumeAndStartEffect({
      organizationId,
      installationId,
      runId,
      providerToolCallId: effectCallId,
      capability: "test.publish",
      capabilityVersion: "1.0.0",
      argumentsHash: effectHash,
      resourceSnapshot: { changed: true },
      previewRevision: "mutated-preview",
      policyRevision: "v2",
      permittedEffectKey: `${runId}:${effectCallId}`,
      effectIdempotencyKey: effectKey,
    })).rejects.toThrow("Approval is missing");
    await expect(approvals.consumeAndStartEffect({
      organizationId,
      installationId,
      runId,
      providerToolCallId: effectCallId,
      capability: "test.publish",
      capabilityVersion: "1.0.0",
      argumentsHash: effectHash,
      resourceSnapshot: {},
      previewRevision: effectHash,
      policyRevision: "v1",
      permittedEffectKey: `${runId}:${effectCallId}`,
      effectIdempotencyKey: "wrong-effect-key",
    })).rejects.toThrow("Effect receipt");
    const beforeCorrectTransition = await pool.query<{ status: string }>("SELECT status FROM agent_approval_records WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3", [organizationId, runId, effectCallId]);
    expect(beforeCorrectTransition.rows[0]?.status).toBe("approved");
    await approvals.consumeAndStartEffect({
      organizationId,
      installationId,
      runId,
      providerToolCallId: effectCallId,
      capability: "test.publish",
      capabilityVersion: "1.0.0",
      argumentsHash: effectHash,
      resourceSnapshot: {},
      previewRevision: effectHash,
      policyRevision: "v1",
      permittedEffectKey: `${runId}:${effectCallId}`,
      effectIdempotencyKey: effectKey,
    });
    expect((await pool.query<{ status: string }>("SELECT status FROM agent_approval_records WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3", [organizationId, runId, effectCallId])).rows[0]?.status).toBe("consumed");
    const executingEffect = (await effectReceipts.listForRun(organizationId, runId)).find((entry) => entry.provider_tool_call_id === effectCallId);
    expect(executingEffect).toMatchObject({ status: "executing" });
    await effectReceipts.markUnknownByKey(organizationId, effectKey, { code: "PROVIDER_OUTCOME_UNKNOWN" });
    expect((await effectReceipts.listForRun(organizationId, runId)).find((entry) => entry.id === executingEffect?.id)).toMatchObject({ status: "unknown", reconciliation_required: true });
    await effectReceipts.reconcile({ organizationId, effectId: executingEffect!.id, outcome: "succeeded", providerReceipt: { providerId: "test-receipt" } });
    expect((await effectReceipts.listForRun(organizationId, runId)).find((entry) => entry.id === executingEffect?.id)).toMatchObject({ status: "succeeded", reconciliation_required: false });
    await expect(effectReceipts.reconcile({ organizationId, effectId: executingEffect!.id, outcome: "succeeded" })).rejects.toThrow("Effect is not pending reconciliation");
    await expect(effectReceipts.markExecutingByKey(organizationId, effectKey)).rejects.toThrow("blind retry is prohibited");

    const expiringCallId = "expiring-call";
    const expiringHash = "b".repeat(64);
    const effect = await effectReceipts.reserve({
      organizationId,
      installationId,
      runId,
      providerToolCallId: expiringCallId,
      capability: "test.publish",
      capabilityVersion: "1.0.0",
      argumentsHash: expiringHash,
      idempotencyKey: `${runId}:test.publish:${expiringHash}`,
    });
    await pool.query(
      `INSERT INTO agent_approval_records
       (organization_id, installation_id, run_id, provider_tool_call_id, capability,
        capability_version, arguments_hash, resource_snapshot, preview_revision,
        policy_revision, permitted_effect_key, status, expires_at)
       VALUES ($1,$2,$3,$4,'test.publish','1.0.0',$5,'{}'::jsonb,$5,'v1',$6,'pending',now() - interval '1 minute')`,
      [organizationId, installationId, runId, expiringCallId, expiringHash, `${runId}:${expiringCallId}`],
    );
    const expired = await approvals.expirePending();
    expect(expired).toEqual([expect.objectContaining({ run_id: runId, provider_tool_call_id: expiringCallId })]);
    await effectReceipts.markNotExecuted(organizationId, runId, expiringCallId, { code: "APPROVAL_EXPIRED" });
    expect((await effectReceipts.listForRun(organizationId, runId)).find((entry) => entry.id === effect.id)).toMatchObject({ status: "failed", reconciliation_required: false });

    const waitingCallId = "long-wait-call";
    const waitingHash = "e".repeat(64);
    const waiting = await effectReceipts.reserve({
      organizationId,
      installationId,
      runId,
      providerToolCallId: waitingCallId,
      capability: "test.publish",
      capabilityVersion: "1.0.0",
      argumentsHash: waitingHash,
      idempotencyKey: `${runId}:test.publish:${waitingHash}`,
    });
    await pool.query("UPDATE agent_effect_receipts SET updated_at = now() - interval '10 minutes' WHERE id = $1", [waiting.id]);
    expect(await effectReceipts.markStaleExecutingUnknown(1)).not.toContainEqual(expect.objectContaining({ id: waiting.id }));
    expect((await effectReceipts.listForRun(organizationId, runId)).find((entry) => entry.id === waiting.id)).toMatchObject({
      status: "reserved",
      reconciliation_required: false,
    });
    await approvals.createPending({
      organizationId,
      installationId,
      runId,
      providerToolCallId: waitingCallId,
      capability: "test.publish",
      capabilityVersion: "1.0.0",
      argumentsHash: waitingHash,
      resourceSnapshot: {},
      previewRevision: waitingHash,
      policyRevision: "v1",
      permittedEffectKey: `${runId}:${waitingCallId}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await approvals.decide({ organizationId, runId, providerToolCallId: waitingCallId, argumentsHash: waitingHash, decision: "rejected", approvedBy: "user-1" });
    await effectReceipts.markNotExecuted(organizationId, runId, waitingCallId, { code: "APPROVAL_DENIED" });
    expect((await effectReceipts.listForRun(organizationId, runId)).find((entry) => entry.id === waiting.id)).toMatchObject({
      status: "failed",
      reconciliation_required: false,
    });

    const successfulCallId = "provider-success-call";
    const successfulHash = "f".repeat(64);
    const successful = await effectReceipts.reserve({
      organizationId,
      installationId,
      runId,
      providerToolCallId: successfulCallId,
      capability: "test.publish",
      capabilityVersion: "1.0.0",
      argumentsHash: successfulHash,
      idempotencyKey: `${runId}:test.publish:${successfulHash}`,
    });
    await effectReceipts.markExecuting(successful.id);
    await effectReceipts.markSucceeded(successful.id, { providerReceiptId: "provider-success-1" });
    expect((await effectReceipts.listForRun(organizationId, runId)).find((entry) => entry.id === successful.id)).toMatchObject({
      status: "succeeded",
      reconciliation_required: false,
      provider_receipt: { providerReceiptId: "provider-success-1" },
    });
  });

  it("re-authorizes approved external effects and records post-start failures as unknown", async () => {
    const tools = new ToolRegistry();
    let providerCalls = 0;
    tools.register({
      name: "test.external_effect",
      version: "1.0.0",
      description: "Controlled external-effect integration fixture.",
      riskClass: "external-effect",
      requiresApproval: true,
      timeoutMs: 1_000,
      inputSchema: {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", required: ["ok"], additionalProperties: false },
      handler: async () => {
        providerCalls += 1;
        throw new Error("provider connection dropped after dispatch");
      },
    });
    await pool.query(
      `INSERT INTO agent_tool_grants (organization_id, agent_version_id, tool_name, granted_by)
       VALUES ($1, $2, 'test.external_effect', 'test')`,
      [organizationId, versionId],
    );
    const activities = createActivities(pool, { tools });
    const argumentsValue = { target: "first" };
    const firstRun = await runs.createRun(organizationId, "test-user", {
      installationId,
      triggerType: "manual",
      idempotencyKey: "effect-post-start-failure",
      input: { mcpTool: { name: "test.external_effect", arguments: argumentsValue, toolCallId: "effect-post-start-failure-call" } },
    });
    const proposed = await activities.executeLoop({ runId: firstRun.id });
    expect(proposed.status).toBe("awaiting_approval");
    const argumentsHash = proposed.pendingToolCalls![0]!.argumentsHash;
    await approvals.decide({
      organizationId,
      runId: firstRun.id,
      providerToolCallId: "effect-post-start-failure-call",
      argumentsHash,
      decision: "approved",
      approvedBy: "approver",
    });
    const result = await activities.executeLoop({
      runId: firstRun.id,
      resumeApprovedToolCall: {
        id: "effect-post-start-failure-call",
        name: "test.external_effect",
        arguments: argumentsValue,
        approval: { approvedBy: "approver", argumentsHash, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      },
    });
    expect(result.status).toBe("failed");
    expect((await effectReceipts.listForRun(organizationId, firstRun.id))[0]).toMatchObject({
      status: "unknown",
      reconciliation_required: true,
    });
    expect(providerCalls).toBe(1);
    const duplicateResume = await activities.executeLoop({
      runId: firstRun.id,
      resumeApprovedToolCall: {
        id: "effect-post-start-failure-call",
        name: "test.external_effect",
        arguments: argumentsValue,
        approval: { approvedBy: "approver", argumentsHash, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      },
    });
    expect(duplicateResume.status).toBe("failed");
    expect(providerCalls).toBe(1);

    const revokedArguments = { target: "revoked" };
    const revokedRun = await runs.createRun(organizationId, "test-user", {
      installationId,
      triggerType: "manual",
      idempotencyKey: "effect-grant-revoked",
      input: { mcpTool: { name: "test.external_effect", arguments: revokedArguments, toolCallId: "effect-grant-revoked-call" } },
    });
    const revokedProposed = await activities.executeLoop({ runId: revokedRun.id });
    const revokedHash = revokedProposed.pendingToolCalls![0]!.argumentsHash;
    await approvals.decide({
      organizationId,
      runId: revokedRun.id,
      providerToolCallId: "effect-grant-revoked-call",
      argumentsHash: revokedHash,
      decision: "approved",
      approvedBy: "approver",
    });
    await pool.query(
      `UPDATE agent_tool_grants SET revoked_at = now()
       WHERE organization_id = $1 AND agent_version_id = $2 AND tool_name = 'test.external_effect'`,
      [organizationId, versionId],
    );
    const revokedResult = await activities.executeLoop({
      runId: revokedRun.id,
      resumeApprovedToolCall: {
        id: "effect-grant-revoked-call",
        name: "test.external_effect",
        arguments: revokedArguments,
        approval: { approvedBy: "approver", argumentsHash: revokedHash, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      },
    });
    expect(revokedResult.status).toBe("failed");
    expect((await effectReceipts.listForRun(organizationId, revokedRun.id))[0]).toMatchObject({
      status: "failed",
      reconciliation_required: false,
    });
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM agent_approval_records WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3",
      [organizationId, revokedRun.id, "effect-grant-revoked-call"],
    )).rows[0]?.status).toBe("approved");
    expect(providerCalls).toBe(1);

    await pool.query(
      `UPDATE agent_tool_grants SET revoked_at = NULL
       WHERE organization_id = $1 AND agent_version_id = $2 AND tool_name = 'test.external_effect'`,
      [organizationId, versionId],
    );
    const blockedArguments = { target: "blocked" };
    const blockedRun = await runs.createRun(organizationId, "test-user", {
      installationId,
      triggerType: "manual",
      idempotencyKey: "effect-kill-switch",
      input: { mcpTool: { name: "test.external_effect", arguments: blockedArguments, toolCallId: "effect-kill-switch-call" } },
    });
    const blockedProposed = await activities.executeLoop({ runId: blockedRun.id });
    const blockedHash = blockedProposed.pendingToolCalls![0]!.argumentsHash;
    await approvals.decide({
      organizationId,
      runId: blockedRun.id,
      providerToolCallId: "effect-kill-switch-call",
      argumentsHash: blockedHash,
      decision: "approved",
      approvedBy: "approver",
    });
    const killSwitch = await killSwitches.set({
      organizationId,
      scopeType: "installation",
      scopeId: installationId,
      reason: "test post-approval block",
      actorId: "test",
    });
    const blockedResult = await activities.executeLoop({
      runId: blockedRun.id,
      resumeApprovedToolCall: {
        id: "effect-kill-switch-call",
        name: "test.external_effect",
        arguments: blockedArguments,
        approval: { approvedBy: "approver", argumentsHash: blockedHash, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      },
    });
    expect(blockedResult.status).toBe("failed");
    expect((await effectReceipts.listForRun(organizationId, blockedRun.id))[0]).toMatchObject({
      status: "failed",
      reconciliation_required: false,
    });
    expect(providerCalls).toBe(1);
    await killSwitches.disable(organizationId, killSwitch.id);

    const suspendedArguments = { target: "suspended" };
    const suspendedRun = await runs.createRun(organizationId, "test-user", {
      installationId,
      triggerType: "manual",
      idempotencyKey: "effect-installation-suspended",
      input: { mcpTool: { name: "test.external_effect", arguments: suspendedArguments, toolCallId: "effect-installation-suspended-call" } },
    });
    const suspendedProposed = await activities.executeLoop({ runId: suspendedRun.id });
    const suspendedHash = suspendedProposed.pendingToolCalls![0]!.argumentsHash;
    await approvals.decide({
      organizationId,
      runId: suspendedRun.id,
      providerToolCallId: "effect-installation-suspended-call",
      argumentsHash: suspendedHash,
      decision: "approved",
      approvedBy: "approver",
    });
    await pool.query("UPDATE agent_installations SET status = 'disabled' WHERE id = $1", [installationId]);
    const suspendedResult = await activities.executeLoop({
      runId: suspendedRun.id,
      resumeApprovedToolCall: {
        id: "effect-installation-suspended-call",
        name: "test.external_effect",
        arguments: suspendedArguments,
        approval: { approvedBy: "approver", argumentsHash: suspendedHash, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      },
    });
    expect(suspendedResult.status).toBe("failed");
    expect((await effectReceipts.listForRun(organizationId, suspendedRun.id))[0]).toMatchObject({
      status: "failed",
      reconciliation_required: false,
    });
    expect(providerCalls).toBe(1);
    await pool.query("UPDATE agent_installations SET status = 'active' WHERE id = $1", [installationId]);
  });

  it("binds approval consumption to every persisted identity and proposal field", async () => {
    const isolatedRun = await runs.createRun(organizationId, "test-user", { installationId, idempotencyKey: `approval-binding-${randomUUID()}`, input: { message: "approval binding" }, triggerType: "manual" });
    const bindingRunId = isolatedRun.id;
    const providerToolCallId = `binding-call-${randomUUID()}`;
    const argumentsHash = "a".repeat(64);
    const base = {
      organizationId,
      installationId,
      runId: bindingRunId,
      providerToolCallId,
      capability: "test.publish",
      capabilityVersion: "1.0.0",
      argumentsHash,
      resourceSnapshot: { resourceId: "resource-1" },
      previewRevision: "preview-1",
      policyRevision: "policy-1",
      permittedEffectKey: `${bindingRunId}:${providerToolCallId}`,
    };
    await approvals.createPending({ ...base, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await approvals.decide({ organizationId, runId: bindingRunId, providerToolCallId, argumentsHash, decision: "approved", approvedBy: "user-1" });
    const mismatches = [
      { organizationId: "other-org" },
      { installationId: randomUUID() },
      { runId: randomUUID() },
      { providerToolCallId: "wrong-call" },
      { argumentsHash: "b".repeat(64) },
      { capability: "test.other" },
      { capabilityVersion: "2.0.0" },
      { resourceSnapshot: { resourceId: "resource-2" } },
      { previewRevision: "preview-2" },
      { policyRevision: "policy-2" },
      { permittedEffectKey: `${bindingRunId}:wrong-effect` },
    ];
    for (const mismatch of mismatches) {
      await expect(approvals.consume({ ...base, ...mismatch })).rejects.toThrow("Approval is missing, expired, changed, or already consumed");
    }
    await approvals.consume(base);
    expect((await approvals.getForRun(organizationId, bindingRunId))?.status).toBe("consumed");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM run_steps WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_workflow_state WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM model_calls WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM tool_invocations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_approval_records WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_effect_receipts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_attempts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_events WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_kill_switches WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_tool_grants WHERE agent_version_id = $1", [versionId]);
    await pool.query("DELETE FROM agent_versions WHERE agent_definition_id = $1", [agentId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
