import type { Pool, PoolClient } from "pg";
import type { VisitorLineage } from "../../contracts/channel";
import { followupAccess } from "./access";

/** A return grant connects sessions to one existing conversation; it never merges identities. */
export async function verifiedVisitorLineage(db: Pool | PoolClient, input: VisitorLineage): Promise<boolean> {
  if (input.current.deploymentId !== input.origin.deploymentId) return false;
  const row = (await db.query(`SELECT c.session_id FROM agents_platform.customer_conversations c
    JOIN agents_platform.conversations execution ON execution.id=c.execution_conversation_id AND execution.organization_id=c.organization_id AND execution.agent_id=c.agent_id
    JOIN agents_platform.website_sessions session ON session.id=$5 AND session.deployment_id=c.deployment_id
    JOIN agents_platform.website_deployments deployment ON deployment.id=c.deployment_id AND deployment.organization_id=c.organization_id AND deployment.agent_id=c.agent_id
    JOIN agents_platform.agents agent ON agent.id=c.agent_id AND agent.organization_id=c.organization_id
    WHERE c.id=$1 AND c.organization_id=$2 AND c.agent_id=$3 AND c.execution_conversation_id=$4
      AND c.channel_kind='website' AND c.deployment_id=$6 AND session.expires_at>now()
      AND execution.deleted_at IS NULL AND agent.deleted_at IS NULL AND deployment.revoked_at IS NULL AND deployment.paused=false
      AND (($7::uuid IS NULL AND c.session_id=$8) OR EXISTS(SELECT 1 FROM agents_platform.customer_task_links link
        JOIN agents_platform.tasks task ON task.id=link.task_id AND task.organization_id=c.organization_id AND task.conversation_id=execution.id
        WHERE link.task_id=$7 AND link.conversation_id=c.id AND task.parent_task_id IS NULL
          AND task.principal->>'kind'='visitor' AND task.principal->>'deploymentId'=$6::text AND task.principal->>'sessionId'=$8::text))
    FOR SHARE OF c,execution,session,deployment,agent`, [input.customerConversationId,input.organizationId,input.agentId,input.executionConversationId,
    input.current.sessionId,input.current.deploymentId,input.originTaskId ?? null,input.origin.sessionId])).rows[0];
  if (!row) return false;
  if (row.session_id !== input.origin.sessionId && await followupAccess(db,input.origin,input.customerConversationId) !== input.customerConversationId) return false;
  return row.session_id === input.current.sessionId || await followupAccess(db,input.current,input.customerConversationId) === input.customerConversationId;
}
