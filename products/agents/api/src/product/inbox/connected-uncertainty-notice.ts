import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { assertCustomerNativeBindings } from "../../capabilities/connected-tools/customer-native-policy";
import { transaction } from "../../infrastructure/database";
import { enqueueChannelMessage } from "../channels/channel-outbound";
import { HANDOFF_RECEIPT } from "./handoff-receipt";

export const CONNECTED_UNCERTAINTY_NOTICE = "We couldn't confirm whether your details were saved. We've asked the support team to check.";
export function connectedUncertaintyRequestKey(operationId: string): string { return `connected-uncertainty:${requestDigest(operationId)}`; }

// Caller authorizes the visitor/staff scope separately. Historical reads retain
// original provenance; sending additionally requires the current live fence.
async function authority(db: PoolClient, operationId: string, mode: "live"|"history") {
  const row=(await db.query(`SELECT c.*,e.command_id,e.task_id,e.ownership_generation AS source_generation,w.ownership_generation AS handoff_generation,
    e.claim_digest,r.root_task_id,r.binding_id,r.connection_id,r.request_digest AS connected_digest,
    review.id AS review_id,review.binding_digest,review.request_digest AS review_digest,review.arguments,review.connection_policy_revision,
    review.approved_at,review.claimed_at,review.expires_at AS review_expires_at
    FROM agents_platform.connected_uncertain_escalations e
    JOIN agents_platform.connected_reads r ON r.operation_id=e.operation_id AND r.task_id=e.task_id AND r.organization_id=e.organization_id AND r.state='uncertain'
    JOIN agents_platform.tool_invocation_reviews review ON review.task_id=r.task_id AND review.operation_id=r.operation_id AND review.organization_id=r.organization_id
      AND review.binding_id=r.binding_id AND review.connection_id=r.connection_id
    JOIN agents_platform.capability_bindings b ON b.id=r.binding_id AND b.organization_id=e.organization_id
    JOIN agents_platform.customer_conversations c ON c.id=e.conversation_id AND c.organization_id=e.organization_id
    JOIN agents_platform.customer_task_links l ON l.task_id=e.task_id AND l.conversation_id=e.conversation_id AND l.input_message_id=e.input_message_id AND l.ownership_generation=e.ownership_generation
    JOIN agents_platform.customer_messages input ON input.id=l.input_message_id AND input.conversation_id=c.id AND input.author_kind='visitor' AND input.ownership_generation=l.ownership_generation
    JOIN agents_platform.customer_commands cmd ON cmd.conversation_id=e.conversation_id AND cmd.command_id=e.command_id AND cmd.action='request_handoff'
    JOIN agents_platform.customer_messages receipt ON receipt.id::text=cmd.result->>'handoffReceiptId' AND receipt.conversation_id=c.id AND receipt.task_id=cmd.command_id AND receipt.body=$2
    JOIN agents_platform.support_waiting w ON w.task_id=cmd.command_id AND w.conversation_id=c.id AND w.source_task_id=e.task_id AND w.ownership_generation=e.ownership_generation+1
    JOIN agents_platform.tasks t ON t.id=e.task_id AND t.organization_id=e.organization_id AND t.root_task_id=t.id
    JOIN agents_platform.execution_grants g ON g.id=t.grant_id AND g.organization_id=t.organization_id
    JOIN agents_platform.agents a ON a.id=c.agent_id AND a.organization_id=c.organization_id
    WHERE e.operation_id=$1 AND e.state='recorded' AND e.command_id=e.task_id
      AND review.state IN ('claimed','uncertain') AND review.approved_at IS NOT NULL AND review.claimed_at IS NOT NULL AND review.claimed_at<review.expires_at
      AND b.binding->'connection'->>'profileId'='hubspot-contacts-v1' AND b.binding->'policy'->>'effect'='reviewed_write'
      AND b.digest=review.binding_digest AND g.revoked_at IS NULL AND g.principal=t.principal AND g.product=t.product AND g.version_id=t.version_id
      AND g.resource_id=t.resource_id AND g.caller_client_id=t.caller_client_id
      AND t.channel_binding->>'customerConversationId'=c.id::text AND t.channel_binding->>'inputMessageId'=input.id::text
      AND t.channel_binding->>'ownershipGeneration'=l.ownership_generation::text
      ${mode==="history" ? "" : `AND c.state='handoff_pending' AND c.ownership_generation=w.ownership_generation
        AND a.deleted_at IS NULL AND g.expires_at>clock_timestamp()
        AND (g.operations ? 'connected.execute') AND r.binding_id=ANY(g.connected_tool_binding_ids)
        AND EXISTS(SELECT 1 FROM agents_platform.version_connected_tools vb WHERE vb.organization_id=e.organization_id AND vb.version_id=t.version_id AND vb.binding_id=r.binding_id)
        AND EXISTS(SELECT 1 FROM agents_platform.connections conn JOIN agents_platform.native_provider_connections native
          ON native.connection_id=conn.id AND native.organization_id=conn.organization_id
          WHERE conn.id=r.connection_id AND conn.organization_id=e.organization_id AND conn.state='active' AND conn.expires_at>clock_timestamp()
            AND conn.profile_id='hubspot-contacts-v1' AND conn.policy_revision=review.connection_policy_revision
            AND native.status='ready' AND native.sharing='organization_service' AND 'contacts.create'=ANY(native.selected_operations)
            AND native.token_expires_at>clock_timestamp()
            AND EXISTS(SELECT 1 FROM agents_platform.connection_credentials cred WHERE cred.connection_id=conn.id AND cred.revision=conn.revision AND cred.envelope IS NOT NULL FOR SHARE)
            AND r.binding_id=ANY(native.binding_ids) FOR SHARE OF conn,native)
        AND NOT EXISTS(SELECT 1 FROM agents_platform.connected_reconciliation_attempts matched WHERE matched.operation_id=e.operation_id AND matched.state='found')
        AND NOT EXISTS(SELECT 1 FROM agents_platform.customer_messages human WHERE human.conversation_id=c.id AND human.author_kind='human' AND human.ownership_generation>=w.ownership_generation)`}
      AND ((c.channel_kind='website' AND t.principal->>'kind'='visitor' AND t.principal->>'deploymentId'=c.deployment_id::text
        AND t.principal->>'sessionId'=c.session_id::text AND t.resource_id=c.deployment_id::text
        AND EXISTS(SELECT 1 FROM agents_platform.website_deployments d JOIN agents_platform.website_sessions s ON s.id=c.session_id AND s.deployment_id=d.id
          WHERE d.id=c.deployment_id AND d.organization_id=c.organization_id ${mode==="history" ? "" : "AND d.revoked_at IS NULL AND d.paused=false AND s.expires_at>clock_timestamp() AND d.agent_id=c.agent_id AND d.version_id=t.version_id"} FOR SHARE OF d,s))
        OR (c.channel_kind<>'website' AND t.principal->>'kind'='channel_customer' AND t.principal->>'deploymentId'=c.channel_deployment_id::text
        AND t.principal->>'participantId'=c.id::text AND t.resource_id=c.channel_deployment_id::text
        AND EXISTS(SELECT 1 FROM agents_platform.channel_deployments d JOIN agents_platform.channel_connections cn ON cn.id=d.connection_id AND cn.organization_id=d.organization_id
          WHERE d.id=c.channel_deployment_id AND d.organization_id=c.organization_id ${mode==="history" ? "" : "AND d.state='active' AND cn.state='active' AND d.agent_id=c.agent_id AND d.version_id=t.version_id"} FOR SHARE OF d,cn)))
    FOR SHARE OF e,r,review,b,c,l,input,cmd,receipt,w,t,g,a`,[operationId,HANDOFF_RECEIPT])).rows[0];
  if(!row)return null;
  const claimDigest=requestDigest({operationId,organizationId:row.organization_id,taskId:row.task_id,rootTaskId:row.root_task_id,
    bindingId:row.binding_id,bindingDigest:row.binding_digest,connectionId:row.connection_id,connectedDigest:row.connected_digest,
    reviewId:row.review_id,reviewDigest:row.review_digest,connectionPolicyRevision:row.connection_policy_revision,
    approvedAt:row.approved_at.toISOString(),claimedAt:row.claimed_at.toISOString(),reviewExpiresAt:row.review_expires_at.toISOString()});
  if(row.claim_digest!==claimDigest || row.review_digest!==requestDigest({bindingDigest:row.binding_digest,arguments:row.arguments})
    || row.connected_digest!==requestDigest({bindingId:row.binding_id,bindingDigest:row.binding_digest,args:row.arguments}))return null;
  if(mode==="live") {
    try { await assertCustomerNativeBindings(db,row.organization_id,[row.binding_id]); }
    catch(error) { if(error instanceof PlatformError)return null;throw error; }
  }
  return row;
}

