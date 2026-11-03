import type {Pool,PoolClient} from "pg";

/** A parent change can fence stale work without copying its private direction into a child. */
export async function instructionHead(db:Pool|PoolClient,taskId:string):Promise<string>{
  return (await db.query(`WITH RECURSIVE lineage AS (
    SELECT id,parent_task_id FROM agents_platform.tasks WHERE id=$1
    UNION ALL SELECT t.id,t.parent_task_id FROM agents_platform.tasks t JOIN lineage l ON t.id=l.parent_task_id
  ) SELECT coalesce(max(i.sequence),0)::text AS head FROM lineage l
    LEFT JOIN agents_platform.orchestration_instructions i ON i.task_id=l.id`,[taskId])).rows[0].head;
}
