import type { Pool, PoolClient } from "pg";

export const transitionMessages = { return: "The conversation has returned to the assistant.", resolve: "This conversation has been resolved." } as const;

/** Classify only messages backed by an immutable platform receipt. */
export async function systemMessageIds(db: Pool | PoolClient, conversationId: string, messageIds: string[]): Promise<Set<string>> {
  if (!messageIds.length) return new Set();
  const rows = (await db.query<{ id: string }>(`SELECT n.message_id AS id FROM agents_platform.support_waiting_notices n
    JOIN agents_platform.support_waiting w ON w.task_id=n.task_id
    WHERE w.conversation_id=$1 AND n.state='published' AND n.message_id=ANY($2::uuid[])
    UNION SELECT r.message_id AS id FROM agents_platform.pending_handoff_receipts r
      WHERE r.conversation_id=$1 AND r.outcome='fallback' AND r.message_id=ANY($2::uuid[])
    UNION SELECT m.id FROM agents_platform.customer_commands c JOIN agents_platform.customer_messages m
      ON m.id::text=c.result->>'handoffReceiptId' AND m.conversation_id=c.conversation_id
      WHERE c.conversation_id=$1 AND c.action IN ('request_handoff','message_handoff') AND m.id=ANY($2::uuid[])
    UNION SELECT m.id FROM agents_platform.customer_commands c JOIN agents_platform.customer_messages m
      ON m.id::text=c.result->>'transitionMessageId' AND m.conversation_id=c.conversation_id
      WHERE c.conversation_id=$1 AND c.action IN ('return','resolve') AND m.id=ANY($2::uuid[])`, [conversationId, messageIds])).rows;
  return new Set(rows.map(row => row.id));
}

/** Return actual episode and reply timestamps for the currently active handoff. */
export async function currentHandoff(db: Pool | PoolClient, conversationId: string, state: string, returnWatermark: string): Promise<{requestedAt: Date; firstHumanReplyAt: Date | null} | null> {
  if (state !== "handoff_pending" && state !== "human_owned") return null;
  const row = (await db.query<{ requested_at: Date; first_human_reply_at: Date | null }>(`SELECT w.requested_at,
    (SELECT min(m.created_at) FROM agents_platform.customer_messages m WHERE m.conversation_id=w.conversation_id
      AND m.author_kind='human' AND m.ownership_generation>=w.ownership_generation) AS first_human_reply_at
    FROM agents_platform.support_waiting w
    LEFT JOIN agents_platform.customer_task_links l ON l.task_id=w.source_task_id AND l.conversation_id=w.conversation_id
    JOIN agents_platform.customer_messages origin ON origin.id=coalesce(w.source_message_id,l.input_message_id) AND origin.conversation_id=w.conversation_id
    WHERE w.conversation_id=$1 AND origin.sequence>$2::bigint ORDER BY w.requested_at DESC LIMIT 1`, [conversationId, returnWatermark])).rows[0];
  return row ? { requestedAt: row.requested_at, firstHumanReplyAt: row.first_human_reply_at } : null;
}
