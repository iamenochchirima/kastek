import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { HARNESS_RELEASE } from "../../contracts/execution";

export const dispatchPolicySchema = z.strictObject({
  batchSize:z.number().int().min(1).max(128).default(32),
  parallelism:z.number().int().min(1).max(32).default(8),
  leaseMs:z.number().int().min(30_000).max(300_000).default(120_000),
});
export type DispatchPolicy = z.infer<typeof dispatchPolicySchema>;
export function dispatchPolicyFromEnvironment(environment:NodeJS.ProcessEnv=process.env):DispatchPolicy {
 try {
  const raw=environment.AGENTS_DISPATCH_POLICY_JSON;
  const value:unknown=raw===undefined?{}:JSON.parse(raw);
  if(value!==null&&typeof value==="object"&&Object.keys(value).some(key=>!Object.hasOwn(dispatchPolicySchema.shape,key)))throw Error("Unknown dispatch policy key");
  return dispatchPolicySchema.parse(value);
 } catch { throw Error("Invalid dispatch policy"); }
}
const interactiveTask = "(t.parent_task_id IS NULL AND t.evaluation_trial_id IS NULL AND t.execution_purpose IS DISTINCT FROM 'support_status_v1' AND t.execution_purpose IS DISTINCT FROM 'private_preview_v1')";
export async function claimDispatchBatch(pool:Pool,input:Partial<DispatchPolicy>={},compatibleReleases:readonly string[]=[HARNESS_RELEASE],workload?:"interactive"|"background") {
 const policy=dispatchPolicySchema.parse(input),owner=randomUUID();
 z.array(z.string().min(1).max(128)).min(1).max(8).parse(compatibleReleases);
 const workloadFilter=workload===undefined?"":` AND ${workload==="interactive"?interactiveTask:`NOT ${interactiveTask}`}`;
 const claimSql=`WITH tenants AS MATERIALIZED (
 SELECT st.organization_id FROM agents_platform.scheduling_tenants st WHERE EXISTS(
 SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.task_outbox o ON o.task_id=t.id WHERE t.organization_id=st.organization_id
 AND o.dispatched_at IS NULL AND o.available_at<=now() AND (o.lease_until IS NULL OR o.lease_until<now())
 AND t.harness_release=ANY($4::text[]) AND t.state IN ('accepted','running','waiting_children','waiting_authority','waiting_review','reconciling','cancel_requested')${workloadFilter}
 AND (t.parent_task_id IS NULL OR t.state='cancel_requested' OR EXISTS(SELECT 1 FROM agents_platform.operations op WHERE op.task_id=t.parent_task_id AND op.id=t.delegation_operation_id AND op.name IN ('agents.start','agents.followup') AND op.state='completed')))
 ORDER BY st.last_dispatch_at,st.organization_id LIMIT $2
 ), due AS MATERIALIZED (
 SELECT due.* FROM tenants st CROSS JOIN LATERAL (
 SELECT o.task_id,o.created_at,t.organization_id FROM agents_platform.task_outbox o JOIN agents_platform.tasks t ON t.id=o.task_id
 WHERE t.organization_id=st.organization_id AND o.dispatched_at IS NULL AND o.available_at<=now() AND (o.lease_until IS NULL OR o.lease_until<now())
 AND t.harness_release=ANY($4::text[]) AND t.state IN ('accepted','running','waiting_children','waiting_authority','waiting_review','reconciling','cancel_requested')${workloadFilter}
 AND (t.parent_task_id IS NULL OR t.state='cancel_requested' OR EXISTS(SELECT 1 FROM agents_platform.operations op WHERE op.task_id=t.parent_task_id AND op.id=t.delegation_operation_id AND op.name IN ('agents.start','agents.followup') AND op.state='completed')) ORDER BY o.created_at,o.task_id LIMIT $2) due
 ), ranked AS (SELECT *,row_number() OVER(PARTITION BY organization_id ORDER BY created_at,task_id) AS tenant_rank FROM due),
 candidate AS (SELECT o.task_id,r.organization_id FROM agents_platform.task_outbox o JOIN ranked r ON r.task_id=o.task_id
 WHERE o.dispatched_at IS NULL AND (o.lease_until IS NULL OR o.lease_until<now())
 ORDER BY r.tenant_rank,r.created_at,r.task_id FOR UPDATE OF o SKIP LOCKED LIMIT $2),
 claimed AS (UPDATE agents_platform.task_outbox o SET lease_until=now()+$3*interval '1 millisecond',lease_owner=$1,attempts=attempts+1
 FROM candidate c WHERE o.task_id=c.task_id RETURNING o.task_id,o.created_at)
 SELECT * FROM claimed`;
 const result=await pool.query<{task_id:string;created_at:Date}>(claimSql,[owner,policy.batchSize,policy.leaseMs,compatibleReleases]);
 if(result.rows.length)await pool.query(`WITH locked AS MATERIALIZED (SELECT st.organization_id FROM agents_platform.scheduling_tenants st
 WHERE st.organization_id IN(SELECT organization_id FROM agents_platform.tasks WHERE id=ANY($1::uuid[]))
 ORDER BY st.organization_id FOR UPDATE)
 UPDATE agents_platform.scheduling_tenants st SET last_dispatch_at=now() FROM locked WHERE st.organization_id=locked.organization_id`,[result.rows.map(row=>row.task_id)]);
 return {owner,rows:result.rows,policy};
}
export async function parallelEach<T>(items:T[],limit:number,work:(item:T)=>Promise<void>):Promise<void> {
 let next=0;
 await Promise.all(Array.from({length:Math.min(items.length,limit)},async()=>{while(next<items.length){const item=items[next++]!;await work(item);}}));
}
