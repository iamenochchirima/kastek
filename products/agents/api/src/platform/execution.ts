import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { agentConfigurationSchema, executionGrantSchema, assertGrantAuthority, assertRuntimeAvailable,
  terminalTaskStates, assertTaskTransition, requestDigest, PlatformError, type AgentConfiguration, type TaskState } from "./contracts";
import type { TaskRecord } from "./store";

import {transaction} from "./database";
export {transaction} from "./database";

export const HARNESS_RELEASE = "core-harness-v1";
export const WORKFLOW_NAME = "AgentsBusinessRunV1";
export interface Execution { task: TaskRecord & { turn_sequence: string; history_cutoff: string | null;
  tokens_used: number; tokens_reserved: number; root_token_limit: number; model_calls: number; tool_calls: number;
  deadline_at: Date; harness_release: string; control_generation: string }; configuration: AgentConfiguration; agentId: string }
export interface MemoryFence { id: string; generation: number; expiresAt?: number }
export interface OperationRequest { id: string; kind: "model" | "compaction" | "tool"; name: string;
  request: unknown; reservedTokens: number; reservedMs: number; memoryFence?: MemoryFence; retrySafe?: boolean }
export interface OperationRecord { id: string; task_id: string; state: "started" | "completed" | "failed" | "uncertain";
  output: unknown; error_code: string | null; reserved_tokens: number; reserved_ms: number; accounted_tokens: number; started_at: Date }
export interface TaskOutcome { state: "completed" | "incomplete" | "refused" | "failed" | "cancelled" | "uncertain"; output?: string; errorCode?: string }

export async function event(db: Pool | PoolClient, taskId: string, key: string, kind: string, payload: object = {}): Promise<void> {
  await db.query(`INSERT INTO agents_platform.task_events(task_id,event_key,kind,payload) VALUES($1,$2,$3,$4)
    ON CONFLICT(task_id,event_key) DO NOTHING`, [taskId, key, kind, payload]);
}

export async function loadExecution(db: Pool | PoolClient, taskId: string, lock = false): Promise<Execution> {
  const task = (await db.query(`SELECT t.*,v.configuration,v.agent_id FROM agents_platform.tasks t
    JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.organization_id=t.organization_id
    WHERE t.id=$1 ${lock ? "FOR UPDATE OF t" : ""}`, [taskId])).rows[0];
  if (!task) throw new PlatformError("TASK_NOT_FOUND", 404, "Task not found");
  if (task.harness_release !== HARNESS_RELEASE) throw new PlatformError("HARNESS_RELEASE_UNAVAILABLE", 503, "Execution release is unavailable");
  const configuration = agentConfigurationSchema.parse(task.configuration); assertRuntimeAvailable(configuration);
  return { task, configuration, agentId: task.agent_id };
}

export async function assertCurrentAuthority(db: Pool | PoolClient, execution: Execution): Promise<void> {
  const { task, configuration, agentId } = execution;
  if (terminalTaskStates.has(task.state)) throw new PlatformError("TASK_SETTLED", 409, "Task has settled");
  if (task.state === "cancel_requested") throw new PlatformError("TASK_CANCELLED", 409, "Task is stopping");
  if (new Date(task.deadline_at).getTime() <= Date.now()) throw new PlatformError("TASK_DEADLINE", 409, "Task deadline reached");
  const conversation = (await db.query("SELECT deleted_at FROM agents_platform.conversations WHERE id=$1 FOR SHARE", [task.conversation_id])).rows[0];
  if (!conversation || conversation.deleted_at) throw new PlatformError("CONVERSATION_DELETED", 403, "Conversation is unavailable");
  const row = (await db.query("SELECT * FROM agents_platform.execution_grants WHERE id=$1 AND organization_id=$2 FOR SHARE",
    [task.grant_id, task.organization_id])).rows[0];
  if (!row || row.revoked_at) throw new PlatformError("GRANT_REVOKED", 403, "Execution access was revoked");
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new PlatformError("AUTHORITY_EXPIRED", 403, "Continue with current access");
  const grant = executionGrantSchema.parse({ id: row.id, product: row.product, principal: row.principal, operations: row.operations,
    organizationId: row.organization_id, resourceId: row.resource_id,
    callerClientId: row.caller_client_id, versionId: row.version_id, knowledgeIds: row.knowledge_ids,
    maxInputBytes: row.max_input_bytes, maxOutputTokens: row.max_output_tokens, maxContextTokens: row.max_context_tokens,
    rootTokenLimit: row.root_token_limit, expiresAt: row.expires_at.toISOString(), revokedAt: null });
  assertGrantAuthority(grant, { product: task.product, organizationId: task.organization_id,
    resourceId: task.resource_id, callerClientId: task.caller_client_id, principal: task.principal }, task.version_id, configuration);
  if (task.principal.kind === "human") {
    const allowed = await db.query(`SELECT 1 FROM agents_platform.memberships m JOIN agents_platform.accounts a ON a.id=m.account_id
      WHERE m.organization_id=$1 AND a.issuer=$2 AND a.subject=$3 AND m.revoked_at IS NULL FOR SHARE OF m`,
    [task.organization_id, task.principal.issuer, task.principal.subject]);
    if (!allowed.rowCount) throw new PlatformError("MEMBERSHIP_INACTIVE", 403, "Workspace access is unavailable");
  } else if (task.principal.kind === "visitor") {
    const allowed = await db.query(`SELECT 1 FROM agents_platform.website_deployments d JOIN agents_platform.website_sessions s ON s.deployment_id=d.id
      WHERE d.organization_id=$1 AND d.id=$2 AND d.version_id=$3 AND d.agent_id=$4 AND d.revoked_at IS NULL
      AND s.id=$5 AND s.expires_at>now() FOR SHARE OF d`,
    [task.organization_id, task.principal.deploymentId, task.version_id, agentId, task.principal.sessionId]);
    if (!allowed.rowCount || configuration.memory.enabled || configuration.skillIds.length || configuration.tools.some(t => t.startsWith("memory."))) {
      throw new PlatformError("DEPLOYMENT_SCOPE_DENIED", 403, "Website execution access is unavailable");
    }
  } else throw new PlatformError("AUTOMATION_UNAVAILABLE", 403, "Automation execution is unavailable");
}

