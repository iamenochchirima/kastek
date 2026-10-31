import type { Pool, PoolClient } from "pg";
import { PlatformError } from "../../contracts/contracts";
import type { Execution } from "../../contracts/execution";

export async function workUsage(db: Pool | PoolClient, execution: Execution) {
  const workId=execution.task.work_id ?? execution.task.root_task_id;
  const row=(await db.query(`SELECT
    coalesce(sum(r.model_calls),0)::double precision AS model_calls,
    coalesce(sum(r.tool_calls),0)::double precision AS tool_calls,
    coalesce(sum(r.tokens_used+r.tokens_reserved+r.child_reserved_tokens),0)::double precision AS tokens,
    coalesce(sum(r.active_ms+r.active_reserved_ms+r.child_reserved_ms),0)::double precision AS active_ms,
    coalesce(sum(t.model_calls),0)::double precision AS coordinator_model_calls,
    coalesce(sum(t.tool_calls),0)::double precision AS coordinator_tool_calls
    FROM agents_platform.tasks t JOIN agents_platform.execution_roots r ON r.root_task_id=t.id
    WHERE t.work_id=$1 AND t.parent_task_id IS NULL`,[workId])).rows[0];
  for(const value of Object.values(row)) if(!Number.isSafeInteger(value))
    throw new PlatformError("ACCOUNTING_RANGE",500,"Execution usage is outside the supported accounting range");
  return row as {model_calls:number;tool_calls:number;tokens:number;active_ms:number;coordinator_model_calls:number;coordinator_tool_calls:number};
}

/** Model guidance is a snapshot; atomic admission remains the authority for every operation. */
export async function executionAllowanceObservation(db:Pool|PoolClient,execution:Execution) {
  if((execution.task.execution_policy_version??1)<2)return null;
  const usage=await workUsage(db,execution),local=execution.models.primary.policy;
  const rootId=execution.task.root_task_id;
  const route=execution.task.parent_task_id
    ? (await import("./state")).loadExecution(db,rootId).then(value=>value.models.primary.policy)
    : Promise.resolve(local);
  const shared=await route;
  const remaining:Record<string,number>={};
  const add=(name:string,limit:number|null,used:number)=>{if(limit!==null)remaining[name]=Math.max(0,limit-used);};
  add("agentModelCalls",local.maxModelCalls,execution.task.parent_task_id?execution.task.model_calls:usage.coordinator_model_calls);
  add("agentToolCalls",local.maxToolCalls,execution.task.parent_task_id?execution.task.tool_calls:usage.coordinator_tool_calls);
  add("workModelCalls",shared.maxRootModelCalls,usage.model_calls);
  add("workToolCalls",shared.maxRootToolCalls,usage.tool_calls);
  add("workTokens",shared.maxRootTokens,usage.tokens);
  add("workActiveMs",shared.maxDurationMs,usage.active_ms);
  return Object.keys(remaining).length?remaining:null;
}

/** Null-root work reserves bounded physical requests against its existing admission-day account. */
export async function adjustOperationQuota(db: PoolClient, execution: Execution, delta: number) {
  const root=(await db.query("SELECT root_token_limit FROM agents_platform.tasks WHERE id=$1",[execution.task.root_task_id])).rows[0];
  if(root.root_token_limit!==null || delta===0) return;
  const reservation=(await db.query("SELECT * FROM agents_platform.usage_reservations WHERE task_id=$1 FOR UPDATE",[execution.task.root_task_id])).rows[0];
  if(!reservation || reservation.settled_at) throw new PlatformError("TASK_SETTLED",409,"Execution accounting has settled");
  const updated=await db.query(`UPDATE agents_platform.usage_accounts SET reserved_tokens=reserved_tokens+$3
    WHERE organization_id=$1 AND day=$2 AND reserved_tokens+$3>=0
      AND reserved_tokens+consumed_tokens+$3<=token_allowance RETURNING organization_id`,
    [reservation.organization_id,reservation.day,delta]);
  if(!updated.rowCount) throw new PlatformError("QUOTA_EXCEEDED",429,"The organization usage allowance is exhausted");
  await db.query("UPDATE agents_platform.usage_reservations SET tokens=tokens+$2 WHERE task_id=$1",[execution.task.root_task_id,delta]);
}
