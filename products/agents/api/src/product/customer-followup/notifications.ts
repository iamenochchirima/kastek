import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { transaction } from "../../infrastructure/database";
import type { NotificationMessage, NotificationResult } from "../../adapters/notifications/resend";
import { CustomerFollowupChallenges } from "./challenges";
import { customerReturnUrl } from "./return-url";

/** Call in the transaction that records a human reply. No email is sent here. */
export async function enqueueCustomerFollowup(db: PoolClient, conversationId: string, messageId: string): Promise<string | null> {
  const inserted = await db.query<{ id: string }>(`INSERT INTO agents_platform.customer_followup_notifications(id,conversation_id,message_id,preference_revision,state)
    SELECT $1,c.id,m.id,p.revision,'pending' FROM agents_platform.customer_conversations c
    JOIN agents_platform.customer_messages m ON m.conversation_id=c.id AND m.id=$3 AND m.author_kind='human'
    JOIN agents_platform.customer_followup_preferences p ON p.conversation_id=c.id AND p.status='verified'
    JOIN agents_platform.website_deployments d ON d.id=c.deployment_id AND d.revoked_at IS NULL AND d.paused=false
    WHERE c.id=$2 AND NOT EXISTS (SELECT 1 FROM agents_platform.customer_followup_reads r WHERE r.conversation_id=c.id AND r.sequence>=m.sequence)
    ON CONFLICT (message_id,preference_revision) DO NOTHING RETURNING id`, [randomUUID(), conversationId, messageId]);
  return inserted.rows[0]?.id ?? null;
}
export async function customerFollowupFailures(db: Pool | PoolClient, conversationId: string): Promise<Array<{id:string;state:"rejected"|"unknown";createdAt:Date}>> {
  const rows = (await db.query<{id:string;state:"rejected"|"unknown";created_at:Date}>(`SELECT id,state,created_at FROM agents_platform.customer_followup_notifications
    WHERE conversation_id=$1 AND state IN ('rejected','unknown') ORDER BY created_at DESC LIMIT 20`, [conversationId])).rows;
  return rows.map(row => ({id:row.id,state:row.state,createdAt:row.created_at}));
}

/** The dispatcher must persist its scheduling before invoking this service; it never retries an unknown send. */
export class CustomerFollowupNotifications {
  private readonly challenges: CustomerFollowupChallenges;
  constructor(private readonly pool: Pool, private readonly send: (message: NotificationMessage, beforeAttempt?: () => Promise<void>) => Promise<NotificationResult>,
    private readonly publicUrl: string) { this.challenges = new CustomerFollowupChallenges(pool); }
  async deliver(notificationId: string): Promise<"accepted" | "rejected" | "unknown" | "suppressed" | "not_pending" | "in_progress"> {
    const claimed = await transaction(this.pool, async db => {
      const row = (await db.query<{ id: string; state:string; conversation_id: string; email: string; deployment_id: string; eligible: boolean }>(`SELECT n.id,n.state,n.conversation_id,p.email,c.deployment_id,
        (p.status='verified' AND p.revision=n.preference_revision AND d.revoked_at IS NULL AND d.paused=false
         AND NOT EXISTS(SELECT 1 FROM agents_platform.customer_followup_reads r WHERE r.conversation_id=c.id AND r.sequence>=m.sequence)) AS eligible
        FROM agents_platform.customer_followup_notifications n JOIN agents_platform.customer_followup_preferences p ON p.conversation_id=n.conversation_id
        JOIN agents_platform.customer_conversations c ON c.id=n.conversation_id JOIN agents_platform.customer_messages m ON m.id=n.message_id AND m.conversation_id=c.id
        JOIN agents_platform.website_deployments d ON d.id=c.deployment_id WHERE n.id=$1 AND n.state IN ('pending','sending') FOR UPDATE OF n,p,c`, [notificationId])).rows[0];
      if (!row) return {kind:"not_pending" as const};
      if(row.state === "sending") {
        // The sender has a bounded 30-second maximum. A lost process cannot prove whether it sent.
        const recovered=await db.query("UPDATE agents_platform.customer_followup_notifications SET state='unknown',updated_at=now() WHERE id=$1 AND state='sending' AND updated_at<=now()-interval '60 seconds'",[notificationId]);
        return {kind:recovered.rowCount ? "unknown" as const : "in_progress" as const};
      }
      await db.query("UPDATE agents_platform.customer_followup_notifications SET state=$2,updated_at=now() WHERE id=$1", [notificationId, row.eligible ? "sending" : "suppressed"]);
      return {kind:"claimed" as const,...row};
    });
    if (claimed.kind !== "claimed") return claimed.kind;
    if (!claimed.eligible) return "suppressed";
    try {
      const secret = await this.challenges.issueReturn(notificationId);
      const link = customerReturnUrl(this.publicUrl, claimed.deployment_id, secret);
      let authorityRevoked = false;
      const beforeAttempt = async () => {
        const result = await this.pool.query(`SELECT 1 FROM agents_platform.customer_followup_notifications n
          JOIN agents_platform.customer_followup_preferences p ON p.conversation_id=n.conversation_id AND p.revision=n.preference_revision
          JOIN agents_platform.customer_conversations c ON c.id=n.conversation_id JOIN agents_platform.customer_messages m ON m.id=n.message_id AND m.conversation_id=c.id
          JOIN agents_platform.website_deployments d ON d.id=c.deployment_id
          WHERE n.id=$1 AND n.state='sending' AND p.status='verified' AND d.revoked_at IS NULL AND d.paused=false
            AND NOT EXISTS(SELECT 1 FROM agents_platform.customer_followup_reads r WHERE r.conversation_id=c.id AND r.sequence>=m.sequence)`, [notificationId]);
        if (!result.rowCount) { authorityRevoked = true; throw new Error("Follow-up authorization changed"); }
      };
      const result = await this.send({ to: claimed.email, subject: "Support replied", text: `Your support team replied. Open your conversation:\n\n${link}`, idempotencyKey: `followup_${notificationId}` }, beforeAttempt);
      if (authorityRevoked) { await this.pool.query("UPDATE agents_platform.customer_followup_notifications SET state='suppressed',updated_at=now() WHERE id=$1 AND state='sending'", [notificationId]); return "suppressed"; }
      await this.pool.query("UPDATE agents_platform.customer_followup_notifications SET state=$2,provider_id=$3,updated_at=now() WHERE id=$1 AND state='sending'", [notificationId, result.state, result.state === "accepted" ? result.providerId : null]);
      return result.state;
    } catch {
      await this.pool.query("UPDATE agents_platform.customer_followup_notifications SET state='unknown',updated_at=now() WHERE id=$1 AND state='sending'", [notificationId]);
      return "unknown";
    }
  }
}
