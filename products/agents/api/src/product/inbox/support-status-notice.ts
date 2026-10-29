import type { PoolClient } from "pg";
import { requestDigest } from "../../contracts/contracts";

export interface StatusNoticeBinding {
  taskId: string;
  organizationId: string;
  conversationId: string;
  inputMessageId: string;
  episodeCommandId: string;
  ownershipGeneration: string;
}
// This must check the durable operation's evidence manifest and the current support
// facts used for its claims. Absence or withdrawal of either denies publication.
export type StatusEvidenceVerifier = (db: PoolClient, binding: StatusNoticeBinding, body: string) => Promise<boolean>;
export type StatusMessageAppender = (db: PoolClient, binding: StatusNoticeBinding, body: string) => Promise<string>;

async function authorized(db: PoolClient, binding: StatusNoticeBinding, body: string, verify: StatusEvidenceVerifier, historical = false): Promise<boolean> {
  if (!body.trim() || Buffer.byteLength(body)>4096) return false;
  // Callers lock the conversation first, matching the Inbox command lock order.
  const rows=await db.query(`SELECT op.output FROM agents_platform.support_status_executions s
    JOIN agents_platform.tasks t ON t.id=s.task_id AND t.organization_id=s.organization_id
    JOIN agents_platform.operations op ON op.task_id=s.task_id AND op.id='support-status:'||s.task_id::text
    JOIN agents_platform.customer_conversations c ON c.id=s.conversation_id AND c.organization_id=s.organization_id
    JOIN agents_platform.agents a ON a.id=c.agent_id AND a.organization_id=c.organization_id
    JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.organization_id=c.organization_id AND v.agent_id=c.agent_id
    JOIN agents_platform.customer_messages m ON m.id=s.input_message_id AND m.conversation_id=c.id
    JOIN agents_platform.support_waiting w ON w.task_id=s.episode_command_id AND w.conversation_id=c.id
    JOIN agents_platform.customer_commands command ON command.conversation_id=c.id AND command.command_id=w.task_id
    JOIN agents_platform.execution_grants g ON g.id=t.grant_id AND g.organization_id=t.organization_id
    WHERE s.task_id=$1 AND s.organization_id=$2 AND s.conversation_id=$3 AND s.input_message_id=$4
      AND s.episode_command_id=$5 AND s.ownership_generation=$6
      AND t.execution_purpose='support_status_v1' AND t.root_task_id=t.id
      ${historical ? "" : "AND t.state IN ('accepted','running','completed') AND t.deadline_at>clock_timestamp() AND NOT EXISTS (SELECT 1 FROM agents_platform.customer_cancellations cancellation WHERE cancellation.task_id=t.id AND cancellation.completed_at IS NULL)"}
      AND g.revoked_at IS NULL ${historical ? "" : "AND g.expires_at>clock_timestamp()"}
      AND g.principal=t.principal AND g.product=t.product AND g.resource_id=t.resource_id AND g.version_id=t.version_id AND g.caller_client_id=t.caller_client_id
      AND op.kind='model' AND op.name='model.support_status' AND op.state='completed'
      ${historical ? "" : "AND c.state='handoff_pending' AND c.ownership_generation=s.ownership_generation"}
      AND c.execution_conversation_id=t.conversation_id AND m.author_kind='visitor' AND m.ownership_generation=s.ownership_generation
      AND w.ownership_generation<=s.ownership_generation
      AND command.result->>'ownership_generation'=w.ownership_generation::text
      AND ((w.source_task_id=w.task_id AND w.source_message_id IS NULL AND command.action='request_handoff'
        ${historical ? "" : "AND (v.configuration->'tools') ? 'channel.request_handoff'"})
        OR (w.source_message_id=w.task_id AND w.source_task_id IS NULL AND command.action='message_handoff'
          AND EXISTS (SELECT 1 FROM agents_platform.customer_messages origin WHERE origin.id=w.source_message_id
            AND origin.conversation_id=c.id AND origin.author_kind='visitor' AND origin.ownership_generation+1=w.ownership_generation)))
      ${historical ? "" : "AND a.deleted_at IS NULL"}
      ${historical ? "" : `AND NOT EXISTS (SELECT 1 FROM agents_platform.support_waiting newer_episode WHERE newer_episode.conversation_id=c.id
        AND newer_episode.ownership_generation>w.ownership_generation)
      AND NOT EXISTS (SELECT 1 FROM agents_platform.customer_messages human WHERE human.conversation_id=c.id
        AND human.author_kind='human' AND human.ownership_generation>=w.ownership_generation)
      AND NOT EXISTS (SELECT 1 FROM agents_platform.customer_messages newer WHERE newer.conversation_id=c.id
        AND newer.author_kind='visitor' AND newer.sequence>m.sequence)`}
      AND ((c.channel_kind='website' AND EXISTS (SELECT 1 FROM agents_platform.website_deployments d
        JOIN agents_platform.website_sessions session ON session.id::text=t.principal->>'sessionId' AND session.deployment_id=d.id
        WHERE d.id=c.deployment_id AND d.organization_id=c.organization_id AND d.agent_id=c.agent_id ${historical ? "" : "AND d.version_id=t.version_id AND d.revoked_at IS NULL AND d.paused=false AND session.expires_at>clock_timestamp()"}
          AND t.principal->>'kind'='visitor' AND t.principal->>'deploymentId'=d.id::text AND t.principal->>'sessionId'=session.id::text
          AND t.resource_id=d.id::text FOR SHARE OF d,session))
        OR (c.channel_kind<>'website' AND EXISTS (SELECT 1 FROM agents_platform.channel_deployments d
          JOIN agents_platform.channel_connections conn ON conn.id=d.connection_id AND conn.organization_id=d.organization_id
          WHERE d.id=c.channel_deployment_id AND d.organization_id=c.organization_id AND d.agent_id=c.agent_id ${historical ? "" : "AND d.version_id=t.version_id AND d.state='active' AND conn.state='active'"}
          AND t.principal->>'kind'='channel_customer' AND t.principal->>'deploymentId'=d.id::text AND t.principal->>'participantId'=c.id::text
          AND t.resource_id=d.id::text FOR SHARE OF d,conn)))
    FOR SHARE OF s,t,op,c,m,w,g,a,v,command`,[binding.taskId,binding.organizationId,binding.conversationId,binding.inputMessageId,binding.episodeCommandId,binding.ownershipGeneration]);
  const output=rows.rows[0]?.output;
  if (!output || output.finishReason !== "stop" || output.message?.role !== "assistant" || output.message?.tool_calls?.length || typeof output.message?.content !== "string") return false;
  let parsed: unknown;
  try { parsed=JSON.parse(output.message.content); } catch { return false; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || (parsed as {reply?:unknown}).reply !== body) return false;
  return await verify(db,binding,body);
}

