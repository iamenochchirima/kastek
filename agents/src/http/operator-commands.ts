import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { query, withTransaction } from "../db/pool";
import { EffectReceiptRepository } from "../db/repositories/effect-receipt-repository";
import { RunBudgetRepository } from "../db/repositories/run-budget-repository";
import { KillSwitchRepository } from "../db/repositories/kill-switch-repository";
import { RunRepository } from "../db/repositories/run-repository";
import { AgentRepository } from "../db/repositories/agent-repository";
import { InstallationCredentialRepository } from "../db/repositories/installation-credential-repository";
import { ScheduleRepository } from "../db/repositories/schedule-repository";
import { ChannelRepository } from "../db/repositories/channel-repository";
import { OperatorControlRepository, type OperatorFlagKey, type OperatorFlagScope, type OperatorHoldScope, type OperatorHoldType } from "../db/repositories/operator-control-repository";
import { RetentionRepository } from "../db/repositories/retention-repository";
import { AudioTranscriptionJobRepository } from "../db/repositories/audio-transcription-job-repository";
import { KasitekCoreReadClient } from "../core/client";
import { MemoryDeletionJobRepository } from "../db/repositories/memory-deletion-job-repository";
import { MemoryRetentionRepository } from "../db/repositories/memory-retention-repository";
import { MemoryRevisionCommandService } from "../memory/revision-command-service";

export const operatorCommandInputSchema = z.object({
  commandType: z.enum(["cancel_run", "retry_run", "retry_audio_transcription", "delete_audio_transcription", "replay_delivery", "delete_memory", "review_memory", "assign_run", "reconcile_effect", "reconcile_budget", "request_export", "set_feature_flag", "clear_feature_flag", "create_hold", "release_hold", "set_retention_policy", "apply_retention_policy", "create_legal_hold", "release_legal_hold", "kill_switch_enable", "kill_switch_disable", "suspend_installation", "resume_installation", "revoke_credential", "pause_schedule", "resume_schedule"]),
  targetId: z.string().trim().min(1).max(240),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict();

export type OperatorCommandInput = z.infer<typeof operatorCommandInputSchema>;

export interface OperatorCommandRecord {
  id: string;
  command_type: OperatorCommandInput["commandType"];
  target_id: string;
  actor_id: string;
  organization_id: string | null;
  payload: Record<string, unknown>;
  status: "awaiting_approval" | "executing" | "completed" | "failed";
  required_approvals: number;
  approvers: string[];
  idempotency_key: string;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface OperatorCommandDependencies {
  pool: Pool;
  runs: RunRepository;
  effectReceipts: EffectReceiptRepository;
  killSwitches: KillSwitchRepository;
  agents?: AgentRepository;
  installationCredentials?: InstallationCredentialRepository;
  schedules?: ScheduleRepository;
  channels?: ChannelRepository;
  memoryDeletionJobs?: MemoryDeletionJobRepository;
  memoryRetention?: MemoryRetentionRepository;
  memoryRevisionCommands?: MemoryRevisionCommandService;
  runBudgets?: RunBudgetRepository;
  controls?: OperatorControlRepository;
  retention?: RetentionRepository;
  audioTranscriptionJobs?: AudioTranscriptionJobRepository;
  coreClient?: KasitekCoreReadClient;
  startWorkflow?: (runId: string) => Promise<void>;
  signalCancellation?: (runId: string, signal: { reason?: string }) => Promise<void>;
}

interface CanonicalMemoryTarget {
  organization_id: string;
  workspace_id: string;
  agent_definition_id: string;
  installation_id: string;
  agent_version_id: string | null;
  conversation_id: string | null;
  end_user_id: string | null;
  namespace: string;
  memory_type: string;
  fact_id: string;
  revision_id: string;
  lifecycle_state: string;
  canonical_text: string;
  revision_number: number;
}

async function findCanonicalMemoryTarget(pool: Pool, targetId: string, preference: "active" | "review" = "active"): Promise<CanonicalMemoryTarget | null> {
  const result = await query<CanonicalMemoryTarget>(
    pool,
    `SELECT fact.organization_id, fact.workspace_id, fact.agent_definition_id,
            fact.installation_id, fact.agent_version_id, fact.conversation_id,
            fact.end_user_id, fact.namespace, fact.memory_type,
            fact.id::text AS fact_id, revision.id::text AS revision_id,
            revision.lifecycle_state, revision.canonical_text, revision.revision_number
     FROM agent_memory_facts fact
     JOIN agent_memory_revisions revision ON revision.fact_id = fact.id
     WHERE fact.id::text = $1 OR revision.id::text = $1
     ORDER BY
       CASE WHEN revision.id::text = $1 THEN 0 ELSE 1 END,
       CASE WHEN $2 = 'review' THEN CASE revision.lifecycle_state
         WHEN 'review_pending' THEN 0
         WHEN 'quarantined' THEN 1
         WHEN 'active' THEN 2
         ELSE 3
       END ELSE CASE revision.lifecycle_state
         WHEN 'active' THEN 0
         WHEN 'review_pending' THEN 1
         WHEN 'quarantined' THEN 2
         ELSE 3
       END END,
       revision.revision_number DESC
       LIMIT 1`,
    [targetId, preference],
  );
  return result.rows[0] ?? null;
}

export function publicOperatorCommand(command: OperatorCommandRecord): Record<string, unknown> {
  return {
    id: command.id,
    commandType: command.command_type,
    targetId: command.target_id,
    actorId: command.actor_id,
    organizationId: command.organization_id,
    status: command.status,
    requiredApprovals: command.required_approvals,
    approvers: command.approvers,
    idempotencyKey: command.idempotency_key,
    result: command.result ? {
      status: command.result.status,
      effectId: command.result.effectId,
      runId: command.result.runId,
      sourceRunId: command.result.sourceRunId,
      switchId: command.result.switchId,
      installationId: command.result.installationId,
      credentialId: command.result.credentialId,
      scheduleId: command.result.scheduleId,
      deliveryAttemptId: command.result.deliveryAttemptId,
      originalDeliveryAttemptId: command.result.originalDeliveryAttemptId,
      memoryId: command.result.memoryId,
      factId: command.result.factId,
      revisionId: command.result.revisionId,
      deletionJobId: command.result.deletionJobId,
      replayed: command.result.replayed,
      reservationId: command.result.reservationId,
      assignmentId: command.result.assignmentId,
      assigneeId: command.result.assigneeId,
      exportRequestId: command.result.exportRequestId,
      scopeType: command.result.scopeType,
      scopeId: command.result.scopeId,
      featureFlagId: command.result.featureFlagId,
      holdId: command.result.holdId,
      retentionPolicyId: command.result.retentionPolicyId,
      workspacesQueued: command.result.workspacesQueued,
      legalHoldId: command.result.legalHoldId,
      audioTranscriptionJobId: command.result.audioTranscriptionJobId,
      expired: command.result.expired,
      audioDeleted: command.result.audioDeleted,
      audioFailed: command.result.audioFailed,
    } : null,
    error: command.error ? { code: command.error.code, message: command.error.message } : null,
    createdAt: command.created_at,
    updatedAt: command.updated_at,
    completedAt: command.completed_at,
  };
}

export function requiredApprovals(commandType: OperatorCommandInput["commandType"]): number {
  return commandType === "cancel_run" ? 1 : 2;
}

function requireIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? "";
  if (key.length < 8 || key.length > 240) {
    throw Object.assign(new Error("idempotency-key must be 8-240 characters"), { statusCode: 400 });
  }
  return key;
}

function expectedStatus(command: OperatorCommandRecord): string | undefined {
  const value = command.payload.expectedStatus;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 80) {
    throw Object.assign(new Error("expectedStatus must be a non-empty string of at most 80 characters"), { statusCode: 400 });
  }
  return value.trim();
}

function assertExpectedStatus(command: OperatorCommandRecord, actual: string): void {
  const expected = expectedStatus(command);
  if (expected && expected !== actual) {
    throw Object.assign(new Error(`Target state changed from expected ${expected} to ${actual}`), { statusCode: 409 });
  }
}

function expectedResource(command: OperatorCommandRecord, key: string): string | undefined {
  const value = command.payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 240) {
    throw Object.assign(new Error(`${key} must be a non-empty string of at most 240 characters`), { statusCode: 400 });
  }
  return value.trim();
}