export async function beginOperation(pool: Pool, taskId: string, input: OperationRequest): Promise<{ replayed: boolean; operation: OperationRecord }> {
  return transaction(pool, async db => {
    const preliminary = await loadExecution(db, taskId);
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [preliminary.task.organization_id]);
    const execution = await loadExecution(db, taskId, true), task = execution.task;
    const existing = (await db.query<OperationRecord & { request_digest: string }>("SELECT * FROM agents_platform.operations WHERE id=$1 FOR UPDATE", [input.id])).rows[0];
    if (existing) {
      if (existing.task_id !== taskId || existing.request_digest !== requestDigest(input.request)) throw new PlatformError("OPERATION_CONFLICT", 409, "Operation identity conflict");
      if (existing.state === "started") {
        if (input.kind === "tool" && input.retrySafe) {
          await assertCurrentAuthority(db, execution);
          try { await checkMemoryFence(db, input.memoryFence); }
          catch(error) {
            if (!(error instanceof PlatformError)) throw error;
            await finishOperationInTransaction(db,execution,existing,"uncertain",null,"OPERATION_OUTCOME_UNCERTAIN",existing.reserved_tokens);
            return {replayed:true,operation:{...existing,state:"uncertain",error_code:"OPERATION_OUTCOME_UNCERTAIN"}};
          }
          return { replayed: false, operation: existing };
        }
        await finishOperationInTransaction(db, execution, existing, "uncertain", null, "OPERATION_OUTCOME_UNCERTAIN", existing.reserved_tokens);
        existing.state = "uncertain";
      }
      return { replayed: true, operation: existing };
    }
    await assertCurrentAuthority(db, execution);
    await checkMemoryFence(db, input.memoryFence);
    const model = input.kind !== "tool";
    if (task.tokens_used + task.tokens_reserved + input.reservedTokens > task.root_token_limit ||
      (model ? task.model_calls >= 12 : task.tool_calls >= 24) ||
      (task as unknown as {active_ms:number;active_reserved_ms:number}).active_ms +
      (task as unknown as {active_reserved_ms:number}).active_reserved_ms + input.reservedMs > 900_000) {
      throw new PlatformError("ROOT_LIMIT", 429, "Task execution limit reached");
    }
    const slots = (await db.query(`SELECT count(*)::int AS count FROM agents_platform.operations o
      JOIN agents_platform.tasks t ON t.id=o.task_id WHERE t.organization_id=$1 AND o.state='started'
      AND ${model ? "o.kind IN ('model','compaction')" : "o.kind='tool'"}`, [task.organization_id])).rows[0].count;
    if (Number(slots) >= (model ? 2 : 4)) throw new PlatformError("PROVIDER_BUSY", 429, "Execution capacity is busy");
    const row = (await db.query<OperationRecord>(`INSERT INTO agents_platform.operations
      (id,task_id,kind,name,request_digest,request,state,reserved_tokens,reserved_ms,attempt_id)
      VALUES($1,$2,$3,$4,$5,$6,'started',$7,$8,$9) RETURNING *`,
    [input.id, taskId, input.kind, input.name, requestDigest(input.request), input.request, input.reservedTokens, input.reservedMs, randomUUID()])).rows[0]!;
    assertTaskTransition(task.state, "running");
    await db.query(`UPDATE agents_platform.tasks SET state='running',tokens_reserved=tokens_reserved+$2,
      active_reserved_ms=active_reserved_ms+$3,model_calls=model_calls+$4,tool_calls=tool_calls+$5,updated_at=now() WHERE id=$1`,
    [taskId, input.reservedTokens, input.reservedMs, model ? 1 : 0, model ? 0 : 1]);
    await event(db, taskId, `start:${input.id}`, "operation.started", { operationId: input.id, kind: input.kind, name: input.name });
    return { replayed: false, operation: row };
  });
}