// Caller uses one transaction; appender writes the canonical message and delivery
// intent in this transaction. Never call this for an ordinary assistant operation.
export async function publishSupportStatus(db: PoolClient, binding: StatusNoticeBinding, body: string, verify: StatusEvidenceVerifier, append: StatusMessageAppender): Promise<string | null> {
  await db.query("SELECT id FROM agents_platform.customer_conversations WHERE id=$1 AND organization_id=$2 FOR UPDATE", [binding.conversationId,binding.organizationId]);
  const existing=(await db.query("SELECT message_id,body_digest FROM agents_platform.support_status_notices WHERE task_id=$1",[binding.taskId])).rows[0];
  if(existing) return existing.body_digest===requestDigest(body) && await assertSupportStatusNotice(db,binding,existing.message_id,body,verify) ? existing.message_id : null;
  if (!await authorized(db,binding,body,verify)) return null;
  const messageId=await append(db,binding,body);
  const canonical=(await db.query(`SELECT 1 FROM agents_platform.customer_messages WHERE id=$1 AND conversation_id=$2
    AND author_kind='assistant' AND body=$3 AND ownership_generation=$4 AND request_key='support-status:'||$5::text`,
    [messageId,binding.conversationId,body,binding.ownershipGeneration,binding.taskId])).rowCount;
  if (!canonical) throw new Error("SUPPORT_STATUS_PUBLICATION_INVALID");
  await db.query(`INSERT INTO agents_platform.support_status_notices(task_id,message_id,conversation_id,organization_id,ownership_generation,body_digest)
    VALUES($1,$2,$3,$4,$5,$6)`,[binding.taskId,messageId,binding.conversationId,binding.organizationId,binding.ownershipGeneration,requestDigest(body)]);
  return messageId;
}

// Dispatch must recheck the current ownership and support facts.
export async function assertSupportStatusNotice(db: PoolClient, binding: StatusNoticeBinding, messageId: string, body: string, verify: StatusEvidenceVerifier): Promise<boolean> {
  return assertNotice(db,binding,messageId,body,verify,false);
}

// Historical visibility is scoped by the calling Inbox's staff/visitor authorization.
// The verifier must recheck original evidence and request integrity, not live facts.
export async function assertSupportStatusNoticeVisible(db: PoolClient, binding: StatusNoticeBinding, messageId: string, body: string, verifyHistorical: StatusEvidenceVerifier): Promise<boolean> {
  return assertNotice(db,binding,messageId,body,verifyHistorical,true);
}

async function assertNotice(db: PoolClient, binding: StatusNoticeBinding, messageId: string, body: string, verify: StatusEvidenceVerifier, historical: boolean): Promise<boolean> {
  const receipt=(await db.query(`SELECT 1 FROM agents_platform.support_status_notices n
    JOIN agents_platform.customer_messages m ON m.id=n.message_id AND m.conversation_id=n.conversation_id
    WHERE n.task_id=$1 AND n.message_id=$2 AND n.conversation_id=$3 AND n.organization_id=$4
      AND n.ownership_generation=$5 AND n.body_digest=$6 AND m.body=$7 AND m.author_kind='assistant'
      AND m.ownership_generation=n.ownership_generation AND m.request_key='support-status:'||n.task_id::text`,
    [binding.taskId,messageId,binding.conversationId,binding.organizationId,binding.ownershipGeneration,requestDigest(body),body])).rowCount;
  return Boolean(receipt) && await authorized(db,binding,body,verify,historical);
}
