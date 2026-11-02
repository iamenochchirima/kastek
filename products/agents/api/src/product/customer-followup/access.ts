import type { Pool, PoolClient } from "pg";

/** Called after ordinary website session and origin authorization. Preference changes revoke access. */
export async function followupAccess(db: Pool | PoolClient, scope: { deploymentId: string; sessionId: string }, conversationId?: string): Promise<string | null> {
  const result = await db.query<{ conversation_id: string }>(`SELECT a.conversation_id FROM agents_platform.customer_followup_access a
    JOIN agents_platform.customer_followup_preferences p ON p.conversation_id=a.conversation_id AND p.revision=a.preference_revision
    JOIN agents_platform.customer_conversations c ON c.id=a.conversation_id AND c.deployment_id=a.deployment_id
    JOIN agents_platform.website_sessions s ON s.id=a.session_id AND s.deployment_id=a.deployment_id
    JOIN agents_platform.website_deployments d ON d.id=a.deployment_id
    WHERE a.deployment_id=$1 AND a.session_id=$2 AND ($3::uuid IS NULL OR a.conversation_id=$3)
      AND a.expires_at>now() AND s.expires_at>now() AND p.status='verified' AND d.revoked_at IS NULL AND d.paused=false
      FOR SHARE OF a,p,c,s,d`, [scope.deploymentId, scope.sessionId, conversationId ?? null]);
  return result.rows[0]?.conversation_id ?? null;
}