function assertExpectedResource(command: OperatorCommandRecord, key: string, actual: string | null | undefined, label: string): void {
  const expected = expectedResource(command, key);
  if (expected && expected !== actual) {
    throw Object.assign(new Error(`${label} changed from expected ${expected} to ${actual ?? "none"}`), { statusCode: 409 });
  }
}

function boundedExpiry(command: OperatorCommandRecord, maximumDays: number): string {
  const value = command.payload.expiresAt;
  if (typeof value !== "string" || !value.trim()) throw Object.assign(new Error("expiresAt is required"), { statusCode: 400 });
  const expiresAt = new Date(value);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + maximumDays * 24 * 60 * 60 * 1000) {
    throw Object.assign(new Error(`expiresAt must be in the future and no more than ${maximumDays} days away`), { statusCode: 400 });
  }
  return expiresAt.toISOString();
}

function retentionDays(command: OperatorCommandRecord, key: string, minimum: number, maximum: number): number {
  const value = command.payload[key];
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw Object.assign(new Error(`${key} must be an integer between ${minimum} and ${maximum}`), { statusCode: 400 });
  }
  return Number(value);
}

function operatorFlagKey(command: OperatorCommandRecord): OperatorFlagKey {
  const value = command.payload.flagKey;
  if (value !== "agent_execution_enabled" && value !== "agent_version_deployment_enabled" && value !== "effect_execution_enabled" && value !== "mcp_enabled" && value !== "rest_enabled" && value !== "customer_handoff_enabled" && value !== "audio_transcription_enabled" && value !== "dynamic_ui_enabled" && value !== "memory_v2_retrieval_enabled" && value !== "memory_v2_writes_enabled" && value !== "memory_consolidation_enabled" && value !== "memory_projection_enabled") {
    throw Object.assign(new Error("Unsupported feature flag"), { statusCode: 400 });
  }
  return value;
}

function operatorFlagScope(command: OperatorCommandRecord): { scopeType: OperatorFlagScope; scopeId: string; organizationId?: string } {
  const scopeType = command.payload.scopeType;
  const scopeId = typeof command.payload.scopeId === "string" ? command.payload.scopeId.trim() : "";
  const organizationId = typeof command.payload.organizationId === "string" ? command.payload.organizationId.trim() : undefined;
  if (scopeType !== "global" && scopeType !== "organization" && scopeType !== "installation") throw Object.assign(new Error("scopeType must be global, organization, or installation"), { statusCode: 400 });
  if (!scopeId || scopeId.length > 240) throw Object.assign(new Error("scopeId is required"), { statusCode: 400 });
  if (scopeType === "global" && scopeId !== "global") throw Object.assign(new Error("Global feature flags use scopeId global"), { statusCode: 400 });
  if (scopeType !== "global" && !organizationId) throw Object.assign(new Error("organizationId is required for scoped feature flags"), { statusCode: 400 });
  if (scopeType === "organization" && scopeId !== organizationId) throw Object.assign(new Error("Organization feature flag scope must match organizationId"), { statusCode: 400 });
  return { scopeType, scopeId, organizationId };
}

function operatorHoldScope(command: OperatorCommandRecord): { scopeType: OperatorHoldScope; scopeId: string } {
  const scopeType = command.payload.scopeType;
  const scopeId = typeof command.payload.scopeId === "string" ? command.payload.scopeId.trim() : "";
  if (scopeType !== "organization" && scopeType !== "installation" && scopeType !== "run") throw Object.assign(new Error("scopeType must be organization, installation, or run"), { statusCode: 400 });
  if (!scopeId || scopeId.length > 240 || (scopeType !== "organization" && scopeId !== command.target_id)) throw Object.assign(new Error("Hold scopeId must match targetId for resource-scoped holds"), { statusCode: 400 });
  return { scopeType, scopeId };
}

async function auditCommand(pool: Pool, input: { organizationId?: string | null; actorId: string; action: string; commandId: string; metadata?: Record<string, unknown> }): Promise<void> {
  await pool.query(
    `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     VALUES ($1, 'platform_admin', $2, $3, 'operator_command', $4, $5::jsonb)`,
    [input.organizationId ?? null, input.actorId, input.action, input.commandId, JSON.stringify(input.metadata ?? {})],
  );
}

async function applyAudioRetention(
  organizationId: string,
  actorId: string,
  dependencies: OperatorCommandDependencies,
): Promise<{ deleted: number; failed: number }> {
  if (!dependencies.audioTranscriptionJobs || !dependencies.retention || !dependencies.coreClient) {
    return { deleted: 0, failed: 0 };
  }
  const policy = await dependencies.retention.getPolicy(organizationId);
  const candidates = await dependencies.audioTranscriptionJobs.listRetentionCandidates(
    organizationId,
    policy.attachment_days,
  );
  let deleted = 0;
  let failed = 0;
  for (const job of candidates) {
    try {
      await dependencies.coreClient.deleteContentMedia({
        organizationId: job.organization_id,
        installationId: job.installation_id,
        actorId,
        runId: job.result_run_id ?? job.id,
        correlationId: job.correlation_id,
      }, job.asset_id);
      const marked = await dependencies.audioTranscriptionJobs.markDeleted(job.id, actorId);
      if (marked) deleted += 1;
    } catch {
      failed += 1;
    }
  }
  return { deleted, failed };
}

