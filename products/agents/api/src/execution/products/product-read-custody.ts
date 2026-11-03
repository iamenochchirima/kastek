import type { Pool,PoolClient } from "pg";
import { requiresProductAccess } from "../../capabilities/products/product-capabilities";
import { PlatformError } from "../../contracts/contracts";
import { loadExecution } from "../lifecycle/state";

/** Old canonical reads without product-issued custody cannot safely be reused. */
export async function assertProductReadCustody(db:Pool|PoolClient,taskId:string):Promise<void>{
  const rows=(await db.query(`WITH RECURSIVE reachable AS (
      SELECT n.id,n.task_id,n.parents FROM agents_platform.evidence_nodes n WHERE n.task_id=$1
      UNION
      SELECT n.id,n.task_id,n.parents FROM reachable r JOIN agents_platform.evidence_nodes n ON n.id=ANY(
        r.parents || coalesce((SELECT array_agg(origin.id) FROM agents_platform.evidence_history_links h
          CROSS JOIN LATERAL unnest(h.origin_node_ids) origin(id) WHERE h.node_id=r.id),ARRAY[]::uuid[]))
    ), influencing AS (SELECT $1::uuid id UNION SELECT task_id FROM reachable)
    SELECT o.id,o.task_id,o.request FROM agents_platform.operations o
    JOIN agents_platform.tasks t ON t.id=o.task_id
    LEFT JOIN agents_platform.product_operation_access a ON a.operation_id=o.id AND a.task_id=o.task_id
    WHERE t.id IN (SELECT id FROM influencing) AND o.state='completed'
      AND o.request ? 'productBindingId' AND a.operation_id IS NULL`,[taskId])).rows;
  const executions=new Map<string,Awaited<ReturnType<typeof loadExecution>>>();
  for(const row of rows){
    let execution=executions.get(row.task_id);
    if(!execution){execution=await loadExecution(db,row.task_id);executions.set(row.task_id,execution);}
    const binding=execution.configuration.productBindings.find(value=>value.id===row.request.productBindingId&&value.digest===row.request.bindingDigest);
    if(!binding||requiresProductAccess(binding)||binding.policy.effect==="reviewed_write")throw new PlatformError("EVIDENCE_UNAVAILABLE",403,"An earlier product result has no current access record");
  }
}
