import type { Pool } from "pg";

/** Refuse a cutover that would strand existing content in the old store. */
export async function assertKnowledgeBackfilled(pool: Pool): Promise<void> {
  const missing = await pool.query(`SELECT 1 FROM agents_platform.source_objects o
    WHERE o.state='available' AND NOT EXISTS (SELECT 1 FROM agents_platform.knowledge_object_contents k WHERE k.object_key=o.object_key)
    UNION ALL SELECT 1 FROM agents_platform.execution_objects o
    WHERE o.state='available' AND o.object_key LIKE 'knowledge-query/%'
      AND NOT EXISTS (SELECT 1 FROM agents_platform.knowledge_object_contents k WHERE k.object_key=o.object_key)
    LIMIT 1`);
  if (missing.rowCount) throw new Error("Knowledge backfill is required before starting the API or worker");
}
