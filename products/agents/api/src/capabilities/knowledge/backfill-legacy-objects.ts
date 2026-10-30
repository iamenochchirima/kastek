import type { Pool } from "pg";
import { textDigest } from "../../contracts/source-contracts";
import type { PrivateObjectStore } from "../../infrastructure/object-store";

/** Run only while all API, worker, dispatch and reaper processes are stopped.
 * The source is never modified; rerunning copies any remaining available objects.
 */
export async function backfillLegacyKnowledgeObjects(pool: Pool, source: PrivateObjectStore, destination: PrivateObjectStore): Promise<{ copied: number }> {
  const unsafe = await pool.query(`SELECT object_key FROM agents_platform.source_objects WHERE state='writing'
    UNION ALL SELECT object_key FROM agents_platform.execution_objects WHERE object_key LIKE 'knowledge-query/%' AND state='writing' LIMIT 1`);
  if (unsafe.rowCount) throw new Error("Knowledge writes are in progress; stop all writers and reapers before backfill");
  // A live reference to a missing/deleting object cannot safely be cut over.
  const missing = await pool.query(`SELECT r.id FROM agents_platform.source_revisions r
    JOIN agents_platform.sources s ON s.id=r.source_id AND s.state='active'
    WHERE NOT EXISTS (SELECT 1 FROM agents_platform.source_objects o WHERE o.object_key=r.text_key AND o.state='available' AND o.content_digest=r.text_digest AND o.bytes=r.text_bytes)
       OR NOT EXISTS (SELECT 1 FROM agents_platform.source_objects o WHERE o.object_key=r.raw_key AND o.state IN ('available','deleted') AND o.content_digest=r.raw_digest AND o.bytes=r.raw_bytes)
    UNION ALL
    SELECT j.id FROM agents_platform.ingestion_jobs j JOIN agents_platform.sources s ON s.id=j.source_id AND s.state='active'
    WHERE j.state NOT IN ('ready','failed','cancelled') AND j.raw_state='available'
      AND NOT EXISTS (SELECT 1 FROM agents_platform.source_objects o WHERE o.object_key=j.raw_key AND o.state='available' AND o.content_digest=j.raw_digest AND o.bytes=j.raw_bytes)
    UNION ALL
    SELECT d.id FROM agents_platform.document_allocations d JOIN agents_platform.ingestion_jobs j ON j.id=d.job_id
    JOIN agents_platform.sources s ON s.id=j.source_id AND s.state='active'
    WHERE j.state NOT IN ('ready','failed','cancelled') AND d.result_key IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM agents_platform.source_objects o WHERE o.object_key=d.result_key AND o.state='available' AND o.content_digest=d.result_digest)
    UNION ALL
    SELECT q.id FROM agents_platform.query_embedding_allocations q JOIN agents_platform.operations op ON op.id=q.operation_id
    JOIN agents_platform.tasks t ON t.id=q.task_id
    WHERE q.result_key IS NOT NULL AND op.state='started' AND t.state NOT IN ('completed','failed','cancelled','uncertain','incomplete','refused')
      AND NOT EXISTS (SELECT 1 FROM agents_platform.execution_objects o WHERE o.object_key=q.result_key AND o.state='available') LIMIT 1`);
  if (missing.rowCount) throw new Error("A live knowledge reference has no available object; resolve it before cutover");
  const rows = await pool.query<{object_key: string; content_digest: string; bytes: number; content_type: string; already_copied: boolean}>(`
    SELECT o.object_key,o.content_digest,o.bytes,
      CASE o.kind WHEN 'stage' THEN 'application/json' WHEN 'text' THEN 'text/plain; charset=utf-8' ELSE j.content_type END AS content_type,
      EXISTS (SELECT 1 FROM agents_platform.knowledge_object_contents k WHERE k.object_key=o.object_key) AS already_copied
    FROM agents_platform.source_objects o JOIN agents_platform.ingestion_jobs j ON j.id=o.job_id
    WHERE o.state='available'
    UNION ALL SELECT o.object_key,o.content_digest,o.bytes,'application/json' AS content_type,
      EXISTS (SELECT 1 FROM agents_platform.knowledge_object_contents k WHERE k.object_key=o.object_key) AS already_copied
    FROM agents_platform.execution_objects o WHERE o.state='available' AND o.object_key LIKE 'knowledge-query/%'
    ORDER BY object_key`);
  let copied = 0;
  for (const row of rows.rows) {
    const content = await (row.already_copied ? destination : source).get(row.object_key);
    if (content.byteLength !== row.bytes || textDigest(content) !== row.content_digest || !row.content_type) {
      throw new Error(`Legacy knowledge object failed integrity verification: ${row.object_key}`);
    }
    if (!row.already_copied) await destination.put(row.object_key, content, row.content_type);
    const saved = await destination.get(row.object_key);
    if (saved.byteLength !== row.bytes || textDigest(saved) !== row.content_digest) {
      throw new Error(`Backfilled knowledge object failed integrity verification: ${row.object_key}`);
    }
    copied++;
  }
  return { copied };
}
