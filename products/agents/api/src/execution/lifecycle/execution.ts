import {requestCapacity,activateCapacity,releaseCapacity,stopTaskCapacity,type CapacityDecision} from "../scheduling/capacity";
import {operationCapacity} from "../scheduling/policy";
import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import {
assertTaskTransition,
PlatformError,
requestDigest,
terminalTaskStates
} from "../../contracts/contracts";

import { transaction } from "../../infrastructure/database";
import { recordEvent } from "../../observability/event-store";
import { channelPorts } from "../../infrastructure/channel-ports";
export { HARNESS_RELEASE,WORKFLOW_NAME,type Execution,type MemoryFence,type OperationRecord,type OperationRequest,type TaskOutcome } from "../../contracts/execution";
export { transaction } from "../../infrastructure/database";
export { assertCurrentAuthority } from "../context/evidence-policy";
export { loadExecution } from "./state";

import { type Execution,type MemoryFence,type OperationRecord,type OperationRequest,type TaskOutcome } from "../../contracts/execution";
import { assertCurrentAuthority } from "../context/evidence-policy";
import { loadExecution } from "./state";
export async function event(db: Pool | PoolClient, taskId: string, key: string, kind: string, payload: object = {}): Promise<void> {
  await recordEvent(db, taskId, key, kind, payload);
}

