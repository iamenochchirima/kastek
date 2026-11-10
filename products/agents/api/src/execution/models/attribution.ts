import type { Pool, PoolClient } from "pg";

/**
 * Managed model cost for a settled root task, in micro-USD.
 * Only platform-managed connections debit the AI allowance; customer keys do not.
 * An operation whose provider usage stayed unknown bills its reserved upper bound.
 */
export async function managedCostMicros(db: Pool | PoolClient, rootTaskId: string): Promise<bigint> {
  const row = (await db.query<{ micros: string }>(
    `SELECT COALESCE(SUM(CASE WHEN k.custody='platform_managed'
        THEN CASE WHEN c.state='settled' THEN c.actual_micros ELSE c.upper_cost_micros END
        ELSE 0 END),0)::text AS micros
       FROM agents_platform.model_cost_reservations c
       JOIN agents_platform.operations o
         ON o.task_id=c.task_id AND o.id=c.operation_id
       JOIN agents_platform.task_model_routes r
         ON r.task_id=c.task_id
       JOIN agents_platform.model_provider_connections k
         ON k.organization_id=c.organization_id
        AND k.id::text=(r.routes->CASE WHEN o.kind='compaction' THEN 'compaction' ELSE 'primary' END->'binding'->>'connectionId')
      WHERE c.root_task_id=$1`,
    [rootTaskId],
  )).rows[0];
  return BigInt(row?.micros ?? "0");
}