async function checkMemoryFence(db: PoolClient, fence?: MemoryFence): Promise<void> {
  if (!fence) return;
  const ref = (await db.query("SELECT generation,next_expiry_at FROM agents_platform.memory_scopes WHERE id=$1 FOR SHARE", [fence.id])).rows[0];
  if (!ref || Number(ref.generation) !== fence.generation ||
    (ref.next_expiry_at && new Date(ref.next_expiry_at).getTime() <= Date.now()) ||
    (fence.expiresAt !== undefined && Date.now() >= fence.expiresAt)) {
    throw new PlatformError("CONTEXT_INVALIDATED", 409, "Memory changed before execution");
  }
}

async function finishOperationInTransaction(db: PoolClient, execution: Execution, op: OperationRecord,
  state: "completed" | "failed" | "uncertain", output: unknown, errorCode: string | null, tokens: number): Promise<void> {
  const accounted = Math.min(Math.max(0, tokens), op.reserved_tokens);
  const charged = await db.query(`INSERT INTO agents_platform.operation_usage(operation_id,task_id,accounted_tokens,outcome)
    VALUES($1,$2,$3,$4) ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id`, [op.id, op.task_id, accounted, state]);
  if (!charged.rowCount) return;
  const duration = state === "uncertain" ? op.reserved_ms : Math.min(op.reserved_ms, Math.max(0, Date.now() - new Date(op.started_at).getTime()));
  await db.query(`UPDATE agents_platform.operations SET state=$2,output=$3,error_code=$4,accounted_tokens=$5,completed_at=now() WHERE id=$1`,
    [op.id, state, output === undefined ? null : JSON.stringify(output), errorCode, accounted]);
  await db.query(`UPDATE agents_platform.tasks SET tokens_used=tokens_used+$2,tokens_reserved=tokens_reserved-$3,
    active_ms=active_ms+$4,active_reserved_ms=active_reserved_ms-$5,updated_at=now() WHERE id=$1`,
  [execution.task.id, accounted, op.reserved_tokens, duration, op.reserved_ms]);
  await event(db, op.task_id, `result:${op.id}`, `operation.${state}`, { operationId: op.id, accountedTokens: accounted, errorCode });
}
export async function finishOperation(pool: Pool, taskId: string, operationId: string,
  state: "completed" | "failed" | "uncertain", output: unknown, errorCode: string | null, tokens: number): Promise<void> {
  await transaction(pool, async db => {
    const execution = await loadExecution(db, taskId, true);
    const op = (await db.query<OperationRecord>("SELECT * FROM agents_platform.operations WHERE id=$1 AND task_id=$2 FOR UPDATE", [operationId, taskId])).rows[0];
    if (!op) throw new PlatformError("OPERATION_NOT_FOUND", 404, "Operation not found");
    await finishOperationInTransaction(db, execution, op, state, output, errorCode, tokens);
  });
}

export async function settleTask(pool: Pool, taskId: string, outcome: TaskOutcome): Promise<void> {
  await transaction(pool, async db => {
    const execution = await loadExecution(db, taskId, true), task = execution.task;
    if (terminalTaskStates.has(task.state)) return;
    const operations = (await db.query<OperationRecord>("SELECT * FROM agents_platform.operations WHERE task_id=$1 AND state='started' FOR UPDATE", [taskId])).rows;
    for (const op of operations) await finishOperationInTransaction(db, execution, op, "uncertain", null, "OPERATION_INTERRUPTED", op.reserved_tokens);
    if (operations.length && outcome.state === "cancelled") outcome = { state: "uncertain", errorCode: "OPERATION_OUTCOME_UNCERTAIN" };
    const reservation = (await db.query("SELECT * FROM agents_platform.usage_reservations WHERE task_id=$1 FOR UPDATE", [taskId])).rows[0];
    const total = (await db.query("SELECT coalesce(sum(accounted_tokens),0)::int AS tokens FROM agents_platform.operation_usage WHERE task_id=$1", [taskId])).rows[0].tokens;
    if (reservation && !reservation.settled_at) {
      await db.query(`UPDATE agents_platform.usage_accounts SET reserved_tokens=reserved_tokens-$3,consumed_tokens=consumed_tokens+$4
        WHERE organization_id=$1 AND day=$2`, [reservation.organization_id, reservation.day, reservation.tokens, Math.min(total, reservation.tokens)]);
      await db.query("UPDATE agents_platform.usage_reservations SET settled_at=now() WHERE task_id=$1", [taskId]);
    }
    await db.query(`INSERT INTO agents_platform.usage_ledger(task_id,operation_id,accounted_tokens,outcome) VALUES($1,$2,$3,$4) ON CONFLICT(task_id) DO NOTHING`,
      [taskId, `root:${taskId}`, total, outcome.state]);
    assertTaskTransition(task.state, outcome.state);
    await db.query("UPDATE agents_platform.tasks SET state=$2,output=$3,error_code=$4,updated_at=now() WHERE id=$1",
      [taskId, outcome.state, outcome.output ?? null, outcome.errorCode ?? null]);
    await event(db, taskId, `terminal:${taskId}`, outcome.state);
  });
}
