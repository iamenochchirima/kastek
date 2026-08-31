import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunRepository } from "../src/db/repositories/run-repository";
import { RunStepRepository } from "../src/db/repositories/run-step-repository";
import { WorkflowStateRepository } from "../src/db/repositories/workflow-state-repository";
import { WorkflowCheckpointRepository } from "../src/db/repositories/workflow-checkpoint-repository";
import { ModelCallRepository } from "../src/db/repositories/model-call-repository";
import { ToolInvocationRepository } from "../src/db/repositories/tool-invocation-repository";
import { ApprovalRepository } from "../src/db/repositories/approval-repository";
import { EffectReceiptRepository } from "../src/db/repositories/effect-receipt-repository";
import { KillSwitchRepository } from "../src/db/repositories/kill-switch-repository";
import { createActivities } from "../src/temporal/activities";
import { ToolRegistry } from "../src/tools/registry";
import { RunBudgetRepository } from "../src/db/repositories/run-budget-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("durable run invariants (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const runs = new RunRepository(pool);
  const steps = new RunStepRepository(pool);
  const workflowState = new WorkflowStateRepository(pool);
  const workflowCheckpoints = new WorkflowCheckpointRepository(pool);
  const modelCalls = new ModelCallRepository(pool);
  const toolInvocations = new ToolInvocationRepository(pool);
  const approvals = new ApprovalRepository(pool);
  const effectReceipts = new EffectReceiptRepository(pool);
  const killSwitches = new KillSwitchRepository(pool);
  const runBudgets = new RunBudgetRepository(pool);
  const organizationId = `run-test-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  let runId = "";

  beforeAll(async () => {
    const setup = await pool.connect();
    try {
      await setup.query(
        "CREATE TEMP TABLE analytics_outbox (LIKE public.analytics_outbox INCLUDING DEFAULTS INCLUDING IDENTITY INCLUDING CONSTRAINTS INCLUDING INDEXES) ON COMMIT PRESERVE ROWS",
      );
      await setup.query(
        "CREATE TRIGGER analytics_outbox_updated_at_trigger BEFORE UPDATE ON analytics_outbox FOR EACH ROW EXECUTE FUNCTION analytics_outbox_set_updated_at()",
      );
      await setup.query(
        "CREATE TRIGGER analytics_outbox_content_trigger BEFORE UPDATE OR DELETE ON analytics_outbox FOR EACH ROW EXECUTE FUNCTION analytics_outbox_protect_content()",
      );
    } finally {
      setup.release();
    }
    await pool.query("INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1, $2, 'Run test', $3, 'test')", [agentId, organizationId, `run-${agentId}`]);
    await pool.query("INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status) VALUES ($1, $2, 1, 'test', 'test', 'test', 'published')", [versionId, agentId]);
    await pool.query("INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, settings, created_by) VALUES ($1, $2, $3, $4, 'organization', $4, 'kasitek_hosted', $5::jsonb, 'test')", [installationId, agentId, versionId, organizationId, JSON.stringify({ maxModelCalls: 1 })]);
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
    const checkpoint = await workflowCheckpoints.put({
      organizationId,
      runId,
      nodeId: "model",
      nextNodeId: "tool",
      status: "completed",
      state: { answer: "checkpointed" },
      output: { text: "checkpointed" },
      trace: [{ nodeId: "model", type: "model", status: "completed" }],
      usage: { modelCalls: 1, toolCalls: 0, inputTokens: 2, outputTokens: 3, totalTokens: 5, estimatedCostUsd: 0.001 },
      idempotencyKey: "workflow:model:1:completed",
    });
    const duplicateCheckpoint = await workflowCheckpoints.put({
      organizationId,
      runId,
      nodeId: "model",
      nextNodeId: "tool",
      status: "completed",
      state: { answer: "different retry" },
      trace: [],
      usage: { modelCalls: 99, toolCalls: 99, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      idempotencyKey: "workflow:model:1:completed",
    });
    expect(duplicateCheckpoint.id).toBe(checkpoint.id);
    expect((await workflowCheckpoints.getLatest(organizationId, runId))?.state).toEqual({ answer: "checkpointed" });
    const completedAnalyticsRun = await runs.createRun(organizationId, "test-user", {
      installationId,
      idempotencyKey: `analytics-completed-${randomUUID()}`,
      input: { message: "analytics completion fixture" },
      triggerType: "manual",
    });
    await runs.transitionRun(completedAnalyticsRun.id, "received", "queued");
    await runs.transitionRun(completedAnalyticsRun.id, "queued", "running");
    await runs.completeRun(completedAnalyticsRun.id, { message: "fixture response" });
    const completedAnalytics = await pool.query<{ envelope: { data: Record<string, unknown> }; source_stream_key: string; scope_kind: string; scope_external_id: string }>(
      `SELECT envelope, source_stream_key, scope_kind, scope_external_id
       FROM analytics_outbox
       WHERE record_id = $1`,
      [`run:${completedAnalyticsRun.id}:completed`],
    );
    expect(completedAnalytics.rows[0]).toMatchObject({
      source_stream_key: `organization:${organizationId}:agent-runs`,
      scope_kind: "core_organization",
      scope_external_id: organizationId,
      envelope: {
        data: {
          status: "completed",
          trigger_type: "manual",
          execution_mode: "kasitek_hosted",
          deployment_surface: "direct",
        },
      },
    });
    expect(JSON.stringify(completedAnalytics.rows[0]?.envelope)).not.toContain("hello");
    await modelCalls.recordCompleted({
      organizationId,
      runId: completedAnalyticsRun.id,
      provider: "openai",
      model: "gpt-test",
      fundingSource: "kasitek",
      credentialReference: "credential-should-not-be-exported",
      correlationId: "model-correlation-1",
      response: {
        provider: "openai",
        model: "gpt-test",
        message: { role: "assistant", content: "private response" },
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8, estimatedCostUsd: 0.0025 },
        latencyMs: 120,
      },
    });
    await modelCalls.recordFailed({
      organizationId,
      runId: completedAnalyticsRun.id,
      provider: "openai",
      model: "gpt-test",
      fundingSource: "kasitek",
      error: { code: "PROVIDER_RATE_LIMITED", message: "private provider detail" },
      correlationId: "model-correlation-2",
    });
    const modelAnalytics = await pool.query<{
      status: string;
      record_id: string;
      envelope: { type: string; correlation_id?: string; data: Record<string, unknown> };
    }>(
      `SELECT mc.status, ao.record_id, ao.envelope
       FROM model_calls mc
       JOIN analytics_outbox ao ON ao.record_id = 'model-call:' || mc.id || ':' || CASE WHEN mc.status = 'completed' THEN 'completed' ELSE 'failed' END
       WHERE mc.organization_id = $1 AND mc.run_id = $2
       ORDER BY mc.created_at`,
      [organizationId, completedAnalyticsRun.id],
    );
    expect(modelAnalytics.rows).toHaveLength(2);
    expect(modelAnalytics.rows[0]).toMatchObject({
      status: "completed",
      envelope: {
        type: "agent.model_call.completed@1",
        correlation_id: "model-correlation-1",
        data: {
          provider: "openai",
          model: "gpt-test",
          input_tokens: 3,
          output_tokens: 5,
          total_tokens: 8,
          status: "completed",
        },
      },
    });
    expect(modelAnalytics.rows[1]).toMatchObject({
      status: "failed",
      envelope: {
        type: "agent.model_call.failed@1",
        correlation_id: "model-correlation-2",
        data: {
          provider: "openai",
          model: "gpt-test",
          failure_class: "provider",
          status: "failed",
        },
      },
    });
    expect(await modelCalls.usageForRun(organizationId, completedAnalyticsRun.id)).toEqual({
      modelCalls: 1,
      inputTokens: 3,
      outputTokens: 5,
      totalTokens: 8,
      estimatedCostUsd: 0.0025,
    });
    expect(JSON.stringify(modelAnalytics.rows)).not.toContain("credential-should-not-be-exported");
    expect(JSON.stringify(modelAnalytics.rows)).not.toContain("private response");
    expect(JSON.stringify(modelAnalytics.rows)).not.toContain("private provider detail");
    const toolCallId = `analytics-tool-${randomUUID()}`;
    await toolInvocations.recordProposal({
      organizationId,
      runId: completedAnalyticsRun.id,
      providerToolCallId: toolCallId,
      sequenceNumber: 1,
      toolName: "analytics.read",
      toolVersion: "1.0.0",
      riskClass: "read",
      argumentsHash: "a".repeat(64),
      arguments: { private: "arguments must stay operational-only" },
      requiresApproval: false,
    });
    await toolInvocations.recordCompleted({
      runId: completedAnalyticsRun.id,
      providerToolCallId: toolCallId,
      output: { private: "tool output must stay operational-only" },
      latencyMs: 45,
    });
    const toolAnalytics = await pool.query<{ type: string; data: Record<string, unknown> }>(
      `SELECT envelope->>'type' AS type, envelope->'data' AS data
       FROM analytics_outbox
       WHERE envelope->'data'->>'run_id' = $1
         AND envelope->>'type' = 'agent.tool_invocation.lifecycle@1'
       ORDER BY envelope->'data'->>'occurred_at'`,
      [completedAnalyticsRun.id],
    );
    expect(toolAnalytics.rows.map((row) => row.data.action)).toEqual(["proposed", "completed"]);
    expect(toolAnalytics.rows[1]?.data).toMatchObject({
      tool_name: "analytics.read",
      status: "completed",
      latency_ms: 45,
    });
    expect(JSON.stringify(toolAnalytics.rows)).not.toContain("arguments must stay operational-only");
    expect(JSON.stringify(toolAnalytics.rows)).not.toContain("tool output must stay operational-only");
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
    const lifecycleFacts = await pool.query<{ type: string; action: string; data: Record<string, unknown> }>(
      `SELECT envelope->>'type' AS type, envelope->'data'->>'action' AS action, envelope->'data' AS data
       FROM analytics_outbox
       WHERE envelope->'data'->>'run_id' = $1
         AND envelope->>'type' IN ('agent.approval.lifecycle@1', 'agent.effect.lifecycle@1')
       ORDER BY envelope->'data'->>'occurred_at'`,
      [runId],
    );
    const approvalActions = lifecycleFacts.rows.filter((row) => row.type === "agent.approval.lifecycle@1").map((row) => row.action);
    expect(approvalActions).toEqual(expect.arrayContaining(["requested", "approved", "consumed", "expired", "denied"]));
    const effectActions = lifecycleFacts.rows.filter((row) => row.type === "agent.effect.lifecycle@1").map((row) => row.action);
    expect(effectActions).toEqual(expect.arrayContaining(["reserved", "executing", "unknown", "reconciled", "succeeded", "failed"]));
    expect(JSON.stringify(lifecycleFacts.rows)).not.toContain("provider-success-1");
    expect(JSON.stringify(lifecycleFacts.rows)).not.toContain("PROVIDER_OUTCOME_UNKNOWN");
  });

  it("reserves, settles, and atomically enforces model and tool budgets", async () => {
    await runBudgets.ensure({ organizationId, runId }, { maxModelCalls: 2, maxToolCalls: 1, maxTotalTokens: 100, maxEstimatedCostUsd: 1 });
    const captured = await runBudgets.reserveModelCall({ organizationId, runId, reservationKey: "budget:model:captured", estimatedTokens: 20, estimatedCostUsd: 0.1 });
    const released = await runBudgets.reserveModelCall({ organizationId, runId, reservationKey: "budget:model:released", estimatedTokens: 20, estimatedCostUsd: 0.1 });
    await released.release("provider failure");
    const replacement = await runBudgets.reserveModelCall({ organizationId, runId, reservationKey: "budget:model:replacement", estimatedTokens: 20, estimatedCostUsd: 0.1 });
    await captured.capture({ inputTokens: 8, outputTokens: 7, totalTokens: 15, estimatedCostUsd: 0.05 });
    await expect(runBudgets.reserveModelCall({ organizationId, runId, reservationKey: "budget:model:over-limit", estimatedTokens: 20, estimatedCostUsd: 0.1 })).rejects.toThrow("MODEL_REQUEST_BUDGET_EXCEEDED");
    await replacement.release("test cleanup");
    await runBudgets.consumeToolCall({ organizationId, runId });
    await expect(runBudgets.consumeToolCall({ organizationId, runId })).rejects.toThrow("TOOL_CALL_BUDGET_EXCEEDED");
  });

  it("claims model operations before provider work and replays completed outcomes", async () => {
    const operationKey = `model:durable:${randomUUID()}`;
    const modelResponse = {
      provider: "openai" as const,
      model: "gpt-test",
      message: { role: "assistant" as const, content: "durable response" },
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8, estimatedCostUsd: 0.0025 },
      latencyMs: 120,
    };
    await expect(modelCalls.prepare({ organizationId, runId, operationKey, provider: "openai", model: "gpt-test", fundingSource: "kasitek" })).resolves.toEqual({ status: "new" });
    await modelCalls.recordCompleted({ organizationId, runId, operationKey, provider: "openai", model: "gpt-test", fundingSource: "kasitek", response: modelResponse });
    await expect(modelCalls.prepare({ organizationId, runId, operationKey, provider: "openai", model: "gpt-test", fundingSource: "kasitek" })).resolves.toEqual({ status: "completed", response: modelResponse });

    const abandonedKey = `model:abandoned:${randomUUID()}`;
    await expect(modelCalls.prepare({ organizationId, runId, operationKey: abandonedKey, provider: "openai", model: "gpt-test", fundingSource: "kasitek" })).resolves.toEqual({ status: "new" });
    await expect(modelCalls.prepare({ organizationId, runId, operationKey: abandonedKey, provider: "openai", model: "gpt-test", fundingSource: "kasitek" })).resolves.toEqual({ status: "unknown" });
  });

  it("marks abandoned model reservations unknown and resolves provider outcomes explicitly", async () => {
    const reservation = await runBudgets.reserveModelCall({ organizationId, runId, reservationKey: "budget:model:unknown", estimatedTokens: 20, estimatedCostUsd: 0.1 });
    const [unknown] = await runBudgets.markStaleReservationsUnknown({ organizationId, runId, olderThanMs: 1, reason: "test timeout" });
    expect(unknown).toMatchObject({ reservationKey: "budget:model:unknown", runId, organizationId });
    await expect(runBudgets.reserveModelCall({ organizationId, runId, reservationKey: "budget:model:unknown", estimatedTokens: 20, estimatedCostUsd: 0.1 })).rejects.toThrow("MODEL_CALL_OUTCOME_UNKNOWN");
    await runBudgets.reconcileUnknownReservation({ organizationId, reservationId: unknown!.id, outcome: "captured", usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12, estimatedCostUsd: 0.04 } });
    await expect(runBudgets.reconcileUnknownReservation({ organizationId, reservationId: unknown!.id, outcome: "released" })).rejects.toThrow("NOT_PENDING_RECONCILIATION");
    await reservation.release("already reconciled");
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

    const failedRun = await runs.createRun(organizationId, "test-user", {
      installationId,
      idempotencyKey: `analytics-failed-${randomUUID()}`,
      input: { mcpTool: { name: "test.external" } },
      triggerType: "schedule",
    });
    await runs.transitionRun(failedRun.id, "received", "queued");
    await runs.transitionRun(failedRun.id, "queued", "running");
    await runs.failRun(failedRun.id, { code: "MODEL_TIMEOUT", message: "provider detail must stay operational-only" });
    const failedAnalytics = await pool.query<{ envelope: { data: Record<string, unknown> } }>(
      "SELECT envelope FROM analytics_outbox WHERE record_id = $1",
      [`run:${failedRun.id}:failed`],
    );
    expect(failedAnalytics.rows[0]?.envelope.data).toMatchObject({
      status: "failed",
      failure_class: "timeout",
      trigger_type: "schedule",
      deployment_surface: "external_operation",
    });
    expect(JSON.stringify(failedAnalytics.rows[0]?.envelope)).not.toContain("provider detail");
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
    await pool.query("TRUNCATE analytics_outbox");
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
