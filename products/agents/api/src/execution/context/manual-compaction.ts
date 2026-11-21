import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { PlatformError, terminalTaskStates } from "../../contracts/contracts";
import { CONTEXT_COMPACTION_WORKFLOW, SHARED_HARNESS_RELEASE } from "../../contracts/execution";
import { restateServiceName } from "../../contracts/restate-names";
import { event, settleTask } from "../lifecycle/execution";
import { failCompactionJob, loadContinuityCheckpoint, prepareCompactionJob } from "../lifecycle/checkpoints";
import { loadExecution } from "../lifecycle/state";
import { contextModelPolicy } from "../business/business";
import { requestDigest as modelRequestDigest, type ModelRequest } from "../business/model";
import { prepareCompaction, recentWindowTokens, type ContextGroup } from "./context";
import { compactionFlags } from "./compaction-flags";
import type { EvidenceStore } from "./evidence";

export interface ManualCompactionScope {
  accountId: string;
  organizationId: string;
  agentId: string;
  conversationId: string;
}

export interface ManualCompactionOptions {
  pool: Pool;
  evidence: EvidenceStore;
  ingressUrl: string;
  dispatch?: typeof fetch;
  admit: (input: { accountId: string; organizationId: string; agentId: string; conversationId: string; requestKey: string; message: string; principal: unknown }) => Promise<{ taskId: string }>;
}

function unavailable(message: string): never {
  throw new PlatformError("COMPACTION_NOT_AVAILABLE", 409, message);
}

