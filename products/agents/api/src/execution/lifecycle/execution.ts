import { delegationAncestors, subtreeUsage } from "../delegation/scope";
import { recordOrchestrationLifecycle } from "../../observability/orchestration-lifecycle";
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
import { instructionHead } from "../context/instruction-state";
import { quoteNormalizedUsage, reserveModelCost, settleModelCost } from "../models/accounting";
import { assertHandoffFeedbackAdmissionAuthority } from "./authority";
import { parseHandoffFeedbackRequest } from "./handoff-feedback-contract";
import { adjustOperationQuota, workUsage } from "./work-policy";
export async function event(db: Pool | PoolClient, taskId: string, key: string, kind: string, payload: object = {}): Promise<void> {
  await recordEvent(db, taskId, key, kind, payload);
}

async function taskIdentity(db:PoolClient,taskId:string):Promise<{organization_id:string;root_task_id:string}>{
  const task=(await db.query<{organization_id:string;root_task_id:string}>("SELECT organization_id,root_task_id FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];
  if(!task)throw new PlatformError("TASK_NOT_FOUND",404,"Task not found");
  return task;
}

export type OperationAdmission={waiting?:false;replayed:boolean;operation:OperationRecord;recovering?:boolean}|{waiting:true;replayed:false;capacity:Extract<CapacityDecision,{state:"waiting"}>};
export async function beginOperation(pool: Pool, taskId: string, input: OperationRequest): Promise<OperationAdmission> {
  return beginOperationForPurpose(pool,taskId,input,false);
}

export async function beginHandoffFeedbackOperation(pool: Pool, taskId: string, input: OperationRequest): Promise<OperationAdmission> {
  if (input.id !== `handoff-feedback:${taskId}` || input.kind !== "model" || input.name !== "model.handoff_feedback" ||
      !input.evidenceManifest || input.memoryFence || input.retrySafe || input.reconcile) {
    throw new PlatformError("HANDOFF_FEEDBACK_DENIED",403,"Handoff feedback is unavailable");
  }
  const request = parseHandoffFeedbackRequest(input.request);
  if (requestDigest(request.evidenceManifest) !== requestDigest(input.evidenceManifest) ||
      input.reservedTokens < request.modelRequest.maxInputTokens + request.modelRequest.maxOutputTokens ||
      input.reservedMs < request.modelRequest.maxDurationSeconds * 1000) {
    throw new PlatformError("HANDOFF_FEEDBACK_DENIED",403,"Handoff feedback is unavailable");
  }
  return beginOperationForPurpose(pool,taskId,input,true);
}

async function beginOperationForPurpose(pool: Pool, taskId: string, input: OperationRequest, handoffFeedback: boolean): Promise<OperationAdmission> {
  return transaction(pool, async db => {
    const preliminary = await taskIdentity(db, taskId);
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[preliminary.organization_id]);
    const budget = (await db.query("SELECT * FROM agents_platform.execution_roots WHERE root_task_id=$1 FOR UPDATE", [preliminary.root_task_id])).rows[0];
    if (!budget || budget.settled_at) throw new PlatformError("TASK_SETTLED",409,"Root execution has settled");
    const execution = await loadExecution(db, taskId, true), task = execution.task;
    if (task.execution_purpose === "support_status_v1" &&
      (input.id !== `support-status:${task.id}` || input.kind !== "model" || input.name !== "model.support_status" || input.retrySafe || input.reconcile)) {
      throw new PlatformError("SUPPORT_STATUS_DENIED",403,"Support status is unavailable");
    }
    if(task.execution_purpose === "support_status_v1") {
      const facts=await (await import("../../capabilities/support-status-v2")).supportStatusV2(db,task.organization_id,execution.configuration.supportHours);
      const request=await (await import("../business/support-status-request")).supportStatusRequestForEpisode(db,execution,facts);
      if(requestDigest(input.request)!==requestDigest({modelRequest:request,supportFacts:facts}) || input.evidenceManifest || input.memoryFence) {
        throw new PlatformError("SUPPORT_STATUS_DENIED",403,"Support status is unavailable");
      }
    }
    if (handoffFeedback) {
      const request = await assertHandoffFeedbackAdmissionAuthority(db,execution,input.id,input.request);
      const route=execution.models.primary;
      if (request.modelRequest.model !== route.binding.modelId || request.modelRequest.maxInputTokens > route.policy.maxInputTokens ||
          request.modelRequest.maxOutputTokens > route.policy.maxOutputTokens || request.modelRequest.maxDurationSeconds * 1000 > route.policy.maxCallDurationMs) {
        throw new PlatformError("HANDOFF_FEEDBACK_DENIED",403,"Handoff feedback is unavailable");
      }
      await (await import("../context/evidence-policy")).assertCurrentEvidence(db,taskId,request.evidenceManifest,{requireActiveTask:false});
    }
    const existing = (await db.query<OperationRecord & { request_digest: string }>("SELECT * FROM agents_platform.operations WHERE id=$1 FOR UPDATE", [input.id])).rows[0];
    if (existing) {
      if (existing.task_id !== taskId || existing.request_digest !== requestDigest(input.request)) throw new PlatformError("OPERATION_CONFLICT", 409, "Operation identity conflict");
      if (existing.state === "started") {
        if ((input.kind === "tool" || input.kind === "delegation" || input.kind === "resource" && input.name === "artifact.create") && input.retrySafe ||
            (input.kind === "resource" || input.kind === "tool") && input.reconcile) {
          await assertCurrentAuthority(db, execution);
          if (!input.reconcile && input.instructionHead !== undefined && input.instructionHead !== await instructionHead(db,taskId)) {
            // Admission alone cannot prove whether a previous attempt committed its effect.
            const fenced=await finishOperationInTransaction(db,execution,existing,"uncertain",null,"OPERATION_OUTCOME_UNCERTAIN",existing.reserved_tokens);
            await event(db,taskId,`retry-fenced:${input.id}`,"operation.retry_fenced",{operationId:input.id,reason:"CONTEXT_PREPARATION_STALE"});
            return {replayed:true,operation:fenced};
          }
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
          return { replayed: false, operation: {...existing,attempt_id:attemptId},recovering:input.kind==="tool"&&input.reconcile===true };
        }
        await finishOperationInTransaction(db, execution, existing, "uncertain", null, "OPERATION_OUTCOME_UNCERTAIN", existing.reserved_tokens);
        existing.state = "uncertain";
      }
      return { replayed: true, operation: existing };
    }
    if (!handoffFeedback) await assertCurrentAuthority(db, execution);
    if(input.instructionHead!==undefined && input.instructionHead!==await instructionHead(db,taskId))
      throw new PlatformError("CONTEXT_PREPARATION_STALE",409,"A newer instruction needs context preparation");
    if (String(execution.configuration.program.version)==="4" &&
        !["agents.status","agents.result","agents.wait","agents.cancel","work.inspect"].includes(input.name) &&
        (await db.query("SELECT 1 FROM agents_platform.tasks WHERE parent_task_id=$1 AND state='uncertain' LIMIT 1",[task.id])).rowCount) {
      throw new PlatformError("SPECIALIST_OUTCOME_UNCERTAIN",409,"Resolve the uncertain specialist outcome before continuing");
    }
    await checkMemoryFence(db, input.memoryFence);
    if (input.evidenceManifest && !handoffFeedback) await (await import("../context/evidence-policy")).assertCurrentEvidence(db, taskId, input.evidenceManifest);
    const model = input.kind === "model" || input.kind === "compaction";
    const rollingTree=task.harness_release==="product-capabilities-v15";
    const optionalBackground=rollingTree&&input.kind==="compaction"&&input.workload==="background";
    if(optionalBackground){
      const job=(await db.query("SELECT state,error_code FROM agents_platform.context_compaction_jobs WHERE id=$1 AND task_id=$2 AND mode='background'",[input.id,taskId])).rows[0];
      if(job&&job.state!=="prepared")throw new PlatformError(job.error_code??"COMPACTION_JOB_SETTLED",409,"The optional compaction job has settled");
    }
    const root = (await db.query("SELECT root_token_limit FROM agents_platform.tasks WHERE id=$1", [task.root_task_id])).rows[0];
    const child = Boolean(task.parent_task_id);
    const rootExecution = child ? await loadExecution(db, task.root_task_id) : execution;
    const rootPolicy = rootExecution.models.primary.policy;
    if (!Number.isSafeInteger(input.reservedTokens) || input.reservedTokens < 0 || !Number.isSafeInteger(input.reservedMs) || input.reservedMs < 0)
      throw new PlatformError("OPERATION_RESERVATION_INVALID",400,"Invalid execution reservation");
    const finiteExceeded=(limit:number|null|undefined,value:number)=>limit!==null&&limit!==undefined&&value>limit;
    const denied=(code:string,message:string):never=>{throw new PlatformError(code,429,message);};
    const modern=execution.models.primary.policy.revision!=="model-execution-policy-v1";
    const usage=modern ? await workUsage(db,execution) : {
      model_calls:budget.model_calls,tool_calls:budget.tool_calls,
      tokens:budget.tokens_used+budget.tokens_reserved+budget.child_reserved_tokens,
      active_ms:budget.active_ms+budget.active_reserved_ms+budget.child_reserved_ms,
      coordinator_model_calls:task.model_calls,coordinator_tool_calls:task.tool_calls,
    };
    if (task.execution_purpose === "support_status_v1" && budget.model_calls !== 0) denied("MODEL_CALL_LIMIT","The support status response is already generated");
    const localPolicy=execution.models.primary.policy;
    const primaryReserve=optionalBackground?(input.primaryReserve??{tokens:localPolicy.maxInputTokens+localPolicy.maxOutputTokens,activeMs:localPolicy.maxCallDurationMs}):{tokens:0,activeMs:0};
    if(optionalBackground&&(!Number.isSafeInteger(primaryReserve.tokens)||primaryReserve.tokens<localPolicy.maxOutputTokens||primaryReserve.tokens>localPolicy.maxInputTokens+localPolicy.maxOutputTokens||
      !Number.isSafeInteger(primaryReserve.activeMs)||primaryReserve.activeMs<1||primaryReserve.activeMs>localPolicy.maxCallDurationMs))
      throw new PlatformError("OPERATION_RESERVATION_INVALID",400,"Invalid foreground finishing reservation");
    const localCalls=child ? (model?task.model_calls:task.tool_calls) :
      (model?usage.coordinator_model_calls:usage.coordinator_tool_calls);
    if(modern && finiteExceeded(model?localPolicy.maxModelCalls:localPolicy.maxToolCalls,localCalls+1+(optionalBackground?1:0)))
      denied(model?"MODEL_CALL_LIMIT":"TOOL_CALL_LIMIT","The agent's explicit operation allowance is exhausted");
    const sharedLimit=model ? (modern?rootPolicy.maxRootModelCalls:rootPolicy.maxModelCalls) :
      (modern?rootPolicy.maxRootToolCalls:rootPolicy.maxToolCalls);
    const sharedCalls=model?usage.model_calls:usage.tool_calls;
    const finishingCalls=model?Number(child)+Number(optionalBackground):0;
    const permittedShared=finishingCalls&&sharedLimit!==null&&sharedLimit!==undefined?Math.max(0,sharedLimit-finishingCalls):sharedLimit;
    if(finiteExceeded(permittedShared,sharedCalls+1))
      denied(modern?(model?"ROOT_MODEL_CALL_LIMIT":"ROOT_TOOL_CALL_LIMIT"):"ROOT_LIMIT","The work's explicit operation allowance is exhausted");
    if(child && finiteExceeded(task.root_token_limit,task.tokens_used+task.tokens_reserved+input.reservedTokens+primaryReserve.tokens))
      denied(modern?"TASK_TOKEN_LIMIT":"ROOT_LIMIT","The specialist's token allowance is exhausted");
    if(child && finiteExceeded(task.allocation_active_ms,(task as any).active_ms+(task as any).active_reserved_ms+input.reservedMs+primaryReserve.activeMs))
      denied(modern?"TASK_DURATION_LIMIT":"ROOT_LIMIT","The specialist's active-time allowance is exhausted");
    if(rollingTree)for(const ancestor of [execution,...await delegationAncestors(db,execution)]) {
      if(!ancestor.task.parent_task_id)continue;
      const subtree=await subtreeUsage(db,ancestor.task.id);
      if(finiteExceeded(ancestor.task.root_token_limit,subtree.tokens+subtree.tokens_reserved+input.reservedTokens+primaryReserve.tokens))
        denied("TASK_TOKEN_LIMIT","The specialist subtree's token allowance is exhausted");
      if(finiteExceeded(ancestor.task.allocation_active_ms,subtree.active_ms+subtree.active_reserved_ms+input.reservedMs+primaryReserve.activeMs))
        denied("TASK_DURATION_LIMIT","The specialist subtree's active-time allowance is exhausted");
    }
    const directTokens=rollingTree||!child||task.root_token_limit===null;
    const directTime=rollingTree||!child||task.allocation_active_ms===null;
    if(finiteExceeded(root.root_token_limit,usage.tokens+(directTokens?input.reservedTokens:0)+primaryReserve.tokens))
      denied(modern?"ROOT_TOKEN_LIMIT":"ROOT_LIMIT","The work's token allowance cannot cover this operation");
    if(finiteExceeded(rootPolicy.maxDurationMs,usage.active_ms+(directTime?input.reservedMs:0)+primaryReserve.activeMs))
      denied(modern?"ROOT_DURATION_LIMIT":"ROOT_LIMIT","The work's active-time allowance cannot cover this operation");
    if(child && ((!directTokens && input.reservedTokens>budget.child_reserved_tokens) || (!directTime && input.reservedMs>budget.child_reserved_ms)))
      denied(modern?"SPECIALIST_ALLOCATION_LIMIT":"ROOT_LIMIT","The specialist's reserved allocation is exhausted");
    const {request,policy}=operationCapacity(execution,input);
    const capacity=await requestCapacity(db,request,policy);
    if(capacity.state==='waiting'){
      await event(db,taskId,`capacity-wait:${input.id}:${capacity.generation}`,"capacity.waiting",{operationId:input.id,workload:request.workload});
      if (handoffFeedback || task.execution_purpose === "support_status_v1") await releaseCapacity(db,capacity.requestId,"failed");
      return {waiting:true,replayed:false,capacity};
    }
    await activateCapacity(db,capacity.requestId,capacity.generation);
    if (model) {
      const route = execution.models[input.kind === "compaction" ? "compaction" : "primary"];
      try {
        await reserveModelCost(db, { organizationId: task.organization_id, rootTaskId: task.root_task_id, taskId, operationId: input.id,
          upperQuote: quoteNormalizedUsage({ inputTokens: route.policy.maxInputTokens, outputTokens: route.policy.maxOutputTokens,
            cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, route.model.pricing) });
      } catch { throw new PlatformError("MODEL_COST_LIMIT", 429, "The model cost allowance cannot cover this request"); }
    }
    await adjustOperationQuota(db,execution,input.reservedTokens);
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
    [task.root_task_id,input.reservedTokens,child&&!directTokens?input.reservedTokens:0,input.reservedMs,child&&!directTime?input.reservedMs:0,model?1:0,model?0:1]);
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
  state: "completed" | "failed" | "uncertain", output: unknown, errorCode: string | null, tokens: number): Promise<OperationRecord> {
  if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > 2147483647) throw new PlatformError("MODEL_USAGE_INVALID", 502, "Usage cannot be accounted");
  const accounted = tokens;
  const previousCharge=await db.query("SELECT 1 FROM agents_platform.operation_usage WHERE operation_id=$1",[op.id]);
  if(previousCharge.rowCount) return op;
  await adjustOperationQuota(db,execution,accounted-op.reserved_tokens);
  const charged = await db.query(`INSERT INTO agents_platform.operation_usage(operation_id,task_id,accounted_tokens,outcome)
    VALUES($1,$2,$3,$4) ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id`, [op.id, op.task_id, accounted, state]);
  if (!charged.rowCount) return op;
  if (op.kind === "model" || op.kind === "compaction") {
    const route = execution.models[op.kind === "compaction" ? "compaction" : "primary"];
    const usage = (output as { usage?: { observed?: boolean; inputTokens?: number; outputTokens?: number;
      cachedInputTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number } } | null)?.usage;
    const quote = state === "failed" && accounted === 0 ? { status: "known" as const, costMicros: 0n } :
      quoteNormalizedUsage(usage?.observed === true ? { inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null,
        cacheReadTokens: usage.cachedInputTokens ?? null, cacheWriteTokens: usage.cacheWriteTokens ?? null,
        reasoningTokens: usage.reasoningTokens ?? null } : null, route.model.pricing);
    await settleModelCost(db, { organizationId: execution.task.organization_id, rootTaskId: execution.task.root_task_id,
      taskId: execution.task.id, operationId: op.id, outcome: state, quote });
  }
  const elapsed = Math.max(0,Date.now()-new Date(op.started_at).getTime());
  const duration = state === "uncertain" ? Math.max(op.reserved_ms,elapsed) : elapsed;
  await db.query(`UPDATE agents_platform.operations SET state=$2,output=$3,error_code=$4,accounted_tokens=$5,completed_at=now() WHERE id=$1`,
    [op.id, state, output === undefined ? null : JSON.stringify(output), errorCode, accounted]);
  await db.query(`UPDATE agents_platform.tasks SET tokens_used=tokens_used+$2,tokens_reserved=tokens_reserved-$3,
    active_ms=active_ms+$4,active_reserved_ms=active_reserved_ms-$5,updated_at=now() WHERE id=$1`,
  [execution.task.id, accounted, op.reserved_tokens, duration, op.reserved_ms]);
  await db.query(`UPDATE agents_platform.execution_roots SET tokens_used=tokens_used+$2,tokens_reserved=tokens_reserved-$3,
    child_reserved_tokens=greatest(0,child_reserved_tokens+$4),active_ms=active_ms+$5,active_reserved_ms=active_reserved_ms-$6,
    child_reserved_ms=greatest(0,child_reserved_ms+$7) WHERE root_task_id=$1`,
  [execution.task.root_task_id,accounted,op.reserved_tokens,execution.task.harness_release!=="product-capabilities-v15"&&execution.task.parent_task_id&&execution.task.root_token_limit!==null?op.reserved_tokens-accounted:0,
    duration,op.reserved_ms,execution.task.harness_release!=="product-capabilities-v15"&&execution.task.parent_task_id&&execution.task.allocation_active_ms!==null?op.reserved_ms-duration:0]);
  await event(db, op.task_id, `result:${op.id}`, `operation.${state}`, { operationId: op.id, accountedTokens: accounted, errorCode });
  await releaseCapacity(db,op.id,state);
  return (await db.query<OperationRecord>('SELECT * FROM agents_platform.operations WHERE id=$1',[op.id])).rows[0]!;
}
export async function finishOperation(pool: Pool, taskId: string, operationId: string,
  state: "completed" | "failed" | "uncertain", output: unknown, errorCode: string | null, tokens: number,expectedAttemptId?:string): Promise<OperationRecord> {
  return transaction(pool, async db => {
    const before = await taskIdentity(db,taskId);
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[before.organization_id]);
    await db.query("SELECT root_task_id FROM agents_platform.execution_roots WHERE root_task_id=$1 FOR UPDATE",[before.root_task_id]);
    const execution = await loadExecution(db, taskId, true);
    const op = (await db.query<OperationRecord>("SELECT * FROM agents_platform.operations WHERE id=$1 AND task_id=$2 FOR UPDATE", [operationId, taskId])).rows[0];
    if (!op) throw new PlatformError("OPERATION_NOT_FOUND", 404, "Operation not found");
    if(expectedAttemptId&&op.attempt_id!==expectedAttemptId)return op;
    return finishOperationInTransaction(db, execution, op, state, output, errorCode, tokens);
  });
}

export async function settleTask(pool: Pool, taskId: string, requested: TaskOutcome): Promise<void> {
  await transaction(pool, async db => {
    const initial = await taskIdentity(db,taskId);
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[initial.organization_id]);
    await db.query("SELECT root_task_id FROM agents_platform.execution_roots WHERE root_task_id=$1 FOR UPDATE",[initial.root_task_id]);
    const execution = await loadExecution(db, taskId, true), task = execution.task;
    if (terminalTaskStates.has(task.state)) return;
    let outcome = requested;
    // A customer may already have been told this turn timed out while cancellation is
    // still in flight. Do not publish a late success after that deadline.
    if (task.channel_binding && !task.parent_task_id && outcome.state === "completed") {
      const {expired}=(await db.query<{expired:boolean}>("SELECT deadline_at IS NOT NULL AND deadline_at<=clock_timestamp() AS expired FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0]!;
      if(expired)outcome={state:"uncertain",errorCode:"TASK_DEADLINE"};
    }
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
    const children = (await db.query("SELECT id,state FROM agents_platform.tasks WHERE parent_task_id=$1 ORDER BY id FOR NO KEY UPDATE",[taskId])).rows;
    const activeChildren = children.filter(child=>!terminalTaskStates.has(child.state));
    const resources=(await db.query("SELECT id FROM agents_platform.sandbox_allocations WHERE root_task_id=$1 AND ($2::uuid IS NULL OR task_id=$2) AND state<>'destroyed'",[task.root_task_id,task.parent_task_id?taskId:null])).rows;
    const queryResources=(await db.query(`SELECT q.id FROM agents_platform.query_embedding_allocations q JOIN agents_platform.tasks t ON t.id=q.task_id
      WHERE t.root_task_id=$1 AND ($2::uuid IS NULL OR t.id=$2) AND q.state<>'destroyed'`,[task.root_task_id,task.parent_task_id?taskId:null])).rows;
    if (activeChildren.length || resources.length || queryResources.length) {
      await db.query("UPDATE agents_platform.tasks SET state='cancel_requested',pending_outcome=$2,disposition=$3,updated_at=now() WHERE id=$1",[taskId,JSON.stringify(outcome),activeChildren.length?'pending_children':'pending_resources']);
      for(const child of activeChildren)await requestTreeCancellationInTransaction(db,child.id);
      await event(db,taskId,`dependent-stop:${taskId}`,"children.stopping",{count:activeChildren.length});
      return;
    }
    if (children.some(child=>child.state==='uncertain') && outcome.state==='cancelled') outcome={state:'uncertain',errorCode:'CHILD_OUTCOME_UNCERTAIN'};
    const adaptive = execution.configuration.program.id === "tool-directed" && String(execution.configuration.program.version) === "4";
    if (adaptive && children.some(child=>child.state==='uncertain') && outcome.state==='completed') outcome={state:'uncertain',errorCode:'CHILD_OUTCOME_UNCERTAIN'};
    if (!adaptive && children.some(child=>child.state!=='completed') && outcome.state==='completed') outcome={...outcome,state:'incomplete',errorCode:'CHILD_PARTIAL_FAILURE'};
    await stopTaskCapacity(db,taskId);
    const operations = (await db.query<OperationRecord>("SELECT * FROM agents_platform.operations WHERE task_id=$1 AND state='started' FOR UPDATE", [taskId])).rows;
    for (const op of operations) await finishOperationInTransaction(db, execution, op, "uncertain", null, "OPERATION_INTERRUPTED", op.reserved_tokens);
    if (outcome.state === "cancelled" || (outcome.state === "uncertain" && outcome.errorCode === "OPERATION_OUTCOME_UNCERTAIN")) {
      const uncertain = (await db.query<Pick<OperationRecord,"kind">>("SELECT kind FROM agents_platform.operations WHERE task_id=$1 AND state='uncertain'",[taskId])).rows;
      if (uncertain.length) outcome = { state: "uncertain", errorCode: uncertain.every(op=>op.kind==="model" || op.kind==="compaction") ? "MODEL_OUTCOME_UNCERTAIN" : "OPERATION_OUTCOME_UNCERTAIN" };
    }
    if (task.parent_task_id) {
      const latest=(await db.query("SELECT tokens_used,active_ms,allocation_released FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];
      if(!latest.allocation_released && task.harness_release!=="product-capabilities-v15") {
        await db.query("UPDATE agents_platform.execution_roots SET child_reserved_tokens=child_reserved_tokens-$2,child_reserved_ms=child_reserved_ms-$3 WHERE root_task_id=$1",
          [task.root_task_id,task.root_token_limit===null?0:Math.max(0,task.root_token_limit-latest.tokens_used),task.allocation_active_ms===null?0:Math.max(0,task.allocation_active_ms-latest.active_ms)]);
        await db.query("UPDATE agents_platform.tasks SET allocation_released=true WHERE id=$1",[taskId]);
      }
      if(task.harness_release==="product-capabilities-v15")await db.query("UPDATE agents_platform.tasks SET allocation_released=true WHERE id=$1",[taskId]);
    } else {
      const reservation = (await db.query("SELECT * FROM agents_platform.usage_reservations WHERE task_id=$1 FOR UPDATE", [taskId])).rows[0];
      const total = (await db.query(`SELECT coalesce(sum(u.accounted_tokens),0)::double precision AS tokens FROM agents_platform.operation_usage u
        JOIN agents_platform.tasks t ON t.id=u.task_id WHERE t.root_task_id=$1`, [taskId])).rows[0].tokens;
      if(task.root_token_limit!==null && total>task.root_token_limit) throw new PlatformError("ROOT_ACCOUNTING_INVARIANT",500,"Root accounting exceeds its admitted allocation");
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
    if(task.channel_binding && !task.parent_task_id && task.execution_purpose!=="support_status_v1") await channelPorts(db).publishAutomated(db,
      {taskId,binding:task.channel_binding,output:outcome.output??""});
    await event(db, taskId, `terminal:${taskId}`, outcome.state);
    if(adaptive && !task.parent_task_id) {
      const terminal=(await db.query("SELECT created_at FROM agents_platform.task_events WHERE task_id=$1 AND event_key=$2",[taskId,`terminal:${taskId}`])).rows[0];
      await recordOrchestrationLifecycle(db,{organizationId:task.organization_id,key:taskId,
        action:outcome.errorCode==="ORCHESTRATION_STALLED"?"stalled":outcome.state==="completed"?"completed":"failed",outcome:outcome.state,
        specialistTasks:children.length,occurredAt:new Date(terminal.created_at).toISOString()});
    }
  });
}

export async function reconcilePendingRoots(pool:Pool):Promise<void> {
  const rows=(await pool.query(`SELECT r.id,r.pending_outcome FROM agents_platform.tasks r WHERE r.parent_task_id IS NULL AND r.pending_outcome IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM agents_platform.tasks c WHERE c.parent_task_id=r.id AND c.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain'))
    AND NOT EXISTS(SELECT 1 FROM agents_platform.sandbox_allocations a WHERE a.root_task_id=r.id AND a.state<>'destroyed')
    AND NOT EXISTS(SELECT 1 FROM agents_platform.query_embedding_allocations q JOIN agents_platform.tasks c ON c.id=q.task_id WHERE c.root_task_id=r.id AND q.state<>'destroyed') LIMIT 10`)).rows;
  const children=(await pool.query(`SELECT t.id,t.pending_outcome FROM agents_platform.tasks t WHERE t.parent_task_id IS NOT NULL AND t.pending_outcome IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM agents_platform.query_embedding_allocations q WHERE q.task_id=t.id AND q.state<>'destroyed')
    AND NOT EXISTS(SELECT 1 FROM agents_platform.sandbox_allocations a WHERE a.task_id=t.id AND a.state<>'destroyed')
    AND NOT EXISTS(SELECT 1 FROM agents_platform.tasks c WHERE c.parent_task_id=t.id AND c.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain')) ORDER BY t.depth DESC LIMIT 20`)).rows;
  for(const row of children) await settleTask(pool,row.id,row.pending_outcome);
  for(const row of rows) await settleTask(pool,row.id,row.pending_outcome);
}

export async function queueChildContinuations(pool:Pool,rootTaskId:string):Promise<void> {
  await transaction(pool,async db=>{
    const identity=await taskIdentity(db,rootTaskId);
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[identity.organization_id]);
    const root=await loadExecution(db,rootTaskId);
    if(terminalTaskStates.has(root.task.state)||root.task.state==="cancel_requested")return;
    await assertCurrentAuthority(db,root);
    const parentGrant=(await db.query("SELECT expires_at,operations FROM agents_platform.execution_grants WHERE id=$1 AND revoked_at IS NULL FOR SHARE",[root.task.grant_id])).rows[0];
    if(!parentGrant)return;
    const children=(await db.query("WITH RECURSIVE subtree AS (SELECT id FROM agents_platform.tasks WHERE parent_task_id=$1 UNION ALL SELECT t.id FROM agents_platform.tasks t JOIN subtree s ON t.parent_task_id=s.id) SELECT id FROM agents_platform.tasks WHERE id IN (SELECT id FROM subtree) AND state='waiting_authority' ORDER BY depth,id FOR NO KEY UPDATE",[rootTaskId])).rows;
    for(const child of children) {
      await db.query("SAVEPOINT child_authority_renewal");
      try {
        const execution=await loadExecution(db,child.id);
        const immediateParent=await loadExecution(db,execution.task.parent_task_id!);await assertCurrentAuthority(db,immediateParent);
        const immediateGrant=(await db.query("SELECT expires_at FROM agents_platform.execution_grants WHERE id=$1 AND revoked_at IS NULL FOR SHARE",[immediateParent.task.grant_id])).rows[0];
        if(!immediateGrant){await db.query("RELEASE SAVEPOINT child_authority_renewal");continue;}
        const priorControl=(await db.query("SELECT 1 FROM agents_platform.task_controls WHERE task_id=$1 AND generation=$2::bigint-1 AND kind='authority'",[child.id,execution.task.control_generation])).rowCount;
        const wait=(await db.query("SELECT event_key FROM agents_platform.task_events WHERE task_id=$1 AND kind='authority.required' ORDER BY sequence DESC LIMIT 1",[child.id])).rows[0];
        const alreadyQueued=Boolean(priorControl&&wait?.event_key!==`authority-wait:${execution.task.control_generation}`);
        const previous=(await db.query("SELECT * FROM agents_platform.execution_grants WHERE id=$1 AND organization_id=$2 FOR SHARE",[execution.task.grant_id,identity.organization_id])).rows[0];
        if(!previous||previous.revoked_at||alreadyQueued&&new Date(previous.expires_at).getTime()>Date.now()){await db.query("RELEASE SAVEPOINT child_authority_renewal");continue;}
        const expiry=Math.min(new Date(parentGrant.expires_at).getTime(),new Date(immediateGrant.expires_at).getTime(),
          root.task.deadline_at===null?Infinity:new Date(root.task.deadline_at).getTime(),
          execution.task.deadline_at===null?Infinity:new Date(execution.task.deadline_at).getTime());
        if(expiry<=Date.now()){await db.query("RELEASE SAVEPOINT child_authority_renewal");continue;}
        const id=randomUUID();
        const operations=previous.operations;
        await db.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,
          max_input_bytes,max_output_tokens,max_context_tokens,root_token_limit,expires_at,source_revision_ids,connected_tool_binding_ids)
          SELECT $2,product,organization_id,resource_id,caller_client_id,principal,version_id,$3::jsonb,
            max_input_bytes,max_output_tokens,max_context_tokens,root_token_limit,$4,source_revision_ids,connected_tool_binding_ids
          FROM agents_platform.execution_grants WHERE id=$1`,[previous.id,id,JSON.stringify(operations),new Date(expiry)]);
        await db.query("UPDATE agents_platform.tasks SET grant_id=$2 WHERE id=$1",[child.id,id]);
        await assertCurrentAuthority(db,await loadExecution(db,child.id));
        if(alreadyQueued) {
          await db.query("UPDATE agents_platform.task_controls SET dispatched_at=NULL,lease_owner=NULL,lease_until=NULL WHERE task_id=$1 AND generation=$2::bigint-1 AND kind='authority'",[child.id,execution.task.control_generation]);
        } else {
          const updated=(await db.query("UPDATE agents_platform.tasks SET control_generation=control_generation+1,updated_at=now() WHERE id=$1 AND state='waiting_authority' RETURNING control_generation-1 AS generation",[child.id])).rows[0];
          if(updated)await db.query("INSERT INTO agents_platform.task_controls(task_id,generation) VALUES($1,$2) ON CONFLICT DO NOTHING",[child.id,updated.generation]);
        }
        await db.query("RELEASE SAVEPOINT child_authority_renewal");
      } catch(error) {
        await db.query("ROLLBACK TO SAVEPOINT child_authority_renewal");
        await db.query("RELEASE SAVEPOINT child_authority_renewal");
        if(!(error instanceof PlatformError))throw error;
      }
    }
  });
}

/** Caller must hold the organization lock. Runtime dispatch still owns settlement and cleanup. */
export async function requestTreeCancellationInTransaction(db:PoolClient,taskId:string):Promise<string[]> {
  const rows=(await db.query(`WITH RECURSIVE subtree AS (
      SELECT id FROM agents_platform.tasks WHERE id=$1
      UNION ALL SELECT t.id FROM agents_platform.tasks t JOIN subtree s ON t.parent_task_id=s.id
    ) UPDATE agents_platform.tasks SET state='cancel_requested',updated_at=now()
    WHERE id IN (SELECT id FROM subtree) AND state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain','cancel_requested') RETURNING id`,[taskId])).rows;
  for(const row of rows) await event(db,row.id,`cancel-intent:${row.id}`,"cancel_requested",{requestedByTaskId:taskId});
  return rows.map(row=>row.id as string);
}
export async function requestTreeCancellation(pool:Pool,taskId:string):Promise<string[]> {
  return transaction(pool,async db=>{
    const execution=await loadExecution(db,taskId);
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[execution.task.organization_id]);
    return requestTreeCancellationInTransaction(db,taskId);
  });
}
