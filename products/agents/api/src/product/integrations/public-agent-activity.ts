import type { Pool } from "pg";
import type { GrowthAgentPublicUpdate } from "@kasitek-labs/contracts";
import { assertCurrentEvidence, taskEvidenceManifest } from "../../execution/context/evidence-policy";
import { PlatformError } from "../../contracts/contracts";

/** Public assistant preambles are already durable in model receipts. Native reasoning is never selected. */
export async function readPublicAgentUpdates(pool: Pool, taskId: string): Promise<{updates: GrowthAgentPublicUpdate[]; updatesTruncated: boolean}> {
  const hidden = {updates: [], updatesTruncated: false};
  const task = (await pool.query(`SELECT t.channel_binding,c.deleted_at FROM agents_platform.tasks t
    JOIN agents_platform.conversations c ON c.id=t.conversation_id WHERE t.id=$1`, [taskId])).rows[0];
  // Customer delivery has its own published-message authority, not the owner's work transcript.
  if (!task || task.deleted_at || task.channel_binding) return hidden;
  try { await assertCurrentEvidence(pool, taskId, await taskEvidenceManifest(pool, taskId), {requireActiveTask: false}); }
  catch (error) { if (error instanceof PlatformError && [403,404,409,503].includes(error.statusCode)) return hidden; throw error; }
  const rows = (await pool.query(`SELECT id,left(output->'message'->>'content',8192) AS text,completed_at FROM agents_platform.operations
    WHERE task_id=$1 AND kind='model' AND name='model.generate' AND state='completed'
      AND output->'message'->>'role'='assistant' AND jsonb_typeof(output->'message'->'content')='string'
      AND CASE WHEN jsonb_typeof(output->'message'->'tool_calls')='array' THEN jsonb_array_length(output->'message'->'tool_calls')>0 ELSE false END
      AND length(output->'message'->>'content')>0
    ORDER BY started_at DESC,id DESC LIMIT 61`, [taskId])).rows;
  return {updates: rows.slice(0,60).reverse().map(row=>({id:row.id,text:row.text,createdAt:new Date(row.completed_at).toISOString()})),updatesTruncated:rows.length>60};
}
