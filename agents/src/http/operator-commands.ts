import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { query, withTransaction } from "../db/pool";
import { EffectReceiptRepository } from "../db/repositories/effect-receipt-repository";
import { KillSwitchRepository } from "../db/repositories/kill-switch-repository";
import { RunRepository } from "../db/repositories/run-repository";
import { AgentRepository } from "../db/repositories/agent-repository";
import { InstallationCredentialRepository } from "../db/repositories/installation-credential-repository";
import { ScheduleRepository } from "../db/repositories/schedule-repository";
import { ChannelRepository } from "../db/repositories/channel-repository";

export const operatorCommandInputSchema = z.object({
  commandType: z.enum(["cancel_run", "retry_run", "replay_delivery", "reconcile_effect", "kill_switch_enable", "kill_switch_disable", "suspend_installation", "resume_installation", "revoke_credential", "pause_schedule", "resume_schedule"]),
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
  startWorkflow?: (runId: string) => Promise<void>;
  signalCancellation?: (runId: string, signal: { reason?: string }) => Promise<void>;
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

async function auditCommand(pool: Pool, input: { organizationId?: string | null; actorId: string; action: string; commandId: string; metadata?: Record<string, unknown> }): Promise<void> {
  await pool.query(
    `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     VALUES ($1, 'platform_admin', $2, $3, 'operator_command', $4, $5::jsonb)`,
    [input.organizationId ?? null, input.actorId, input.action, input.commandId, JSON.stringify(input.metadata ?? {})],
  );
}

async function executeCommand(command: OperatorCommandRecord, actorId: string, dependencies: OperatorCommandDependencies): Promise<Record<string, unknown>> {
  if (command.command_type === "cancel_run") {
    const run = await dependencies.runs.getRunById(command.target_id);
    if (!run) throw Object.assign(new Error("Run not found"), { statusCode: 404 });
    assertExpectedStatus(command, run.status);
    if (["completed", "failed", "cancelled", "expired"].includes(run.status)) return { status: run.status, runId: run.id };
    if (!dependencies.signalCancellation) throw new Error("Temporal cancellation is unavailable");
    const reason = typeof command.payload.reason === "string" ? command.payload.reason.trim().slice(0, 500) : "cancelled by platform operator";
    await dependencies.signalCancellation(run.id, { reason: `${actorId}: ${reason}` });
    await auditCommand(dependencies.pool, { organizationId: run.organization_id, actorId, action: "operator_command.run_cancelled", commandId: command.id, metadata: { runId: run.id } });
    return { status: "cancellation_signalled", runId: run.id };
  }

  if (command.command_type === "reconcile_effect") {
    const effect = (await query<{ organization_id: string; status: string }>(dependencies.pool, "SELECT organization_id, status FROM agent_effect_receipts WHERE id = $1", [command.target_id])).rows[0];
    if (!effect) throw Object.assign(new Error("Effect receipt not found"), { statusCode: 404 });
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

  if (command.command_type === "retry_run") {
    const run = await dependencies.runs.getRunById(command.target_id);
    if (!run) throw Object.assign(new Error("Run not found"), { statusCode: 404 });
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

  if (command.command_type === "replay_delivery") {
    if (!dependencies.channels) throw Object.assign(new Error("Delivery replay is unavailable"), { statusCode: 503 });
    const expectedDeliveryStatus = expectedStatus(command);
    if (expectedDeliveryStatus && expectedDeliveryStatus !== "failed" && expectedDeliveryStatus !== "unknown") {
      throw Object.assign(new Error("replay_delivery expectedStatus must be failed or unknown"), { statusCode: 400 });
    }
    const boundedExpectedDeliveryStatus = expectedDeliveryStatus as "failed" | "unknown" | undefined;
    const target = (await query<{ organization_id: string }>(
      dependencies.pool,
      "SELECT organization_id FROM delivery_attempts WHERE id = $1",
      [command.target_id],
    )).rows[0];
    if (!target) throw Object.assign(new Error("Delivery attempt not found"), { statusCode: 404 });
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

  if (command.command_type === "suspend_installation" || command.command_type === "resume_installation") {
    if (!dependencies.agents) throw new Error("Installation lifecycle commands are unavailable");
    const target = (await query<{ organization_id: string; status: string }>(dependencies.pool, "SELECT organization_id, status FROM agent_installations WHERE id = $1", [command.target_id])).rows[0];
    if (!target) throw Object.assign(new Error("Installation not found"), { statusCode: 404 });
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
    assertExpectedStatus(command, target.status);
    await dependencies.installationCredentials.revoke({ organizationId: target.organization_id, installationId: target.installation_id, credentialId: command.target_id, actorId });
    await auditCommand(dependencies.pool, { organizationId: target.organization_id, actorId, action: "operator_command.credential_revoked", commandId: command.id, metadata: { credentialId: command.target_id, installationId: target.installation_id } });
    return { status: "revoked", credentialId: command.target_id };
  }

  if (command.command_type === "pause_schedule" || command.command_type === "resume_schedule") {
    if (!dependencies.schedules) throw new Error("Schedule lifecycle commands are unavailable");
    const target = (await query<{ organization_id: string; status: string }>(dependencies.pool, "SELECT organization_id, status FROM agent_schedules WHERE id = $1", [command.target_id])).rows[0];
    if (!target) throw Object.assign(new Error("Schedule not found"), { statusCode: 404 });
    assertExpectedStatus(command, target.status);
    const status = command.command_type === "pause_schedule" ? "paused" : "active";
    await dependencies.schedules.setStatus(target.organization_id, command.target_id, status, actorId);
    await auditCommand(dependencies.pool, { organizationId: target.organization_id, actorId, action: `operator_command.schedule_${status}`, commandId: command.id, metadata: { scheduleId: command.target_id } });
    return { status, scheduleId: command.target_id };
  }

  if (command.command_type === "kill_switch_enable") {
    const scopeType = command.payload.scopeType;
    const scopeId = typeof command.payload.scopeId === "string" ? command.payload.scopeId.trim() : "";
    const reason = typeof command.payload.reason === "string" ? command.payload.reason.trim() : "";
    if (!["global", "organization", "agent", "installation", "tool"].includes(String(scopeType)) || !scopeId || !reason) throw Object.assign(new Error("Kill-switch scope, id, and reason are required"), { statusCode: 400 });
    const organizationId = typeof command.payload.organizationId === "string" && command.payload.organizationId.trim() ? command.payload.organizationId.trim() : undefined;
    const record = await dependencies.killSwitches.set({ organizationId, scopeType: scopeType as "global" | "organization" | "agent" | "installation" | "tool", scopeId, reason, actorId });
    await auditCommand(dependencies.pool, { organizationId, actorId, action: "operator_command.kill_switch_enabled", commandId: command.id, metadata: { scopeType, scopeId } });
    return { status: "enabled", switchId: record.id };
  }

  const switchRow = (await query<{ organization_id: string | null; enabled: boolean }>(dependencies.pool, "SELECT organization_id, enabled FROM agent_kill_switches WHERE id = $1", [command.target_id])).rows[0];
  if (!switchRow) throw Object.assign(new Error("Kill switch not found"), { statusCode: 404 });
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
