import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";

export const dispatchPolicySchema = z.object({
  batchSize:z.number().int().min(1).max(128).default(32),
  parallelism:z.number().int().min(1).max(32).default(8),
  leaseMs:z.number().int().min(30_000).max(300_000).default(120_000),
});
export type DispatchPolicy = z.infer<typeof dispatchPolicySchema>;
export async function claimDispatchBatch(pool:Pool,input:Partial<DispatchPolicy>={}) {
 const policy=dispatchPolicySchema.parse(input),owner=randomUUID();
 const result=await pool.query<{task_id:string;created_at:Date}>(`WITH due AS MATERIALIZED (
 SELECT o.task_id,o.created_at,t.organization_id FROM agents_platform.task_outbox o
 JOIN agents_platform.tasks t ON t.id=o.task_id
 WHERE o.dispatched_at IS NULL AND o.available_at<=now() AND (o.lease_until IS NULL OR o.lease_until<now())
 AND t.state IN ('accepted','running','waiting_children','waiting_authority','waiting_review','reconciling','cancel_requested')
 AND (t.parent_task_id IS NULL OR t.state='cancel_requested')
 ORDER BY o.available_at,o.created_at,o.task_id LIMIT $3
 ), ranked AS (SELECT *,row_number() OVER(PARTITION BY organization_id ORDER BY created_at,task_id) AS tenant_rank FROM due),
 candidate AS (SELECT o.task_id FROM agents_platform.task_outbox o JOIN ranked r ON r.task_id=o.task_id
 WHERE o.dispatched_at IS NULL AND (o.lease_until IS NULL OR o.lease_until<now())
 ORDER BY r.tenant_rank,r.created_at,r.task_id FOR UPDATE OF o SKIP LOCKED LIMIT $2)
 UPDATE agents_platform.task_outbox o SET lease_until=now()+$4*interval '1 millisecond',lease_owner=$1,attempts=attempts+1
 FROM candidate c WHERE o.task_id=c.task_id RETURNING o.task_id,o.created_at`,[owner,policy.batchSize,policy.batchSize*16,policy.leaseMs]);
 return {owner,rows:result.rows,policy};
}
export async function parallelEach<T>(items:T[],limit:number,work:(item:T)=>Promise<void>):Promise<void> {
 let next=0;
 await Promise.all(Array.from({length:Math.min(items.length,limit)},async()=>{while(next<items.length){const item=items[next++]!;await work(item);}}));
}
