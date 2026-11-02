import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "../../infrastructure/database";
import { PlatformError } from "../../contracts/contracts";

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new PlatformError("FOLLOWUP_UNAVAILABLE", 404, "Follow-up is unavailable");
type Scope = { deploymentId: string; sessionId: string; conversationId: string };

/** Internal primitives. Public endpoints must enforce origin, rate, delivery availability and CSRF controls. */
export class CustomerFollowupChallenges {
  constructor(private readonly pool: Pool) {}
  private async requireVisitor(db: PoolClient, scope: Scope) {
    z.uuid().parse(scope.deploymentId); z.uuid().parse(scope.sessionId); z.uuid().parse(scope.conversationId);
    const conversation = await db.query(`SELECT c.id FROM agents_platform.customer_conversations c JOIN agents_platform.website_sessions s ON s.id=$3 AND s.deployment_id=c.deployment_id
      JOIN agents_platform.website_deployments d ON d.id=c.deployment_id
      WHERE c.id=$1 AND c.deployment_id=$2 AND s.expires_at>now() AND d.revoked_at IS NULL AND d.paused=false AND
        (c.session_id=s.id OR EXISTS (SELECT 1 FROM agents_platform.customer_followup_access a JOIN agents_platform.customer_followup_preferences p
          ON p.conversation_id=a.conversation_id AND p.revision=a.preference_revision WHERE a.session_id=s.id AND a.conversation_id=c.id
          AND a.deployment_id=d.id AND a.expires_at>now() AND p.status='verified')) FOR UPDATE OF c`, [scope.conversationId, scope.deploymentId, scope.sessionId]);
    if (!conversation.rowCount) throw unavailable();
  }
  private async issue(db: PoolClient, conversationId: string, revision: string, purpose: "verify_email" | "return_to_conversation", notificationId?: string) {
    const secret = randomBytes(32).toString("base64url");
    await db.query(`INSERT INTO agents_platform.customer_followup_challenges(id,conversation_id,preference_revision,purpose,secret_hash,expires_at,notification_id)
      VALUES($1,$2,$3,$4,$5,now()+interval '30 minutes',$6)`, [randomUUID(), conversationId, revision, purpose, digest(secret), notificationId ?? null]);
    return secret;
  }
  async requestVerification(scope: Scope, email: string) {
    const normalized = z.email().max(254).parse(email.trim());
    return transaction(this.pool, async db => {
      await this.requireVisitor(db, scope);
      const row = (await db.query<{ revision: string }>(`INSERT INTO agents_platform.customer_followup_preferences(conversation_id,email,purpose,status,confirmed_at)
        VALUES($1,$2,'human_reply_notification','pending',now()) ON CONFLICT(conversation_id) DO UPDATE SET email=excluded.email,status='pending',revision=agents_platform.customer_followup_preferences.revision+1,confirmed_at=now(),verified_at=NULL,revoked_at=NULL RETURNING revision`, [scope.conversationId, normalized])).rows[0]!;
      return { secret: await this.issue(db, scope.conversationId, row.revision, "verify_email"), email: normalized };
    });
  }
  async revoke(scope: Scope) {
    return transaction(this.pool, async db => {
      await this.requireVisitor(db, scope);
      await db.query(`UPDATE agents_platform.customer_followup_preferences SET status='revoked',revision=revision+1,revoked_at=now()
        WHERE conversation_id=$1 AND status<>'revoked'`, [scope.conversationId]);
    });
  }
  async preference(scope: Scope): Promise<"pending" | "verified" | "revoked" | "none"> {
    return transaction(this.pool, async db => {
      await this.requireVisitor(db, scope);
      return (await db.query<{ status: "pending" | "verified" | "revoked" }>("SELECT status FROM agents_platform.customer_followup_preferences WHERE conversation_id=$1", [scope.conversationId])).rows[0]?.status ?? "none";
    });
  }
  async markRead(scope: Scope, sequence: string) {
    z.string().regex(/^[1-9][0-9]{0,17}$/).parse(sequence);
    return transaction(this.pool, async db => {
      await this.requireVisitor(db, scope);
      const message = await db.query("SELECT 1 FROM agents_platform.customer_messages WHERE conversation_id=$1 AND sequence=$2", [scope.conversationId, sequence]);
      if (!message.rowCount) throw unavailable();
      await db.query(`INSERT INTO agents_platform.customer_followup_reads(conversation_id,session_id,sequence)
        VALUES($1,$2,$3) ON CONFLICT(conversation_id,session_id) DO UPDATE SET sequence=greatest(agents_platform.customer_followup_reads.sequence,excluded.sequence),read_at=now()`, [scope.conversationId, scope.sessionId, sequence]);
      await db.query(`UPDATE agents_platform.customer_followup_notifications n SET state='suppressed',updated_at=now()
        FROM agents_platform.customer_messages m WHERE n.message_id=m.id AND n.conversation_id=$1 AND n.state='pending' AND m.sequence<=$2`, [scope.conversationId, sequence]);
    });
  }
  async verifyEmail(scope: Scope, secret: string) {
    token.parse(secret);
    return transaction(this.pool, async db => {
      await this.requireVisitor(db, scope);
      const row = (await db.query<{ id: string; conversation_id: string; preference_revision: string }>(`SELECT c.id,c.conversation_id,c.preference_revision FROM agents_platform.customer_followup_challenges c
        JOIN agents_platform.customer_followup_preferences p ON p.conversation_id=c.conversation_id AND p.revision=c.preference_revision
        WHERE c.secret_hash=$1 AND c.conversation_id=$2 AND c.purpose='verify_email' AND c.expires_at>now() AND c.consumed_at IS NULL AND p.status='pending' FOR UPDATE OF c,p`, [digest(secret), scope.conversationId])).rows[0];
      if (!row) throw unavailable();
      await db.query("UPDATE agents_platform.customer_followup_challenges SET consumed_at=now() WHERE id=$1", [row.id]);
      await db.query("UPDATE agents_platform.customer_followup_preferences SET status='verified',verified_at=now() WHERE conversation_id=$1 AND revision=$2", [row.conversation_id, row.preference_revision]);
    });
  }
  /** Called by the notification dispatcher after it has claimed a specific human reply. */
  async issueReturn(notificationId: string) {
    z.uuid().parse(notificationId);
    return transaction(this.pool, async db => {
      const row = (await db.query<{ conversation_id: string; preference_revision: string }>(`SELECT n.conversation_id,n.preference_revision FROM agents_platform.customer_followup_notifications n
        JOIN agents_platform.customer_followup_preferences p ON p.conversation_id=n.conversation_id AND p.revision=n.preference_revision
        JOIN agents_platform.customer_messages m ON m.id=n.message_id AND m.conversation_id=n.conversation_id
        JOIN agents_platform.customer_conversations c ON c.id=n.conversation_id
        JOIN agents_platform.website_deployments d ON d.id=c.deployment_id
        WHERE n.id=$1 AND n.state='sending' AND p.status='verified' AND m.author_kind='human' AND d.revoked_at IS NULL AND d.paused=false FOR UPDATE OF n,p`, [notificationId])).rows[0];
      if (!row) throw unavailable();
      return this.issue(db, row.conversation_id, row.preference_revision, "return_to_conversation", notificationId);
    });
  }
  /** Bind a one-use emailed challenge to an already authenticated, same-deployment website session. */
  async exchangeReturn(scope: { deploymentId: string; sessionId: string }, secret: string) {
    z.uuid().parse(scope.deploymentId); z.uuid().parse(scope.sessionId); token.parse(secret);
    return transaction(this.pool, async db => {
      const row = (await db.query<{ id: string; conversation_id: string; preference_revision: string; session_expires_at: Date }>(`SELECT h.id,h.conversation_id,h.preference_revision,s.expires_at AS session_expires_at
        FROM agents_platform.customer_followup_challenges h
        JOIN agents_platform.customer_followup_preferences p ON p.conversation_id=h.conversation_id AND p.revision=h.preference_revision
        JOIN agents_platform.customer_conversations c ON c.id=h.conversation_id
        JOIN agents_platform.website_deployments d ON d.id=c.deployment_id
        JOIN agents_platform.website_sessions s ON s.deployment_id=d.id AND s.id=$3
        WHERE h.secret_hash=$1 AND h.purpose='return_to_conversation' AND h.expires_at>now() AND h.consumed_at IS NULL
          AND p.status='verified' AND d.id=$2 AND d.revoked_at IS NULL AND d.paused=false AND s.expires_at>now()
        FOR UPDATE OF h,p,s`, [digest(secret), scope.deploymentId, scope.sessionId])).rows[0];
      if (!row) throw unavailable();
      await db.query("UPDATE agents_platform.customer_followup_challenges SET consumed_at=now() WHERE id=$1", [row.id]);
      await db.query(`INSERT INTO agents_platform.customer_followup_access(session_id,conversation_id,deployment_id,preference_revision,expires_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(session_id) DO UPDATE SET conversation_id=excluded.conversation_id,deployment_id=excluded.deployment_id,
        preference_revision=excluded.preference_revision,expires_at=excluded.expires_at,created_at=now()`, [scope.sessionId, row.conversation_id, scope.deploymentId, row.preference_revision, row.session_expires_at]);
      return { conversationId: row.conversation_id };
    });
  }
}
