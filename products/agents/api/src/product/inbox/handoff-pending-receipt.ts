import type { Pool, PoolClient } from "pg";
import { requestDigest } from "../../contracts/contracts";
import { parseHandoffFeedbackRequest, type HandoffFeedbackRequest } from "../../execution/lifecycle/handoff-feedback-contract";
import type { DependencyManifest } from "../../contracts/source-contracts";
export const HANDOFF_RECEIPT_DEADLINE_MS = 5000;

export type Receipt = { task_id: string; conversation_id: string; ownership_generation: string; deadline: Date; outcome: string | null; feedback_request_digest: string | null; evidence_manifest: DependencyManifest | null };
export type Publisher = (db: PoolClient, input: { receipt: Receipt; origin: "model" | "fallback"; text: string }) => Promise<string | null>;

// This commits separately from message publication so a failing publisher cannot
// keep the originating root alive beyond its feedback deadline.
export async function cancelExpiredReceiptRoot(pool: Pool, taskId: string): Promise<boolean> {
  const row = await pool.query(`INSERT INTO agents_platform.customer_cancellations(task_id)
    SELECT task_id FROM agents_platform.pending_handoff_receipts
    WHERE task_id=$1 AND outcome IS NULL AND deadline<=clock_timestamp()
    ON CONFLICT DO NOTHING RETURNING task_id`, [taskId]);
  return Boolean(row.rowCount);
}

// Run in the existing handoff transaction, after the ownership fence has committed in that transaction.
// The caller owns the release-specific deadline policy and validates it before admission.
export async function reserveReceipt(db: PoolClient, input: { taskId: string; conversationId: string; ownershipGeneration: string; delayMs: number; feedback?: HandoffFeedbackRequest }) {
  if (!Number.isSafeInteger(input.delayMs) || input.delayMs <= 0 || input.delayMs > 2147483647) throw new Error("INVALID_RECEIPT_DEADLINE");
  const feedback = input.feedback ? parseHandoffFeedbackRequest(input.feedback) : null;
  const feedbackDigest = feedback ? requestDigest(feedback) : null;
  const manifest = feedback?.evidenceManifest ?? null;
  const row = (await db.query(`INSERT INTO agents_platform.pending_handoff_receipts(task_id,conversation_id,ownership_generation,delay_ms,feedback_request_digest,evidence_manifest,created_at,deadline)
    SELECT $1,$2,$3,$4::integer,$5,$6::jsonb,t,t+$4::integer*interval '1 millisecond' FROM (SELECT clock_timestamp() t) clock
    ON CONFLICT(task_id) DO NOTHING RETURNING *`, [input.taskId,input.conversationId,input.ownershipGeneration,input.delayMs,feedbackDigest,manifest])).rows[0];
  if (row) return row;
  const existing = (await db.query("SELECT * FROM agents_platform.pending_handoff_receipts WHERE task_id=$1", [input.taskId])).rows[0];
  if (!existing || existing.conversation_id !== input.conversationId || existing.ownership_generation !== input.ownershipGeneration || existing.delay_ms !== input.delayMs
    || existing.feedback_request_digest !== feedbackDigest || requestDigest(existing.evidence_manifest) !== requestDigest(manifest)) throw new Error("RECEIPT_CONFLICT");
  return existing;
}

// Publisher MUST verify the deployment, recipient, grant, source evidence and message provenance
// under these locks, and append the canonical message plus its delivery intent in this transaction.
// Null means authority was revoked; do not publish a fallback after a revoked authority.
export async function settleReceipt(pool: Pool, taskId: string, candidate: { text: string } | null, fallback: string, publish: Publisher, definitiveFailure = false) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const target = (await db.query("SELECT conversation_id FROM agents_platform.pending_handoff_receipts WHERE task_id=$1", [taskId])).rows[0];
    if (!target) { await db.query("COMMIT"); return "missing"; }
    const conversation = (await db.query("SELECT state,ownership_generation FROM agents_platform.customer_conversations WHERE id=$1 FOR UPDATE", [target.conversation_id])).rows[0];
    const receipt: Receipt = (await db.query("SELECT * FROM agents_platform.pending_handoff_receipts WHERE task_id=$1 FOR UPDATE", [taskId])).rows[0];
    if (receipt.outcome) { await db.query("COMMIT"); return receipt.outcome; }
    if (!conversation || conversation.state !== "handoff_pending" || conversation.ownership_generation !== receipt.ownership_generation) {
      await db.query("UPDATE agents_platform.pending_handoff_receipts SET outcome='suppressed',settled_at=clock_timestamp() WHERE task_id=$1", [taskId]);
      await db.query("INSERT INTO agents_platform.customer_cancellations(task_id) VALUES($1) ON CONFLICT DO NOTHING", [taskId]);
      await db.query("COMMIT"); return "suppressed";
    }
    const due = (await db.query("SELECT clock_timestamp() >= $1::timestamptz AS due", [receipt.deadline])).rows[0].due;
    if (!candidate && !due && !definitiveFailure) { await db.query("COMMIT"); return "pending"; }
    const origin = candidate && !due && !definitiveFailure ? "model" : "fallback";
    const text = origin === "model" ? candidate!.text : fallback;
    const messageId = await publish(db, {receipt,origin,text});
    const outcome = messageId ? origin : "suppressed";
    await db.query("UPDATE agents_platform.pending_handoff_receipts SET outcome=$2,message_id=$3,settled_at=clock_timestamp() WHERE task_id=$1", [taskId,outcome,messageId]);
    await db.query("INSERT INTO agents_platform.customer_cancellations(task_id) VALUES($1) ON CONFLICT DO NOTHING", [taskId]);
    await db.query("COMMIT"); return outcome;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}