/** Freeze the current conversation into the same immutable background job used by automatic compaction. */
export async function compactConversation(options: ManualCompactionOptions, scope: ManualCompactionScope): Promise<{ id: string; taskId: string }> {
  if (!compactionFlags().manual) throw new PlatformError("COMPACTION_DISABLED", 409, "Manual context compaction is disabled.");
  const { pool, evidence } = options;
  const conversation = (await pool.query<{ agent_id: string; principal: unknown }>(
    "SELECT agent_id, principal FROM agents_platform.conversations WHERE id=$1 AND organization_id=$2 AND agent_id=$3 AND deleted_at IS NULL",
    [scope.conversationId, scope.organizationId, scope.agentId])).rows[0];
  if (!conversation) throw new PlatformError("NOT_FOUND", 404, "Conversation not found");
  const active = (await pool.query(
    "SELECT 1 FROM agents_platform.tasks WHERE conversation_id=$1 AND organization_id=$2 AND state <> ALL($3::text[]) LIMIT 1",
    [scope.conversationId, scope.organizationId, [...terminalTaskStates]])).rowCount;
  if (active) throw new PlatformError("CONVERSATION_BUSY", 409, "Wait for the current response to finish before compacting.");
  const latest = (await pool.query<{ id: string; turn_sequence: string; history_cutoff: string | null; harness_release: string }>(
    `SELECT id,turn_sequence::text,history_cutoff,harness_release FROM agents_platform.tasks
     WHERE conversation_id=$1 AND organization_id=$2 AND product='agents' AND state = ANY($3::text[])
       AND (execution_purpose IS NULL OR execution_purpose <> 'manual_compaction')
     ORDER BY turn_sequence DESC LIMIT 1`,
    [scope.conversationId, scope.organizationId, [...terminalTaskStates]])).rows[0];
  if (!latest) unavailable("There is no finished conversation to compact.");
  if (latest.harness_release !== SHARED_HARNESS_RELEASE) unavailable("This conversation uses an older execution release.");

  const pending = (await pool.query<{ id: string; taskId: string }>(
    "SELECT id,task_id AS \"taskId\" FROM agents_platform.context_compaction_jobs WHERE conversation_id=$1 AND mode='background' AND state='prepared' ORDER BY created_at DESC LIMIT 1",
    [scope.conversationId])).rows[0];
  if (pending) {
    await dispatchCompaction(options, pending);
    return { id: pending.id, taskId: pending.taskId };
  }

  const continuity = await loadContinuityCheckpoint(pool, latest.id, evidence, { allowSettled: true });
  const exclude = new Set(continuity?.coveredHistoryIds ?? []);
  const prior = (await pool.query<{ id: string; input: string; output: string | null; state: string; turn_sequence: string }>(
    `SELECT id,input,output,state,turn_sequence::text FROM agents_platform.tasks
     WHERE conversation_id=$1 AND organization_id=$2 AND product='agents' AND principal=$3::jsonb
       AND turn_sequence <= $4 AND state = ANY($5::text[])
       AND (execution_purpose IS NULL OR execution_purpose <> 'manual_compaction')
     ORDER BY turn_sequence`,
    [scope.conversationId, scope.organizationId, JSON.stringify(conversation.principal), Number(latest.turn_sequence), [...terminalTaskStates]])).rows
    .filter(task => !exclude.has(task.id));
  if (prior.length < 2) unavailable("There is not enough conversation to compact yet.");
  const instructions = prior.length ? (await pool.query<{ task_id: string; instruction: string }>(
    `SELECT task_id,instruction FROM agents_platform.orchestration_instructions
     WHERE task_id = ANY($1::uuid[]) ORDER BY task_id,sequence`, [prior.map(task => task.id)])).rows : [];
  const groups: ContextGroup[] = prior.map(task => ({
    id: task.id,
    messages: [
      { role: "user", content: task.input },
      ...instructions.filter(item => item.task_id === task.id).map(item => ({ role: "user" as const, content: item.instruction })),
      { role: "assistant", content: task.output ?? `Task ended: ${task.state}` },
    ],
  }));
  if (groups.length < 2) unavailable("There is not enough conversation to compact yet.");

  const id = `manual-${randomUUID()}`;
  const maintenance = await options.admit({
    accountId: scope.accountId, organizationId: scope.organizationId, agentId: scope.agentId,
    conversationId: scope.conversationId, requestKey: id, message: "Manual context compaction", principal: conversation.principal,
  });
  try {
    const execution = await loadExecution(pool, maintenance.taskId);
    if (execution.task.harness_release !== SHARED_HARNESS_RELEASE) unavailable("This conversation uses an older execution release.");
    const policy = execution.models.compaction.policy;
    const modelPolicy = contextModelPolicy(execution, "compaction");
    const plan = prepareCompaction(groups, {
      model: execution.models.compaction.binding.modelId,
      modelPolicy,
      retainRecentTokens: recentWindowTokens(execution.models.primary.policy.maxInputTokens),
      maxInputTokens: policy.maxInputTokens,
      maxOutputTokens: policy.maxOutputTokens,
      previousSummary: continuity?.summary,
    });
    const prefix = groups.filter(group => plan.compactedGroupIds.includes(group.id));
    if (!prefix.length || Buffer.byteLength(JSON.stringify(prefix.map(group => group.messages)), "utf8") < 2_000)
      unavailable("There is not enough earlier conversation to compact.");
    const request: ModelRequest = {
      messages: plan.messages,
      model: execution.models.compaction.binding.modelId,
      maxInputTokens: policy.maxInputTokens,
      maxOutputTokens: policy.maxOutputTokens,
      maxDurationSeconds: policy.maxCallDurationMs / 1000,
    };
    const snapshotId = `context:manual:${id}:${latest.turn_sequence}`;
    const historyIds = plan.compactedGroupIds.filter(groupId => prior.some(task => task.id === groupId));
    // Keep maintenance snapshots below every primary step and unique per manual job.
    const step = -1_000_000_000 - (Number.parseInt(id.replaceAll("-", "").slice(-8), 16) % 900_000_000);
    await pool.query(`INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,source_references,memory_scope_id,memory_generation,history_cutoff)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
    [snapshotId, maintenance.taskId, step, modelRequestDigest(request),
      { messages: plan.messages, estimatedTokens: plan.estimatedTokens, historyGroupIds: historyIds },
      JSON.stringify(plan.compactedGroupIds.map(groupId => ({ id: groupId, revision: 1, kind: "result" }))),
      null, null, latest.history_cutoff ?? "0"]);
    await evidence.inheritHistory(maintenance.taskId, snapshotId, historyIds);
    await evidence.supplyContext(maintenance.taskId, snapshotId, []);
    const job = await prepareCompactionJob(pool, {
      id, taskId: maintenance.taskId, mode: "background", snapshotId, groups: prefix, inputDigest: plan.inputDigest,
      historyIds, previous: continuity, manifest: await evidence.taskManifest(latest.id),
    });
    await event(pool, maintenance.taskId, `manual:${id}`, "context.compaction_requested", { mode: "manual", jobId: job.id, compactedGroups: prefix.length });
    await dispatchCompaction(options, job);
    return { id: job.id, taskId: job.taskId };
  } catch (error) {
    await settleTask(pool, maintenance.taskId, { state: "incomplete" }).catch(() => undefined);
    throw error;
  }
}

async function dispatchCompaction(options: ManualCompactionOptions, job: { id: string; taskId: string }): Promise<void> {
  const dispatch = options.dispatch ?? fetch;
  let response: Response;
  try {
    response = await dispatch(`${options.ingressUrl.replace(/\/$/, "")}/restate/send/${restateServiceName(CONTEXT_COMPACTION_WORKFLOW)}/${job.id}/run`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: job.id, taskId: job.taskId }), signal: AbortSignal.timeout(10_000),
    });
  } catch {
    await failCompactionJob(options.pool, job.id, job.taskId, "failed", "COMPACTION_DISPATCH_FAILED");
    throw new PlatformError("COMPACTION_DISPATCH_FAILED", 503, "Context compaction could not start.");
  }
  if (!response.ok) {
    await failCompactionJob(options.pool, job.id, job.taskId, "failed", "COMPACTION_DISPATCH_FAILED");
    throw new PlatformError("COMPACTION_DISPATCH_FAILED", 503, "Context compaction could not start.");
  }
}

export async function readManualCompactionJob(pool: Pool, scope: ManualCompactionScope, jobId: string): Promise<{ state: string; errorCode: string | null }> {
  const row = (await pool.query<{ state: string; error_code: string | null }>(
    `SELECT j.state,j.error_code FROM agents_platform.context_compaction_jobs j
     JOIN agents_platform.tasks t ON t.id=j.task_id
     JOIN agents_platform.conversations c ON c.id=t.conversation_id
     WHERE j.id=$1 AND t.conversation_id=$2 AND t.organization_id=$3 AND c.agent_id=$4 AND c.deleted_at IS NULL`,
    [jobId, scope.conversationId, scope.organizationId, scope.agentId])).rows[0];
  if (!row) throw new PlatformError("NOT_FOUND", 404, "Compaction job not found");
  return { state: row.state === "prepared" ? "pending" : row.state, errorCode: row.error_code };
}