async function executeCommand(command: OperatorCommandRecord, actorId: string, dependencies: OperatorCommandDependencies): Promise<Record<string, unknown>> {
  if (command.command_type === "cancel_run") {
    const run = await dependencies.runs.getRunById(command.target_id);
    if (!run) throw Object.assign(new Error("Run not found"), { statusCode: 404 });
    assertExpectedResource(command, "expectedOrganizationId", run.organization_id, "Run organization");
    assertExpectedResource(command, "expectedInstallationId", run.installation_id, "Run installation");
    assertExpectedResource(command, "expectedConversationId", run.conversation_id, "Run conversation");
    assertExpectedStatus(command, run.status);
    if (["completed", "failed", "cancelled", "expired"].includes(run.status)) return { status: run.status, runId: run.id };
    if (!dependencies.signalCancellation) throw new Error("Temporal cancellation is unavailable");
    const reason = typeof command.payload.reason === "string" ? command.payload.reason.trim().slice(0, 500) : "cancelled by platform operator";
    await dependencies.signalCancellation(run.id, { reason: `${actorId}: ${reason}` });
    await auditCommand(dependencies.pool, { organizationId: run.organization_id, actorId, action: "operator_command.run_cancelled", commandId: command.id, metadata: { runId: run.id } });
    return { status: "cancellation_signalled", runId: run.id };
  }

  if (command.command_type === "reconcile_effect") {
    const effect = (await query<{ organization_id: string; installation_id: string; run_id: string; status: string }>(dependencies.pool, "SELECT organization_id, installation_id, run_id, status FROM agent_effect_receipts WHERE id = $1", [command.target_id])).rows[0];
    if (!effect) throw Object.assign(new Error("Effect receipt not found"), { statusCode: 404 });
    assertExpectedResource(command, "expectedOrganizationId", effect.organization_id, "Effect organization");
    assertExpectedResource(command, "expectedInstallationId", effect.installation_id, "Effect installation");
    assertExpectedResource(command, "expectedRunId", effect.run_id, "Effect run");
    assertExpectedStatus(command, effect.status);
    const outcome = command.payload.outcome;
    if (outcome !== "succeeded" && outcome !== "failed") throw Object.assign(new Error("Reconciliation outcome must be succeeded or failed"), { statusCode: 400 });
    await dependencies.effectReceipts.reconcile({
      organizationId: effect.organization_id,
      effectId: command.target_id,
      outcome,
      providerReceipt: command.payload.providerReceipt,
      error: command.payload.error,
    });
    await auditCommand(dependencies.pool, { organizationId: effect.organization_id, actorId, action: "operator_command.effect_reconciled", commandId: command.id, metadata: { effectId: command.target_id, outcome } });
    return { status: outcome, effectId: command.target_id };
  }

  if (command.command_type === "reconcile_budget") {
    if (!dependencies.runBudgets) throw Object.assign(new Error("Run-budget controls are unavailable"), { statusCode: 503 });
    const reservation = (await query<{ organization_id: string; run_id: string; status: string }>(
      dependencies.pool,
      "SELECT organization_id, run_id, status FROM run_budget_reservations WHERE id = $1",
      [command.target_id],
    )).rows[0];
    if (!reservation) throw Object.assign(new Error("Model budget reservation not found"), { statusCode: 404 });
    assertExpectedResource(command, "expectedOrganizationId", reservation.organization_id, "Budget reservation organization");
    assertExpectedResource(command, "expectedRunId", reservation.run_id, "Budget reservation run");
    assertExpectedStatus(command, reservation.status);
    const outcome = command.payload.outcome;
    if (outcome !== "captured" && outcome !== "released") throw Object.assign(new Error("Budget reconciliation outcome must be captured or released"), { statusCode: 400 });
    const usageValue = command.payload.usage;
    const usage = outcome === "captured"
      ? z.object({
        inputTokens: z.number().int().min(0).max(10_000_000),
        outputTokens: z.number().int().min(0).max(10_000_000),
        totalTokens: z.number().int().min(0).max(20_000_000),
        estimatedCostUsd: z.number().finite().min(0).max(1_000_000).optional(),
      }).strict().parse(usageValue)
      : undefined;
    await dependencies.runBudgets.reconcileUnknownReservation({
      organizationId: reservation.organization_id,
      reservationId: command.target_id,
      outcome,
      usage,
      reason: typeof command.payload.reason === "string" ? command.payload.reason.trim().slice(0, 2_000) : undefined,
    });
    await auditCommand(dependencies.pool, {
      organizationId: reservation.organization_id,
      actorId,
      action: "operator_command.budget_reconciled",
      commandId: command.id,
      metadata: { reservationId: command.target_id, outcome },
    });
    return { status: outcome, reservationId: command.target_id };
  }

  if (command.command_type === "retry_run") {
    const run = await dependencies.runs.getRunById(command.target_id);
    if (!run) throw Object.assign(new Error("Run not found"), { statusCode: 404 });
    assertExpectedResource(command, "expectedOrganizationId", run.organization_id, "Run organization");
    assertExpectedResource(command, "expectedInstallationId", run.installation_id, "Run installation");
    assertExpectedResource(command, "expectedConversationId", run.conversation_id, "Run conversation");
    assertExpectedStatus(command, run.status);
    if (!["failed", "cancelled", "expired"].includes(run.status)) {
      throw Object.assign(new Error("Only failed, cancelled, or expired runs can be retried"), { statusCode: 409 });
    }
    if (!dependencies.startWorkflow) throw Object.assign(new Error("Temporal workflow dispatch is unavailable"), { statusCode: 503 });
    const retried = await dependencies.runs.createRun(run.organization_id, actorId, {
      installationId: run.installation_id,
      conversationId: run.conversation_id ?? undefined,
      triggerType: ["message", "schedule", "webhook", "manual"].includes(run.trigger_type)
        ? run.trigger_type as "message" | "schedule" | "webhook" | "manual"
        : "manual",
      input: run.input,
      idempotencyKey: `operator-retry:${command.id}`,
    });
    if (retried.created !== false) {
      try {
        await dependencies.startWorkflow(retried.id);
      } catch (error) {
        await dependencies.runs.failRun(retried.id, {
          code: "WORKFLOW_DISPATCH_FAILED",
          message: error instanceof Error ? error.message : "Workflow dispatch failed",
        });
        throw error;
      }
    }
    await auditCommand(dependencies.pool, {
      organizationId: run.organization_id,
      actorId,
      action: "operator_command.run_retried",
      commandId: command.id,
      metadata: { sourceRunId: run.id, runId: retried.id },
    });
    return { status: "started", runId: retried.id, sourceRunId: run.id };
  }

  if (command.command_type === "retry_audio_transcription") {
    if (!dependencies.audioTranscriptionJobs) throw Object.assign(new Error("Audio transcription controls are unavailable"), { statusCode: 503 });
    const job = await dependencies.audioTranscriptionJobs.getById(command.target_id);
    if (!job) throw Object.assign(new Error("Audio transcription job not found"), { statusCode: 404 });
    assertExpectedResource(command, "expectedOrganizationId", job.organization_id, "Audio transcription job organization");
    assertExpectedResource(command, "expectedInstallationId", job.installation_id, "Audio transcription job installation");
    assertExpectedStatus(command, job.status);
    const retried = await dependencies.audioTranscriptionJobs.retry(job.id, actorId);
    await auditCommand(dependencies.pool, {
      organizationId: job.organization_id,
      actorId,
      action: "operator_command.audio_transcription_retried",
      commandId: command.id,
      metadata: { audioTranscriptionJobId: job.id },
    });
    return { status: retried.status, audioTranscriptionJobId: retried.id };
  }

  if (command.command_type === "delete_audio_transcription") {
    if (!dependencies.audioTranscriptionJobs || !dependencies.coreClient) throw Object.assign(new Error("Audio deletion controls are unavailable"), { statusCode: 503 });
    const job = await dependencies.audioTranscriptionJobs.getById(command.target_id);
    if (!job) throw Object.assign(new Error("Audio transcription job not found"), { statusCode: 404 });
    assertExpectedResource(command, "expectedOrganizationId", job.organization_id, "Audio transcription job organization");
    assertExpectedResource(command, "expectedInstallationId", job.installation_id, "Audio transcription job installation");
    assertExpectedStatus(command, job.status);
    if (["queued", "processing", "dispatching"].includes(job.status)) {
      throw Object.assign(new Error("Only completed or terminally failed audio jobs can be deleted"), { statusCode: 409 });
    }
    if (job.status === "deleted") return { status: "deleted", audioTranscriptionJobId: job.id };
    await dependencies.coreClient.deleteContentMedia({
      organizationId: job.organization_id,
      installationId: job.installation_id,
      actorId,
      runId: job.result_run_id ?? job.id,
      correlationId: job.correlation_id,
    }, job.asset_id);
    const deleted = await dependencies.audioTranscriptionJobs.markDeleted(job.id, actorId);
    if (!deleted) throw Object.assign(new Error("Audio transcription job changed before deletion completed"), { statusCode: 409 });
    await auditCommand(dependencies.pool, {
      organizationId: job.organization_id,
      actorId,
      action: "operator_command.audio_transcription_deleted",
      commandId: command.id,
      metadata: { audioTranscriptionJobId: job.id },
    });
    return { status: "deleted", audioTranscriptionJobId: job.id };
  }

  if (command.command_type === "assign_run") {
    const assigneeId = typeof command.payload.assigneeId === "string" ? command.payload.assigneeId.trim() : "";
    if (assigneeId.length < 1 || assigneeId.length > 240) {
      throw Object.assign(new Error("assigneeId must be between 1 and 240 characters"), { statusCode: 400 });
    }
    const assignment = await withTransaction(dependencies.pool, async (client) => {
      const run = (await client.query<{ organization_id: string; installation_id: string | null; conversation_id: string | null; status: string }>(
        "SELECT organization_id, installation_id, conversation_id, status FROM agent_runs WHERE id = $1 FOR UPDATE",
        [command.target_id],
      )).rows[0];
      if (!run) throw Object.assign(new Error("Run not found"), { statusCode: 404 });
      assertExpectedResource(command, "expectedOrganizationId", run.organization_id, "Run organization");
      assertExpectedResource(command, "expectedInstallationId", run.installation_id, "Run installation");
      assertExpectedResource(command, "expectedConversationId", run.conversation_id, "Run conversation");
      assertExpectedStatus(command, run.status);
      const result = await client.query<{ id: string; revision: number }>(
        `INSERT INTO agent_operator_run_assignments
          (run_id, organization_id, assignee_id, assigned_by, expected_status)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (run_id) DO UPDATE SET
           organization_id = EXCLUDED.organization_id,
           assignee_id = EXCLUDED.assignee_id,
           assigned_by = EXCLUDED.assigned_by,
           expected_status = EXCLUDED.expected_status,
           revision = agent_operator_run_assignments.revision + 1,
           assigned_at = now(),
           updated_at = now()
         RETURNING id, revision`,
        [command.target_id, run.organization_id, assigneeId, actorId, run.status],
      );
      return { organizationId: run.organization_id, assignmentId: result.rows[0]!.id, revision: result.rows[0]!.revision, status: run.status };
    });
    await auditCommand(dependencies.pool, {
      organizationId: assignment.organizationId,
      actorId,
      action: "operator_command.run_assigned",
      commandId: command.id,
      metadata: { runId: command.target_id, assigneeId, revision: assignment.revision, expectedStatus: assignment.status },
    });
    return { status: "assigned", runId: command.target_id, assignmentId: assignment.assignmentId, assigneeId };
  }

  if (command.command_type === "replay_delivery") {
    if (!dependencies.channels) throw Object.assign(new Error("Delivery replay is unavailable"), { statusCode: 503 });
    const expectedDeliveryStatus = expectedStatus(command);
    if (expectedDeliveryStatus && expectedDeliveryStatus !== "failed" && expectedDeliveryStatus !== "unknown") {
      throw Object.assign(new Error("replay_delivery expectedStatus must be failed or unknown"), { statusCode: 400 });
    }
    const boundedExpectedDeliveryStatus = expectedDeliveryStatus as "failed" | "unknown" | undefined;
    const target = (await query<{ organization_id: string; conversation_id: string; installation_id: string }>(
      dependencies.pool,
      `SELECT deliveries.organization_id, deliveries.conversation_id, conversations.installation_id
       FROM delivery_attempts deliveries
       JOIN conversations ON conversations.id = deliveries.conversation_id
       WHERE deliveries.id = $1`,
      [command.target_id],
    )).rows[0];
    if (!target) throw Object.assign(new Error("Delivery attempt not found"), { statusCode: 404 });
    assertExpectedResource(command, "expectedOrganizationId", target.organization_id, "Delivery organization");
    assertExpectedResource(command, "expectedInstallationId", target.installation_id, "Delivery installation");
    assertExpectedResource(command, "expectedConversationId", target.conversation_id, "Delivery conversation");
    const replay = await dependencies.channels.replayDelivery({
      organizationId: target.organization_id,
      attemptId: command.target_id,
      confirmUnknown: command.payload.confirmUnknown === true,
      expectedStatus: boundedExpectedDeliveryStatus,
    });
    await auditCommand(dependencies.pool, {
      organizationId: target.organization_id,
      actorId,
      action: "operator_command.delivery_replayed",
      commandId: command.id,
      metadata: { originalDeliveryAttemptId: replay.previous.id, deliveryAttemptId: replay.replay.id },
    });
    return {
      status: "queued",
      deliveryAttemptId: replay.replay.id,
      originalDeliveryAttemptId: replay.previous.id,
    };
  }

  if (command.command_type === "delete_memory") {
    const canonicalTarget = await findCanonicalMemoryTarget(dependencies.pool, command.target_id, "active");
    if (!canonicalTarget) throw Object.assign(new Error("Memory revision not found"), { statusCode: 404 });
    if (!dependencies.memoryDeletionJobs) throw Object.assign(new Error("Canonical memory deletion is unavailable"), { statusCode: 503 });
    assertExpectedResource(command, "expectedOrganizationId", canonicalTarget.organization_id, "Memory organization");
    assertExpectedResource(command, "expectedAgentId", canonicalTarget.agent_definition_id, "Memory agent");
    assertExpectedResource(command, "expectedConversationId", canonicalTarget.conversation_id, "Memory conversation");
    assertExpectedStatus(command, canonicalTarget.lifecycle_state);
    if (canonicalTarget.lifecycle_state !== "active") throw Object.assign(new Error("Only active canonical memory revisions can be deleted"), { statusCode: 409 });
    const deletion = await dependencies.memoryDeletionJobs.enqueue({
      organizationId: canonicalTarget.organization_id,
      requestedBy: actorId,
      targetType: "memory",
      targetId: canonicalTarget.fact_id,
    });
    await auditCommand(dependencies.pool, {
      organizationId: canonicalTarget.organization_id,
      actorId,
      action: "operator_command.memory_v2_deletion_requested",
      commandId: command.id,
      metadata: { memoryId: command.target_id, factId: canonicalTarget.fact_id, revisionId: canonicalTarget.revision_id, deletionJobId: deletion.id, replayed: deletion.replayed },
    });
    return { status: "queued", memoryId: command.target_id, factId: canonicalTarget.fact_id, revisionId: canonicalTarget.revision_id, deletionJobId: deletion.id, replayed: deletion.replayed };
  }

  if (command.command_type === "review_memory") {
    const canonicalTarget = await findCanonicalMemoryTarget(dependencies.pool, command.target_id, "review");
    if (!canonicalTarget) throw Object.assign(new Error("Memory revision not found"), { statusCode: 404 });
    if (!dependencies.memoryRevisionCommands) throw Object.assign(new Error("Canonical memory review is unavailable"), { statusCode: 503 });
    if (canonicalTarget.lifecycle_state !== "review_pending" && canonicalTarget.lifecycle_state !== "quarantined") {
      throw Object.assign(new Error("Only review-pending or quarantined canonical memory revisions can be reviewed"), { statusCode: 409 });
    }
    assertExpectedResource(command, "expectedOrganizationId", canonicalTarget.organization_id, "Memory organization");
    assertExpectedResource(command, "expectedAgentId", canonicalTarget.agent_definition_id, "Memory agent");
    assertExpectedResource(command, "expectedInstallationId", canonicalTarget.installation_id, "Memory installation");
    assertExpectedResource(command, "expectedConversationId", canonicalTarget.conversation_id, "Memory conversation");
    assertExpectedStatus(command, canonicalTarget.lifecycle_state);
    const decision = command.payload.decision;
    if (decision !== "approve" && decision !== "reject") {
      throw Object.assign(new Error("Memory review decision must be approve or reject"), { statusCode: 400 });
    }
    const reviewed = await dependencies.memoryRevisionCommands.operatorTransition({
      organizationId: canonicalTarget.organization_id,
      revisionId: canonicalTarget.revision_id,
      actorId,
      operationId: command.id,
      command: decision,
    });
    await auditCommand(dependencies.pool, {
      organizationId: canonicalTarget.organization_id,
      actorId,
      action: "operator_command.memory_v2_reviewed",
      commandId: command.id,
      metadata: { memoryId: command.target_id, factId: canonicalTarget.fact_id, revisionId: canonicalTarget.revision_id, resultingRevisionId: reviewed.revision.id, decision, replayed: reviewed.status === "replayed" },
    });
    return { status: decision === "approve" ? "approved" : "rejected", memoryId: command.target_id, factId: canonicalTarget.fact_id, revisionId: reviewed.revision.id, replayed: reviewed.status === "replayed" };
  }

  if (command.command_type === "suspend_installation" || command.command_type === "resume_installation") {
    if (!dependencies.agents) throw new Error("Installation lifecycle commands are unavailable");
    const target = (await query<{ organization_id: string; status: string }>(dependencies.pool, "SELECT organization_id, status FROM agent_installations WHERE id = $1", [command.target_id])).rows[0];
    if (!target) throw Object.assign(new Error("Installation not found"), { statusCode: 404 });
    assertExpectedResource(command, "expectedOrganizationId", target.organization_id, "Installation organization");
    assertExpectedStatus(command, target.status);
    const status = command.command_type === "suspend_installation" ? "paused" : "active";
    await dependencies.agents.setInstallationStatus(target.organization_id, command.target_id, status, actorId);
    await auditCommand(dependencies.pool, { organizationId: target.organization_id, actorId, action: `operator_command.installation_${status}`, commandId: command.id, metadata: { installationId: command.target_id } });
    return { status, installationId: command.target_id };
  }

  if (command.command_type === "revoke_credential") {
    if (!dependencies.installationCredentials) throw new Error("Credential lifecycle commands are unavailable");
    const target = (await query<{ organization_id: string; installation_id: string; status: string }>(dependencies.pool, "SELECT organization_id, installation_id, status FROM agent_installation_credentials WHERE id = $1", [command.target_id])).rows[0];
    if (!target) throw Object.assign(new Error("Installation credential not found"), { statusCode: 404 });
    assertExpectedResource(command, "expectedOrganizationId", target.organization_id, "Credential organization");
    assertExpectedResource(command, "expectedInstallationId", target.installation_id, "Credential installation");
    assertExpectedStatus(command, target.status);
    await dependencies.installationCredentials.revoke({ organizationId: target.organization_id, installationId: target.installation_id, credentialId: command.target_id, actorId });
    await auditCommand(dependencies.pool, { organizationId: target.organization_id, actorId, action: "operator_command.credential_revoked", commandId: command.id, metadata: { credentialId: command.target_id, installationId: target.installation_id } });
    return { status: "revoked", credentialId: command.target_id };
  }

  if (command.command_type === "pause_schedule" || command.command_type === "resume_schedule") {
    if (!dependencies.schedules) throw new Error("Schedule lifecycle commands are unavailable");
    const target = (await query<{ organization_id: string; installation_id: string; status: string }>(dependencies.pool, "SELECT organization_id, installation_id, status FROM agent_schedules WHERE id = $1", [command.target_id])).rows[0];
    if (!target) throw Object.assign(new Error("Schedule not found"), { statusCode: 404 });
    assertExpectedResource(command, "expectedOrganizationId", target.organization_id, "Schedule organization");
    assertExpectedResource(command, "expectedInstallationId", target.installation_id, "Schedule installation");
    assertExpectedStatus(command, target.status);
    const status = command.command_type === "pause_schedule" ? "paused" : "active";
    await dependencies.schedules.setStatus(target.organization_id, command.target_id, status, actorId);
    await auditCommand(dependencies.pool, { organizationId: target.organization_id, actorId, action: `operator_command.schedule_${status}`, commandId: command.id, metadata: { scheduleId: command.target_id } });
    return { status, scheduleId: command.target_id };
  }

  if (command.command_type === "request_export") {
    const organizationId = typeof command.payload.organizationId === "string" ? command.payload.organizationId.trim() : "";
    const scopeType = typeof command.payload.scopeType === "string" ? command.payload.scopeType.trim() : "";
    const scopeId = typeof command.payload.scopeId === "string" ? command.payload.scopeId.trim() : undefined;
    if (!organizationId || organizationId.length > 240) {
      throw Object.assign(new Error("organizationId is required and must be at most 240 characters"), { statusCode: 400 });
    }
    if (!["organization", "installation", "run", "conversation", "memory"].includes(scopeType)) {
      throw Object.assign(new Error("scopeType must be organization, installation, run, conversation, or memory"), { statusCode: 400 });
    }
    if (scopeType === "organization" && scopeId) {
      throw Object.assign(new Error("Organization exports must not include scopeId"), { statusCode: 400 });
    }
    if (scopeType !== "organization" && (!scopeId || scopeId.length > 240 || scopeId !== command.target_id)) {
      throw Object.assign(new Error("Resource exports require scopeId to match targetId"), { statusCode: 400 });
    }
    const exportRequest = await withTransaction(dependencies.pool, async (client) => {
      let actualOrganizationId: string | null = null;
      if (scopeType === "organization") {
        const found = (await client.query<{ present: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM agent_definitions WHERE organization_id = $1
             UNION ALL SELECT 1 FROM agent_installations WHERE organization_id = $1
             UNION ALL SELECT 1 FROM agent_runs WHERE organization_id = $1
             UNION ALL SELECT 1 FROM conversations WHERE organization_id = $1
             UNION ALL SELECT 1 FROM memory_records WHERE organization_id = $1
           ) AS present`,
          [organizationId],
        )).rows[0]?.present;
        if (!found) throw Object.assign(new Error("Organization not found"), { statusCode: 404 });
        actualOrganizationId = organizationId;
      } else {
        const table = scopeType === "installation" ? "agent_installations" : scopeType === "run" ? "agent_runs" : scopeType === "conversation" ? "conversations" : "memory_records";
        const target = (await client.query<{ organization_id: string }>(`SELECT organization_id FROM ${table} WHERE id = $1 FOR SHARE`, [scopeId])).rows[0];
        if (!target) throw Object.assign(new Error(`${scopeType} not found`), { statusCode: 404 });
        actualOrganizationId = target.organization_id;
        if (actualOrganizationId !== organizationId) {
          throw Object.assign(new Error("Export resource belongs to a different organization"), { statusCode: 409 });
        }
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO agent_export_requests
          (command_id, organization_id, requested_by, scope_type, scope_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING id`,
        [command.id, actualOrganizationId, actorId, scopeType, scopeId ?? null, JSON.stringify({ scopeType, scopeId: scopeId ?? null })],
      );
      return { id: inserted.rows[0]!.id, organizationId: actualOrganizationId };
    });
    await auditCommand(dependencies.pool, {
      organizationId: exportRequest.organizationId,
      actorId,
      action: "operator_command.export_requested",
      commandId: command.id,
      metadata: { exportRequestId: exportRequest.id, scopeType, scopeId: scopeId ?? null },
    });
    return { status: "requested", exportRequestId: exportRequest.id, scopeType, scopeId: scopeId ?? null };
  }

  if (command.command_type === "set_retention_policy") {
    if (!dependencies.retention) throw Object.assign(new Error("Retention controls are unavailable"), { statusCode: 503 });
    const organizationId = command.target_id.trim();
    const actorOrganizationId = expectedResource(command, "expectedOrganizationId");
    if (actorOrganizationId && actorOrganizationId !== organizationId) throw Object.assign(new Error("Retention policy organization does not match expected organization"), { statusCode: 409 });
    const record = await dependencies.retention.setPolicy({
      organizationId,
      memoryDays: retentionDays(command, "memoryDays", 1, 3650),
      conversationDays: retentionDays(command, "conversationDays", 1, 3650),
      eventDays: retentionDays(command, "eventDays", 1, 3650),
      auditDays: retentionDays(command, "auditDays", 30, 3650),
      attachmentDays: retentionDays(command, "attachmentDays", 1, 3650),
      actorId,
    });
    await auditCommand(dependencies.pool, { organizationId, actorId, action: "operator_command.retention_policy_updated", commandId: command.id, metadata: { retentionPolicyId: record.id, revision: record.revision } });
    return { status: "updated", retentionPolicyId: record.id };
  }

  if (command.command_type === "apply_retention_policy") {
    if (!dependencies.memoryRetention) throw Object.assign(new Error("Canonical retention controls are unavailable"), { statusCode: 503 });
    const organizationId = command.target_id.trim();
    assertExpectedResource(command, "expectedOrganizationId", organizationId, "Retention organization");
    const memory = await dependencies.memoryRetention.requestRetentionScan(organizationId);
    const audio = await applyAudioRetention(organizationId, actorId, dependencies);
    const result = { workspacesQueued: memory.queued, audioDeleted: audio.deleted, audioFailed: audio.failed };
    await auditCommand(dependencies.pool, { organizationId, actorId, action: "operator_command.retention_requested", commandId: command.id, metadata: result });
    return { status: "queued", ...result };
  }

  if (command.command_type === "create_legal_hold") {
    if (!dependencies.retention) throw Object.assign(new Error("Legal holds are unavailable"), { statusCode: 503 });
    const organizationId = typeof command.payload.organizationId === "string" ? command.payload.organizationId.trim() : "";
    const scopeType = command.payload.scopeType;
    const scopeId = typeof command.payload.scopeId === "string" ? command.payload.scopeId.trim() : "";
    const reason = typeof command.payload.reason === "string" ? command.payload.reason.trim() : "";
    if (!organizationId || !reason || reason.length < 8 || reason.length > 500) throw Object.assign(new Error("organizationId and a reason of 8-500 characters are required"), { statusCode: 400 });
    if (scopeType !== "organization" && scopeType !== "installation" && scopeType !== "conversation") throw Object.assign(new Error("scopeType must be organization, installation, or conversation"), { statusCode: 400 });
    if (!scopeId || (scopeType === "organization" && scopeId !== organizationId) || (scopeType !== "organization" && scopeId !== command.target_id)) throw Object.assign(new Error("Legal hold scope must match targetId"), { statusCode: 400 });
    if (scopeType !== "organization") {
      const table = scopeType === "installation" ? "agent_installations" : "conversations";
      const resource = (await query<{ organization_id: string }>(dependencies.pool, `SELECT organization_id FROM ${table} WHERE id = $1`, [scopeId])).rows[0];
      if (!resource) throw Object.assign(new Error(`${scopeType} not found`), { statusCode: 404 });
      if (resource.organization_id !== organizationId) throw Object.assign(new Error("Legal hold resource belongs to a different organization"), { statusCode: 409 });
    }
    const expiresAt = command.payload.expiresAt === undefined ? null : boundedExpiry(command, 3650);
    const record = await dependencies.retention.createLegalHold({ organizationId, scopeType, scopeId, reason, expiresAt, actorId });
    await auditCommand(dependencies.pool, { organizationId, actorId, action: "operator_command.legal_hold_created", commandId: command.id, metadata: { legalHoldId: record.id, scopeType, scopeId } });
    return { status: "active", legalHoldId: record.id };
  }

  if (command.command_type === "release_legal_hold") {
    if (!dependencies.retention) throw Object.assign(new Error("Legal holds are unavailable"), { statusCode: 503 });
    const hold = await dependencies.retention.getLegalHold(command.target_id);
    if (!hold) throw Object.assign(new Error("Legal hold not found"), { statusCode: 404 });
    assertExpectedResource(command, "expectedOrganizationId", hold.organization_id, "Legal hold organization");
    assertExpectedStatus(command, hold.status);
    const record = await dependencies.retention.releaseLegalHold(command.target_id, actorId);
    await auditCommand(dependencies.pool, { organizationId: record.organization_id, actorId, action: "operator_command.legal_hold_released", commandId: command.id, metadata: { legalHoldId: record.id, revision: record.revision } });
    return { status: "released", legalHoldId: record.id };
  }

  if (command.command_type === "set_feature_flag" || command.command_type === "clear_feature_flag") {
    if (!dependencies.controls) throw Object.assign(new Error("Feature flag controls are unavailable"), { statusCode: 503 });
    const flagKey = operatorFlagKey(command);
    const scope = operatorFlagScope(command);
    const reason = typeof command.payload.reason === "string" ? command.payload.reason.trim() : "";
    if (!reason || reason.length > 500) throw Object.assign(new Error("reason is required"), { statusCode: 400 });
    if (command.command_type === "set_feature_flag" && typeof command.payload.enabled !== "boolean") throw Object.assign(new Error("enabled must be boolean"), { statusCode: 400 });
    const expiresAt = boundedExpiry(command, 30);
    if (scope.scopeType === "installation") {
      const installation = (await query<{ organization_id: string }>(dependencies.pool, "SELECT organization_id FROM agent_installations WHERE id = $1", [scope.scopeId])).rows[0];
      if (!installation) throw Object.assign(new Error("Installation not found"), { statusCode: 404 });
      if (installation.organization_id !== scope.organizationId) throw Object.assign(new Error("Feature flag installation belongs to a different organization"), { statusCode: 409 });
    }
    const record = await dependencies.controls.setFeatureFlag({
      ...scope,
      flagKey,
      enabled: command.command_type === "set_feature_flag" && command.payload.enabled === true,
      reason,
      expiresAt,
      actorId,
    });
    await auditCommand(dependencies.pool, { organizationId: record.organization_id, actorId, action: `operator_command.feature_flag_${record.enabled ? "enabled" : "cleared"}`, commandId: command.id, metadata: { featureFlagId: record.id, flagKey: record.flag_key, scopeType: record.scope_type, scopeId: record.scope_id, revision: record.revision } });
    return { status: record.enabled ? "enabled" : "cleared", featureFlagId: record.id };
  }

  if (command.command_type === "create_hold") {
    if (!dependencies.controls) throw Object.assign(new Error("Incident holds are unavailable"), { statusCode: 503 });
    const organizationId = typeof command.payload.organizationId === "string" ? command.payload.organizationId.trim() : "";
    const reason = typeof command.payload.reason === "string" ? command.payload.reason.trim() : "";
    const holdType = command.payload.holdType;
    const scope = operatorHoldScope(command);
    if (!organizationId || organizationId.length > 240 || !reason || reason.length > 500) throw Object.assign(new Error("organizationId and reason are required"), { statusCode: 400 });
    if (holdType !== "execution" && holdType !== "effects" && holdType !== "delivery") throw Object.assign(new Error("holdType must be execution, effects, or delivery"), { statusCode: 400 });
    if (scope.scopeType === "organization" && scope.scopeId !== organizationId) throw Object.assign(new Error("Organization hold scope must match organizationId"), { statusCode: 400 });
    if (scope.scopeType === "installation" || scope.scopeType === "run") {
      const table = scope.scopeType === "installation" ? "agent_installations" : "agent_runs";
      const resource = (await query<{ organization_id: string }>(dependencies.pool, `SELECT organization_id FROM ${table} WHERE id = $1`, [scope.scopeId])).rows[0];
      if (!resource) throw Object.assign(new Error(`${scope.scopeType} not found`), { statusCode: 404 });
      if (resource.organization_id !== organizationId) throw Object.assign(new Error("Hold resource belongs to a different organization"), { statusCode: 409 });
    }
    const record = await dependencies.controls.createHold({ organizationId, ...scope, holdType, reason, expiresAt: boundedExpiry(command, 7), actorId });
    await auditCommand(dependencies.pool, { organizationId, actorId, action: "operator_command.hold_created", commandId: command.id, metadata: { holdId: record.id, holdType, scopeType: scope.scopeType, scopeId: scope.scopeId, expiresAt: record.expires_at } });
    return { status: "active", holdId: record.id };
  }

  if (command.command_type === "release_hold") {
    if (!dependencies.controls) throw Object.assign(new Error("Incident holds are unavailable"), { statusCode: 503 });
    const hold = await dependencies.controls.getHold(command.target_id);
    if (!hold) throw Object.assign(new Error("Operator hold not found"), { statusCode: 404 });
    assertExpectedResource(command, "expectedOrganizationId", hold.organization_id, "Hold organization");
    assertExpectedStatus(command, hold.status);
    const record = await dependencies.controls.releaseHold(command.target_id, actorId);
    await auditCommand(dependencies.pool, { organizationId: record.organization_id, actorId, action: "operator_command.hold_released", commandId: command.id, metadata: { holdId: record.id, revision: record.revision } });
    return { status: "released", holdId: record.id };
  }

  if (command.command_type === "kill_switch_enable") {
    const scopeType = command.payload.scopeType;
    const scopeId = typeof command.payload.scopeId === "string" ? command.payload.scopeId.trim() : "";
    const reason = typeof command.payload.reason === "string" ? command.payload.reason.trim() : "";
    if (!["global", "organization", "agent", "installation", "tool"].includes(String(scopeType)) || !scopeId || !reason) throw Object.assign(new Error("Kill-switch scope, id, and reason are required"), { statusCode: 400 });
    const organizationId = typeof command.payload.organizationId === "string" && command.payload.organizationId.trim() ? command.payload.organizationId.trim() : undefined;
    assertExpectedResource(command, "expectedOrganizationId", organizationId, "Kill-switch organization");
    const record = await dependencies.killSwitches.set({ organizationId, scopeType: scopeType as "global" | "organization" | "agent" | "installation" | "tool", scopeId, reason, actorId });
    await auditCommand(dependencies.pool, { organizationId, actorId, action: "operator_command.kill_switch_enabled", commandId: command.id, metadata: { scopeType, scopeId } });
    return { status: "enabled", switchId: record.id };
  }

  const switchRow = (await query<{ organization_id: string | null; enabled: boolean }>(dependencies.pool, "SELECT organization_id, enabled FROM agent_kill_switches WHERE id = $1", [command.target_id])).rows[0];
  if (!switchRow) throw Object.assign(new Error("Kill switch not found"), { statusCode: 404 });
  assertExpectedResource(command, "expectedOrganizationId", switchRow.organization_id, "Kill-switch organization");
  assertExpectedStatus(command, switchRow.enabled ? "enabled" : "disabled");
  await dependencies.killSwitches.disable(switchRow.organization_id ?? undefined, command.target_id, actorId);
  await auditCommand(dependencies.pool, { organizationId: switchRow.organization_id, actorId, action: "operator_command.kill_switch_disabled", commandId: command.id, metadata: { switchId: command.target_id } });
  return { status: "disabled", switchId: command.target_id };
}

async function completeCommand(command: OperatorCommandRecord, actorId: string, dependencies: OperatorCommandDependencies): Promise<OperatorCommandRecord> {
  try {
    const result = await executeCommand(command, actorId, dependencies);
    return (await query<OperatorCommandRecord>(dependencies.pool, `UPDATE agent_operator_commands SET status = 'completed', result = $2::jsonb, updated_at = now(), completed_at = now() WHERE id = $1 RETURNING *`, [command.id, JSON.stringify(result)])).rows[0]!;
  } catch (error) {
    const failure = { code: "OPERATOR_COMMAND_FAILED", message: error instanceof Error ? error.message : "Operator command failed" };
    await query(dependencies.pool, `UPDATE agent_operator_commands SET status = 'failed', error = $2::jsonb, updated_at = now(), completed_at = now() WHERE id = $1`, [command.id, JSON.stringify(failure)]);
    throw error;
  }
}

export async function createOperatorCommand(input: { actorId: string; idempotencyKey?: string; command: OperatorCommandInput; dependencies: OperatorCommandDependencies }): Promise<{ command: Record<string, unknown>; replayed: boolean }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const required = requiredApprovals(input.command.commandType);
  const inserted = await query<OperatorCommandRecord>(input.dependencies.pool, `INSERT INTO agent_operator_commands (command_type, target_id, actor_id, payload, status, required_approvals, approvers, idempotency_key) VALUES ($1, $2, $3, $4::jsonb, $5, $6, ARRAY[$3]::text[], $7) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`, [input.command.commandType, input.command.targetId, input.actorId, JSON.stringify(input.command.payload), required === 1 ? "executing" : "awaiting_approval", required, idempotencyKey]);
  const command = inserted.rows[0] ?? (await query<OperatorCommandRecord>(input.dependencies.pool, "SELECT * FROM agent_operator_commands WHERE idempotency_key = $1", [idempotencyKey])).rows[0];
  if (!command) throw Object.assign(new Error("Operator command could not be created"), { statusCode: 500 });
  if (!inserted.rows[0]) {
    if (
      command.actor_id !== input.actorId
      || command.command_type !== input.command.commandType
      || command.target_id !== input.command.targetId
      || !isDeepStrictEqual(command.payload, input.command.payload)
    ) {
      throw Object.assign(new Error("Idempotency key is already bound to a different operator command"), { statusCode: 409 });
    }
    return { command: publicOperatorCommand(command), replayed: true };
  }
  await auditCommand(input.dependencies.pool, {
    organizationId: command.organization_id,
    actorId: input.actorId,
    action: "operator_command.requested",
    commandId: command.id,
    metadata: { commandType: command.command_type, targetId: command.target_id, requiredApprovals: command.required_approvals },
  });
  if (command.status !== "executing") return { command: publicOperatorCommand(command), replayed: false };
  const completed = await completeCommand(command, input.actorId, input.dependencies);
  return { command: publicOperatorCommand(completed), replayed: false };
}

