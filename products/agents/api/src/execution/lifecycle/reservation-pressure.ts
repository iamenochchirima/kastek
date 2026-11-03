import type { Pool } from "pg";
import { PlatformError, terminalTaskStates } from "../../contracts/contracts";
import { transaction } from "../../infrastructure/database";
import { loadExecution } from "./state";
import { delegationAncestors, subtreeUsage } from "../delegation/scope";
import { workUsage } from "./work-policy";

/** A failed admission has no operation to retry. Wait only for reservations that can still settle. */
export async function executionReservationPressure(pool: Pool, taskId: string, requiredTokens: number, requiredMs: number): Promise<boolean> {
  if (![requiredTokens, requiredMs].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new PlatformError("OPERATION_RESERVATION_INVALID", 400, "Invalid execution reservation");
  }
  return transaction(pool, async db => {
    const identity = (await db.query("SELECT organization_id,root_task_id FROM agents_platform.tasks WHERE id=$1", [taskId])).rows[0];
    if (!identity) return false;
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR SHARE", [identity.organization_id]);
    const root = (await db.query("SELECT settled_at FROM agents_platform.execution_roots WHERE root_task_id=$1 FOR SHARE", [identity.root_task_id])).rows[0];
    if (!root || root.settled_at) return false;
    const execution = await loadExecution(db, taskId), task = execution.task;
    if ((task.execution_policy_version ?? 1) < 2 || execution.models.primary.policy.revision === "model-execution-policy-v1" ||
        terminalTaskStates.has(task.state) || task.state === "cancel_requested" ||
        task.deadline_at !== null && new Date(task.deadline_at).getTime() <= Date.now()) return false;
    const child = Boolean(task.parent_task_id);
    const rootExecution = child ? await loadExecution(db, task.root_task_id) : execution;
    if (terminalTaskStates.has(rootExecution.task.state) || rootExecution.task.state === "cancel_requested") return false;
    const shared = rootExecution.models.primary.policy, local = execution.models.primary.policy;
    const usage = await workUsage(db, execution);
    const exhausted = (limit: number | null, used: number) => limit !== null && used >= limit;
    const sharedModelLimit = shared.maxRootModelCalls === null || !child ? shared.maxRootModelCalls : Math.max(0, shared.maxRootModelCalls - 1);
    if (exhausted(sharedModelLimit, usage.model_calls) ||
        exhausted(local.maxModelCalls, child ? task.model_calls : usage.coordinator_model_calls)) return false;

    const workId = task.work_id ?? task.root_task_id;
    const held = (await db.query(`SELECT
      coalesce(sum(r.tokens_reserved+r.child_reserved_tokens),0)::double precision AS tokens,
      coalesce(sum(r.active_reserved_ms+r.child_reserved_ms),0)::double precision AS active_ms
      FROM agents_platform.execution_roots r JOIN agents_platform.tasks t ON t.id=r.root_task_id WHERE t.work_id=$1`, [workId])).rows[0];
    const rollingTree=task.harness_release==="product-capabilities-v15";
    const prepaidTokens = !rollingTree && child && task.root_token_limit !== null, prepaidTime = !rollingTree && child && task.allocation_active_ms !== null;
    let pressure = false;
    const inspect = (limit: number | null, observed: number, reserved: number, required: number) => {
      if (limit === null) return true;
      if (observed + required > limit) return false;
      if (observed + reserved + required > limit) pressure = true;
      return true;
    };
    if(rollingTree)for(const ancestor of [execution,...await delegationAncestors(db,execution)]) {
      if(!ancestor.task.parent_task_id)continue;
      const subtree=await subtreeUsage(db,ancestor.task.id);
      if(!inspect(ancestor.task.root_token_limit,subtree.tokens,subtree.tokens_reserved,requiredTokens)||
         !inspect(ancestor.task.allocation_active_ms,subtree.active_ms,subtree.active_reserved_ms,requiredMs))return false;
    }
    if (child && (!inspect(task.root_token_limit, task.tokens_used, task.tokens_reserved, requiredTokens) ||
        !inspect(task.allocation_active_ms, task.active_ms, task.active_reserved_ms, requiredMs))) return false;
    if (!inspect(rootExecution.task.root_token_limit, usage.tokens - held.tokens, held.tokens, prepaidTokens ? 0 : requiredTokens) ||
        !inspect(shared.maxDurationMs, usage.active_ms - held.active_ms, held.active_ms, prepaidTime ? 0 : requiredMs)) return false;
    if (!pressure) return false;
    return Boolean((await db.query(`SELECT 1 FROM agents_platform.tasks t WHERE t.work_id=$1 AND (
      EXISTS(SELECT 1 FROM agents_platform.operations o WHERE o.task_id=t.id AND o.state='started'
        AND (o.reserved_tokens>0 OR o.reserved_ms>0)) OR
      (t.parent_task_id IS NOT NULL AND NOT t.allocation_released
        AND t.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain')
        AND (t.root_token_limit IS NOT NULL OR t.allocation_active_ms IS NOT NULL))) LIMIT 1`, [workId])).rowCount);
  });
}