export async function assertConnectedUncertaintyNotice(db: PoolClient, operationId: string, messageId: string, mode: "send"|"history"): Promise<boolean> {
  const provenance=(await db.query(`SELECT n.ownership_generation FROM agents_platform.connected_uncertainty_notices n
    JOIN agents_platform.customer_messages m ON m.id=n.message_id AND m.conversation_id=n.conversation_id
    JOIN agents_platform.connected_uncertain_escalations e ON e.operation_id=n.operation_id
      AND e.organization_id=n.organization_id AND e.conversation_id=n.conversation_id AND e.command_id=n.command_id
    WHERE n.operation_id=$1 AND n.message_id=$2 AND m.task_id IS NULL AND m.author_kind='assistant'
      AND m.ownership_generation=n.ownership_generation AND m.body=$3 AND m.request_key=$4
    FOR SHARE OF n,m`,[operationId,messageId,CONNECTED_UNCERTAINTY_NOTICE,connectedUncertaintyRequestKey(operationId)])).rows[0];
  if(!provenance)return false;
  const current=await authority(db,operationId,mode==="send"?"live":"history");
  return Boolean(current && provenance.ownership_generation===current.handoff_generation && (mode==="history" || current.ownership_generation===current.handoff_generation));
}

export async function publishConnectedUncertaintyUpdate(pool: Pool, operationId: string): Promise<"published"|"already_published"|"suppressed"|"not_ready"> {
  return transaction(pool,async db=>{
    const location=(await db.query("SELECT organization_id,conversation_id FROM agents_platform.connected_uncertain_escalations WHERE operation_id=$1",[operationId])).rows[0];
    if(!location)return "not_ready";
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[location.organization_id]);
    await db.query("SELECT id FROM agents_platform.customer_conversations WHERE id=$1 AND organization_id=$2 FOR UPDATE",[location.conversation_id,location.organization_id]);
    // Reconciliation takes a share lock on this row before recording 'found'.
    const escalation=(await db.query("SELECT state FROM agents_platform.connected_uncertain_escalations WHERE operation_id=$1 FOR UPDATE",[operationId])).rows[0];
    if(escalation?.state!=="recorded")return "not_ready";
    if((await db.query("SELECT 1 FROM agents_platform.connected_uncertainty_notices WHERE operation_id=$1",[operationId])).rowCount)return "already_published";
    const conversation=await authority(db,operationId,"live");
    if(!conversation)return "suppressed";
    const message=(await db.query(`INSERT INTO agents_platform.customer_messages(id,conversation_id,sequence,author_kind,body,request_key,request_digest,ownership_generation)
      VALUES($1,$2,$3,'assistant',$4,$5,$6,$7) RETURNING *`,[randomUUID(),conversation.id,conversation.next_sequence,CONNECTED_UNCERTAINTY_NOTICE,connectedUncertaintyRequestKey(operationId),requestDigest(CONNECTED_UNCERTAINTY_NOTICE),conversation.ownership_generation])).rows[0];
    await db.query("UPDATE agents_platform.customer_conversations SET next_sequence=next_sequence+1,updated_at=now() WHERE id=$1",[conversation.id]);
    await db.query(`INSERT INTO agents_platform.connected_uncertainty_notices(operation_id,organization_id,conversation_id,command_id,message_id,ownership_generation)
      VALUES($1,$2,$3,$4,$5,$6)`,[operationId,conversation.organization_id,conversation.id,conversation.command_id,message.id,conversation.ownership_generation]);
    await enqueueChannelMessage(db,conversation,message);
    return "published";
  });
}