export type OperationAdmission={waiting?:false;replayed:boolean;operation:OperationRecord}|{waiting:true;replayed:false;capacity:Extract<CapacityDecision,{state:"waiting"}>};
export async function beginOperation(pool: Pool, taskId: string, input: OperationRequest): Promise<OperationAdmission> {
  return transaction(pool, async db => {
    const preliminary = await loadExecution(db, taskId);
    const budget = (await db.query("SELECT * FROM agents_platform.execution_roots WHERE root_task_id=$1 FOR UPDATE", [preliminary.task.root_task_id])).rows[0];
    if (!budget || budget.settled_at) throw new PlatformError("TASK_SETTLED",409,"Root execution has settled");
    const execution = await loadExecution(db, taskId, true), task = execution.task;
    const existing = (await db.query<OperationRecord & { request_digest: string }>("SELECT * FROM agents_platform.operations WHERE id=$1 FOR UPDATE", [input.id])).rows[0];
    if (existing) {
      if (existing.task_id !== taskId || existing.request_digest !== requestDigest(input.request)) throw new PlatformError("OPERATION_CONFLICT", 409, "Operation identity conflict");
      if (existing.state === "started") {
        if ((input.kind === "tool" || input.kind === "delegation") && input.retrySafe || input.kind === "resource" && input.reconcile) {
          await assertCurrentAuthority(db, execution);
          try {
            await checkMemoryFence(db, input.memoryFence);
            if (input.evidenceManifest) await (await import("../context/evidence-policy")).assertCurrentEvidence(db, taskId, input.evidenceManifest);
          }
          catch(error) {
            if (!(error instanceof PlatformError)) throw error;
            await finishOperationInTransaction(db,execution,existing,"uncertain",null,"OPERATION_OUTCOME_UNCERTAIN",existing.reserved_tokens);
            return {replayed:true,operation:{...existing,state:"uncertain",error_code:"OPERATION_OUTCOME_UNCERTAIN"}};
          }
          const attemptId=randomUUID();
          await db.query("UPDATE agents_platform.operations SET attempt_id=$2 WHERE id=$1", [existing.id,attemptId]);
          await event(db, taskId, `attempt:${input.id}:${attemptId}`, "operation.retried", {operationId:input.id});
          return { replayed: false, operation: existing };
        }
        await finishOperationInTransaction(db, execution, existing, "uncertain", null, "OPERATION_OUTCOME_UNCERTAIN", existing.reserved_tokens);
        existing.state = "uncertain";
      }
      return { replayed: true, operation: existing };
    }
    await assertCurrentAuthority(db, execution);
    await checkMemoryFence(db, input.memoryFence);
    if (input.evidenceManifest) await (await import("../context/evidence-policy")).assertCurrentEvidence(db, taskId, input.evidenceManifest);
    const model = input.kind === "model" || input.kind === "compaction";
    const root = (await db.query("SELECT root_token_limit FROM agents_platform.tasks WHERE id=$1", [task.root_task_id])).rows[0];
    const child = Boolean(task.parent_task_id);
    if (!Number.isSafeInteger(input.reservedTokens) || input.reservedTokens < 0 || !Number.isSafeInteger(input.reservedMs) || input.reservedMs < 0 ||
      task.tokens_used + task.tokens_reserved + input.reservedTokens > task.root_token_limit ||
      (model ? budget.model_calls >= (child ? 11 : 12) : budget.tool_calls >= 24) ||
      (child && ((task as any).active_ms + (task as any).active_reserved_ms + input.reservedMs > task.allocation_active_ms)) ||
      (!child && (budget.tokens_used + budget.tokens_reserved + budget.child_reserved_tokens + input.reservedTokens > root.root_token_limit ||
        budget.active_ms + budget.active_reserved_ms + budget.child_reserved_ms + input.reservedMs > 900_000)) ||
      (child && (input.reservedTokens > budget.child_reserved_tokens || input.reservedMs > budget.child_reserved_ms))) {
      throw new PlatformError("ROOT_LIMIT", 429, "Task execution limit reached");
    }
    const {request,policy}=operationCapacity(execution,input);
    const capacity=await requestCapacity(db,request,policy);
    if(capacity.state==='waiting'){
      await event(db,taskId,`capacity-wait:${input.id}:${capacity.generation}`,"capacity.waiting",{operationId:input.id,workload:request.workload});
      return {waiting:true,replayed:false,capacity};
    }
    await activateCapacity(db,capacity.requestId,capacity.generation);
    const row = (await db.query<OperationRecord>(`INSERT INTO agents_platform.operations
      (id,task_id,kind,name,request_digest,request,state,reserved_tokens,reserved_ms,attempt_id)
      VALUES($1,$2,$3,$4,$5,$6,'started',$7,$8,$9) RETURNING *`,
    [input.id, taskId, input.kind, input.name, requestDigest(input.request), input.request, input.reservedTokens, input.reservedMs, randomUUID()])).rows[0]!;
    assertTaskTransition(task.state, "running");
    await db.query(`UPDATE agents_platform.tasks SET state='running',tokens_reserved=tokens_reserved+$2,
      active_reserved_ms=active_reserved_ms+$3,model_calls=model_calls+$4,tool_calls=tool_calls+$5,updated_at=now() WHERE id=$1`,
    [taskId, input.reservedTokens, input.reservedMs, model ? 1 : 0, model ? 0 : 1]);
    await db.query(`UPDATE agents_platform.execution_roots SET tokens_reserved=tokens_reserved+$2,
      child_reserved_tokens=child_reserved_tokens-$3,active_reserved_ms=active_reserved_ms+$4,child_reserved_ms=child_reserved_ms-$5,
      model_calls=model_calls+$6,tool_calls=tool_calls+$7 WHERE root_task_id=$1`,
    [task.root_task_id,input.reservedTokens,child?input.reservedTokens:0,input.reservedMs,child?input.reservedMs:0,model?1:0,model?0:1]);
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
  await releaseCapacity(db,op.id,state);
  const elapsed = Math.max(0,Date.now()-new Date(op.started_at).getTime());
  const duration = state === "uncertain" ? Math.max(op.reserved_ms,elapsed) : elapsed;
  await db.query(`UPDATE agents_platform.operations SET state=$2,output=$3,error_code=$4,accounted_tokens=$5,completed_at=now() WHERE id=$1`,
    [op.id, state, output === undefined ? null : JSON.stringify(output), errorCode, accounted]);
  await db.query(`UPDATE agents_platform.tasks SET tokens_used=tokens_used+$2,tokens_reserved=tokens_reserved-$3,
    active_ms=active_ms+$4,active_reserved_ms=active_reserved_ms-$5,updated_at=now() WHERE id=$1`,
  [execution.task.id, accounted, op.reserved_tokens, duration, op.reserved_ms]);
  await db.query(`UPDATE agents_platform.execution_roots SET tokens_used=tokens_used+$2,tokens_reserved=tokens_reserved-$3,
    child_reserved_tokens=child_reserved_tokens+$4,active_ms=active_ms+$5,active_reserved_ms=active_reserved_ms-$6,
    child_reserved_ms=greatest(0,child_reserved_ms+$7) WHERE root_task_id=$1`,
  [execution.task.root_task_id,accounted,op.reserved_tokens,execution.task.parent_task_id?op.reserved_tokens-accounted:0,
    duration,op.reserved_ms,execution.task.parent_task_id?op.reserved_ms-duration:0]);
  await event(db, op.task_id, `result:${op.id}`, `operation.${state}`, { operationId: op.id, accountedTokens: accounted, errorCode });
}
export async function finishOperation(pool: Pool, taskId: string, operationId: string,
  state: "completed" | "failed" | "uncertain", output: unknown, errorCode: string | null, tokens: number): Promise<void> {
  await transaction(pool, async db => {
    const before = await loadExecution(db,taskId);
    await db.query("SELECT root_task_id FROM agents_platform.execution_roots WHERE root_task_id=$1 FOR UPDATE",[before.task.root_task_id]);
    const execution = await loadExecution(db, taskId, true);
    const op = (await db.query<OperationRecord>("SELECT * FROM agents_platform.operations WHERE id=$1 AND task_id=$2 FOR UPDATE", [operationId, taskId])).rows[0];
    if (!op) throw new PlatformError("OPERATION_NOT_FOUND", 404, "Operation not found");
    await finishOperationInTransaction(db, execution, op, state, output, errorCode, tokens);
  });
}

export async function settleTask(pool: Pool, taskId: string, requested: TaskOutcome): Promise<void> {
  await transaction(pool, async db => {
    const initial = await loadExecution(db,taskId);
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[initial.task.organization_id]);
    await db.query("SELECT root_task_id FROM agents_platform.execution_roots WHERE root_task_id=$1 FOR UPDATE",[initial.task.root_task_id]);
    const execution = await loadExecution(db, taskId, true), task = execution.task;
    if (terminalTaskStates.has(task.state)) return;
    let outcome = requested;
    if (task.pending_outcome && (await db.query("SELECT 1 FROM agents_platform.task_events WHERE task_id=$1 AND kind='cancel_requested'",[taskId])).rowCount) {
      outcome={state:"cancelled"};
    }
    if (outcome.output) {
      try {
        const {assertCurrentEvidence,taskEvidenceManifest}=await import("../context/evidence-policy");
        const nodes=(await db.query("SELECT manifest FROM agents_platform.evidence_nodes WHERE task_id=$1",[taskId])).rows;
        if(nodes.length||task.parent_task_id) await assertCurrentEvidence(db,taskId,await taskEvidenceManifest(db,taskId),{requireActiveTask:!task.pending_outcome});
      } catch(error) {
        if(!(error instanceof PlatformError)) throw error;
        const delivered=(await db.query("SELECT 1 FROM agents_platform.actions WHERE root_task_id=$1 AND state='delivered'",[task.root_task_id])).rowCount;
        outcome=delivered && outcome.state==="completed" ? {state:"completed"} : {state:"incomplete",errorCode:error.code};
      }
    }
    const children = !task.parent_task_id ? (await db.query("SELECT id,state FROM agents_platform.tasks WHERE parent_task_id=$1 ORDER BY id FOR UPDATE",[taskId])).rows : [];
    const activeChildren = children.filter(child=>!terminalTaskStates.has(child.state));
    const resources=!task.parent_task_id?(await db.query("SELECT id FROM agents_platform.sandbox_allocations WHERE root_task_id=$1 AND state<>'destroyed'",[taskId])).rows:[];
    const queryResources=(await db.query(`SELECT q.id FROM agents_platform.query_embedding_allocations q JOIN agents_platform.tasks t ON t.id=q.task_id
      WHERE t.root_task_id=$1 AND ($2::uuid IS NULL OR t.id=$2) AND q.state<>'destroyed'`,[task.root_task_id,task.parent_task_id?taskId:null])).rows;
    if (activeChildren.length || resources.length || queryResources.length) {
      await db.query("UPDATE agents_platform.tasks SET state='cancel_requested',pending_outcome=$2,disposition=$3,updated_at=now() WHERE id=$1",[taskId,JSON.stringify(outcome),activeChildren.length?'pending_children':'pending_resources']);
      await db.query("UPDATE agents_platform.tasks SET state='cancel_requested',updated_at=now() WHERE id=ANY($1::uuid[]) AND state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain')",[activeChildren.map(child=>child.id)]);
      await event(db,taskId,`dependent-stop:${taskId}`,"children.stopping",{count:activeChildren.length});
      return;
    }
    if (children.some(child=>child.state==='uncertain') && outcome.state==='cancelled') outcome={state:'uncertain',errorCode:'CHILD_OUTCOME_UNCERTAIN'};
    if (children.some(child=>child.state!=='completed') && outcome.state==='completed') outcome={...outcome,state:'incomplete',errorCode:'CHILD_PARTIAL_FAILURE'};
    await stopTaskCapacity(db,taskId);
    const operations = (await db.query<OperationRecord>("SELECT * FROM agents_platform.operations WHERE task_id=$1 AND state='started' FOR UPDATE", [taskId])).rows;
    for (const op of operations) await finishOperationInTransaction(db, execution, op, "uncertain", null, "OPERATION_INTERRUPTED", op.reserved_tokens);
    if (operations.length && outcome.state === "cancelled") outcome = { state: "uncertain", errorCode: "OPERATION_OUTCOME_UNCERTAIN" };
    if (task.parent_task_id) {
      const latest=(await db.query("SELECT tokens_used,active_ms,allocation_released FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];
      if(!latest.allocation_released) {
        await db.query("UPDATE agents_platform.execution_roots SET child_reserved_tokens=child_reserved_tokens-$2,child_reserved_ms=child_reserved_ms-$3 WHERE root_task_id=$1",
          [task.root_task_id,task.root_token_limit-latest.tokens_used,Math.max(0,task.allocation_active_ms-latest.active_ms)]);
        await db.query("UPDATE agents_platform.tasks SET allocation_released=true WHERE id=$1",[taskId]);
      }
    } else {
      const reservation = (await db.query("SELECT * FROM agents_platform.usage_reservations WHERE task_id=$1 FOR UPDATE", [taskId])).rows[0];
      const total = (await db.query(`SELECT coalesce(sum(u.accounted_tokens),0)::int AS tokens FROM agents_platform.operation_usage u
        JOIN agents_platform.tasks t ON t.id=u.task_id WHERE t.root_task_id=$1`, [taskId])).rows[0].tokens;
      if(total>task.root_token_limit) throw new PlatformError("ROOT_ACCOUNTING_INVARIANT",500,"Root accounting exceeds its admitted allocation");
      if (reservation && !reservation.settled_at) {
        await db.query(`UPDATE agents_platform.usage_accounts SET reserved_tokens=reserved_tokens-$3,consumed_tokens=consumed_tokens+$4
          WHERE organization_id=$1 AND day=$2`, [reservation.organization_id, reservation.day, reservation.tokens,total]);
        await db.query("UPDATE agents_platform.usage_reservations SET settled_at=now() WHERE task_id=$1", [taskId]);
      }
      await db.query(`INSERT INTO agents_platform.usage_ledger(task_id,operation_id,accounted_tokens,outcome) VALUES($1,$2,$3,$4) ON CONFLICT(task_id) DO NOTHING`,
        [taskId, `root:${taskId}`, total, outcome.state]);
      await db.query("UPDATE agents_platform.execution_roots SET settled_at=now() WHERE root_task_id=$1",[taskId]);
    }
    assertTaskTransition(task.state, outcome.state);
    await db.query("UPDATE agents_platform.tasks SET state=$2,output=$3,error_code=$4,pending_outcome=NULL,disposition='settled',updated_at=now() WHERE id=$1",
      [taskId, outcome.state, outcome.output ?? null, outcome.errorCode ?? null]);
    if(task.channel_binding && !task.parent_task_id) await channelPorts(db).publishAutomated(db,
      {taskId,binding:task.channel_binding,output:outcome.output??""});
    await event(db, taskId, `terminal:${taskId}`, outcome.state);
  });
}

export async function reconcilePendingRoots(pool:Pool):Promise<void> {
  const rows=(await pool.query(`SELECT r.id,r.pending_outcome FROM agents_platform.tasks r WHERE r.parent_task_id IS NULL AND r.pending_outcome IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM agents_platform.tasks c WHERE c.parent_task_id=r.id AND c.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain'))
    AND NOT EXISTS(SELECT 1 FROM agents_platform.sandbox_allocations a WHERE a.root_task_id=r.id AND a.state<>'destroyed')
    AND NOT EXISTS(SELECT 1 FROM agents_platform.query_embedding_allocations q JOIN agents_platform.tasks c ON c.id=q.task_id WHERE c.root_task_id=r.id AND q.state<>'destroyed') LIMIT 10`)).rows;
  const children=(await pool.query(`SELECT t.id,t.pending_outcome FROM agents_platform.tasks t WHERE t.parent_task_id IS NOT NULL AND t.pending_outcome IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM agents_platform.query_embedding_allocations q WHERE q.task_id=t.id AND q.state<>'destroyed') LIMIT 20`)).rows;
  for(const row of children) await settleTask(pool,row.id,row.pending_outcome);
  for(const row of rows) await settleTask(pool,row.id,row.pending_outcome);
}

export async function queueChildContinuations(pool:Pool,rootTaskId:string):Promise<void> {
  await transaction(pool,async db=>{
    const rows=(await db.query("UPDATE agents_platform.tasks SET control_generation=control_generation+1 WHERE root_task_id=$1 AND parent_task_id IS NOT NULL AND state='waiting_authority' RETURNING id,control_generation-1 AS generation",[rootTaskId])).rows;
    for(const row of rows) await db.query("INSERT INTO agents_platform.task_controls(task_id,generation) VALUES($1,$2) ON CONFLICT DO NOTHING",[row.id,row.generation]);
  });
}

export async function requestTreeCancellation(pool:Pool,taskId:string):Promise<string[]> {
  return transaction(pool,async db=>{
    const execution=await loadExecution(db,taskId);
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[execution.task.organization_id]);
    const rows=(await db.query(`UPDATE agents_platform.tasks SET state='cancel_requested',updated_at=now()
      WHERE (id=$1 OR parent_task_id=$1) AND state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain') RETURNING id`,[taskId])).rows;
    for(const row of rows) await event(db,row.id,`cancel-intent:${row.id}`,"cancel_requested",{requestedByTaskId:taskId});
    return rows.map(row=>row.id as string);
  });
}