export async function approveOperatorCommand(input: { actorId: string; commandId: string; dependencies: OperatorCommandDependencies }): Promise<Record<string, unknown>> {
  const command = await withTransaction(input.dependencies.pool, async (client) => {
    const current = (await client.query<OperatorCommandRecord>("SELECT * FROM agent_operator_commands WHERE id = $1 FOR UPDATE", [input.commandId])).rows[0];
    if (!current) throw Object.assign(new Error("Operator command not found"), { statusCode: 404 });
    if (current.status !== "awaiting_approval") throw Object.assign(new Error(`Operator command is ${current.status}`), { statusCode: 409 });
    if (current.approvers.includes(input.actorId)) throw Object.assign(new Error("A second operator must approve this command"), { statusCode: 409 });
    const updated = await client.query<OperatorCommandRecord>("UPDATE agent_operator_commands SET approvers = array_append(approvers, $2), status = 'executing', updated_at = now() WHERE id = $1 RETURNING *", [input.commandId, input.actorId]);
    return updated.rows[0]!;
  });
  return publicOperatorCommand(await completeCommand(command, input.actorId, input.dependencies));
}

export async function getOperatorCommand(pool: Pool, commandId: string): Promise<Record<string, unknown>> {
  const command = (await query<OperatorCommandRecord>(pool, "SELECT * FROM agent_operator_commands WHERE id = $1", [commandId])).rows[0];
  if (!command) throw Object.assign(new Error("Operator command not found"), { statusCode: 404 });
  return publicOperatorCommand(command);
}