export async function publishConnectedUncertaintyBatch(pool: Pool, limit=20, onError?: (code:string)=>void): Promise<number> {
  // Keyset traversal prevents denied or temporarily unready rows from blocking later work.
  let after="",count=0;
  while(count<limit) {
    const row=(await pool.query(`SELECT e.operation_id FROM agents_platform.connected_uncertain_escalations e
      JOIN agents_platform.customer_conversations c ON c.id=e.conversation_id AND c.organization_id=e.organization_id
      JOIN agents_platform.support_waiting w ON w.task_id=e.command_id AND w.conversation_id=c.id
      JOIN agents_platform.tasks t ON t.id=e.task_id AND t.organization_id=e.organization_id
      JOIN agents_platform.execution_grants g ON g.id=t.grant_id AND g.organization_id=t.organization_id
      WHERE e.state='recorded' AND e.operation_id>$1 AND c.state='handoff_pending' AND c.ownership_generation=w.ownership_generation
        AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM agents_platform.connected_reconciliation_attempts matched WHERE matched.operation_id=e.operation_id AND matched.state='found')
        AND NOT EXISTS(SELECT 1 FROM agents_platform.customer_messages human WHERE human.conversation_id=c.id AND human.author_kind='human' AND human.ownership_generation>=w.ownership_generation)
        AND NOT EXISTS(SELECT 1 FROM agents_platform.connected_uncertainty_notices n WHERE n.operation_id=e.operation_id)
      ORDER BY e.operation_id LIMIT 1`,[after])).rows[0];
    if(!row)break;
    after=row.operation_id;
    try { if(await publishConnectedUncertaintyUpdate(pool,row.operation_id)==="published")count++; }
    catch { onError?.("CONNECTED_UNCERTAINTY_NOTICE_RETRY"); }
  }
  return count;
}
