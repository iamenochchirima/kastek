import type { Pool, PoolClient } from "pg";
import { requestDigest } from "../../contracts/contracts";
import { capabilityBindingSchema } from "../../contracts/capability-catalog";
import { transaction } from "../../infrastructure/database";

export interface ConnectedUncertainIntent {
  operationId: string; organizationId: string; taskId: string; conversationId: string;
  inputMessageId: string; ownershipGeneration: string;
}
export type ConnectedUncertainOutcome = {outcome:"recorded";commandId:string}
  | {outcome:"ownership_changed"|"authority_unavailable"};
export type ConnectedUncertainPublisher = (db: PoolClient, intent: ConnectedUncertainIntent) => Promise<ConnectedUncertainOutcome>;

async function defer(db: Pool | PoolClient, operationId: string, code: "authority_unavailable" | null) {
  await db.query(`UPDATE agents_platform.connected_uncertain_escalations SET last_error_code=$2,
    attempt_count=LEAST(attempt_count+1,8),
    next_attempt_at=CASE WHEN attempt_count+1>=8 THEN NULL ELSE now()+make_interval(secs=>LEAST(1800,30*power(2,attempt_count)::integer)) END,
    updated_at=now() WHERE operation_id=$1 AND state='pending'`,[operationId,code]);
}
// Only a previously claimed, customer-scoped managed write can produce an intent.
// A claim is evidence of a possible effect, never proof that the provider wrote.
async function source(db: PoolClient, operationId: string, lock = true) {
  const row=(await db.query(`SELECT r.*,r.request_digest AS connected_digest,review.id AS review_id,
    review.binding_digest,review.request_digest AS review_digest,review.arguments,review.state AS review_state,review.connection_policy_revision,
    review.approved_at,review.claimed_at,review.expires_at AS review_expires_at,
    b.binding,b.digest AS catalog_binding_digest,t.principal,t.product,t.channel_binding,t.root_task_id AS task_root,
    l.conversation_id,l.input_message_id,l.ownership_generation
    FROM agents_platform.connected_reads r
    JOIN agents_platform.tool_invocation_reviews review ON review.task_id=r.task_id AND review.operation_id=r.operation_id
      AND review.organization_id=r.organization_id AND review.root_task_id=r.root_task_id AND review.binding_id=r.binding_id AND review.connection_id=r.connection_id
    JOIN agents_platform.capability_bindings b ON b.id=r.binding_id AND b.organization_id=r.organization_id AND b.connection_id=r.connection_id
    JOIN agents_platform.tasks t ON t.id=r.task_id AND t.organization_id=r.organization_id
    JOIN agents_platform.customer_task_links l ON l.task_id=t.id
    JOIN agents_platform.customer_messages m ON m.id=l.input_message_id AND m.conversation_id=l.conversation_id
    JOIN agents_platform.customer_conversations c ON c.id=l.conversation_id AND c.organization_id=r.organization_id
    WHERE r.operation_id=$1 AND r.state IN ('started','uncertain')
      AND t.root_task_id=t.id AND t.product='agents' AND t.principal->>'kind' IN ('visitor','channel_customer')
      AND t.channel_binding->>'customerConversationId'=l.conversation_id::text
      AND t.channel_binding->>'inputMessageId'=l.input_message_id::text
      AND t.channel_binding->>'ownershipGeneration'=l.ownership_generation::text
      AND m.author_kind='visitor' AND m.ownership_generation=l.ownership_generation
      AND review.state IN ('claimed','uncertain') AND review.approved_at IS NOT NULL AND review.claimed_at IS NOT NULL AND review.claimed_at<review.expires_at
      AND b.binding->'connection'->>'profileId'='hubspot-contacts-v1' AND b.binding->'policy'->>'effect'='reviewed_write'
    ${lock ? "FOR UPDATE OF r,review" : ""}`,[operationId])).rows[0];
  if(!row)return null;
  const parsed=capabilityBindingSchema.safeParse(row.binding);
  if(!parsed.success || parsed.data.id!==row.binding_id || parsed.data.digest!==row.binding_digest || row.catalog_binding_digest!==row.binding_digest
    || row.review_digest!==requestDigest({bindingDigest:row.binding_digest,arguments:row.arguments})
    || row.connected_digest!==requestDigest({bindingId:row.binding_id,bindingDigest:row.binding_digest,args:row.arguments})) return null;
  return row;
}
function claimDigest(row: Record<string,any>) {
  return requestDigest({operationId:row.operation_id,organizationId:row.organization_id,taskId:row.task_id,rootTaskId:row.root_task_id,
    bindingId:row.binding_id,bindingDigest:row.binding_digest,connectionId:row.connection_id,connectedDigest:row.connected_digest,
    reviewId:row.review_id,reviewDigest:row.review_digest,connectionPolicyRevision:row.connection_policy_revision,
    approvedAt:row.approved_at.toISOString(),claimedAt:row.claimed_at.toISOString(),reviewExpiresAt:row.review_expires_at.toISOString()});
}

// Caller may invoke this in the same transaction which marks connected_reads
// uncertain. Expired started claims are also converted under the same lock.
export async function captureConnectedUncertain(db: PoolClient, operationId: string): Promise<boolean> {
  const location=(await db.query("SELECT organization_id FROM agents_platform.connected_reads WHERE operation_id=$1",[operationId])).rows[0];
  if(!location)return false;
  await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[location.organization_id]);
  const row=await source(db,operationId);
  if(!row)return false;
  if(row.state==="started") {
    const updated=await db.query(`UPDATE agents_platform.connected_reads SET state='uncertain',error_code='CONNECTED_READ_UNCERTAIN',updated_at=now()
      WHERE operation_id=$1 AND state='started' AND claim_expires_at<=clock_timestamp() RETURNING operation_id`,[operationId]);
    if(!updated.rowCount)return false;
  }
  const digest=claimDigest(row);
  const inserted=await db.query(`INSERT INTO agents_platform.connected_uncertain_escalations(operation_id,organization_id,task_id,conversation_id,input_message_id,ownership_generation,claim_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id`,
    [operationId,row.organization_id,row.task_id,row.conversation_id,row.input_message_id,row.ownership_generation,digest]);
  if(inserted.rowCount)return true;
  const existing=(await db.query("SELECT claim_digest FROM agents_platform.connected_uncertain_escalations WHERE operation_id=$1",[operationId])).rows[0];
  if(existing?.claim_digest!==digest)throw new Error("CONNECTED_ESCALATION_CONFLICT");
  return true;
}

// Scanning is recovery only. It never invokes a provider or retries a write.
export async function captureConnectedUncertainBatch(pool: Pool, limit=20): Promise<number> {
  const rows=(await pool.query(`SELECT r.operation_id FROM agents_platform.connected_reads r
    JOIN agents_platform.tool_invocation_reviews review ON review.task_id=r.task_id AND review.operation_id=r.operation_id
    JOIN agents_platform.capability_bindings b ON b.id=r.binding_id AND b.organization_id=r.organization_id
    JOIN agents_platform.tasks t ON t.id=r.task_id AND t.organization_id=r.organization_id
    JOIN agents_platform.customer_task_links l ON l.task_id=t.id
    WHERE (r.state='uncertain' OR (r.state='started' AND r.claim_expires_at<=clock_timestamp()))
      AND review.state IN ('claimed','uncertain') AND review.claimed_at IS NOT NULL
      AND t.product='agents' AND t.root_task_id=t.id AND t.principal->>'kind' IN ('visitor','channel_customer')
      AND b.binding->'connection'->>'profileId'='hubspot-contacts-v1' AND b.binding->'policy'->>'effect'='reviewed_write'
      AND NOT EXISTS(SELECT 1 FROM agents_platform.connected_uncertain_escalations e WHERE e.operation_id=r.operation_id)
    ORDER BY r.updated_at,r.operation_id LIMIT $1`,[limit])).rows;
  let count=0;
  for(const row of rows) if(await transaction(pool,db=>captureConnectedUncertain(db,row.operation_id)))count++;
  return count;
}

export async function processConnectedUncertain(pool: Pool, operationId: string, publish: ConnectedUncertainPublisher): Promise<string> {
  return transaction(pool,async db=>{
    const location=(await db.query("SELECT organization_id,conversation_id FROM agents_platform.connected_uncertain_escalations WHERE operation_id=$1",[operationId])).rows[0];
    if(!location)return "missing";
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[location.organization_id]);
    await db.query("SELECT id FROM agents_platform.customer_conversations WHERE id=$1 AND organization_id=$2 FOR UPDATE",[location.conversation_id,location.organization_id]);
    const intent=(await db.query("SELECT * FROM agents_platform.connected_uncertain_escalations WHERE operation_id=$1 FOR UPDATE",[operationId])).rows[0];
    if(!intent)return "missing";
    if(intent.state!=="pending")return intent.state;
    const prior=await source(db,operationId);
    if(!prior || prior.state!=="uncertain" || claimDigest(prior)!==intent.claim_digest) throw new Error("CONNECTED_ESCALATION_PROVENANCE_INVALID");
    const authority=(await db.query(`SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.execution_grants g ON g.id=t.grant_id AND g.organization_id=t.organization_id
      JOIN agents_platform.customer_conversations c ON c.id=$2 AND c.organization_id=t.organization_id
      JOIN agents_platform.agents a ON a.id=c.agent_id AND a.organization_id=c.organization_id AND a.deleted_at IS NULL
      JOIN agents_platform.connections connected ON connected.id=$3 AND connected.organization_id=t.organization_id
      WHERE t.id=$1 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND g.principal=t.principal
        AND g.version_id=t.version_id AND g.product=t.product AND g.resource_id=t.resource_id AND g.caller_client_id=t.caller_client_id
        AND connected.state='active' AND connected.policy_revision=$4
        AND ((c.channel_kind='website' AND t.principal->>'kind'='visitor' AND t.principal->>'deploymentId'=c.deployment_id::text
          AND t.principal->>'sessionId'=c.session_id::text AND t.resource_id=c.deployment_id::text
          AND EXISTS(SELECT 1 FROM agents_platform.website_deployments d JOIN agents_platform.website_sessions s ON s.id=c.session_id AND s.deployment_id=d.id
            WHERE d.id=c.deployment_id AND d.organization_id=c.organization_id AND d.revoked_at IS NULL AND d.paused=false AND s.expires_at>clock_timestamp() FOR SHARE OF d,s))
          OR (c.channel_kind<>'website' AND t.principal->>'kind'='channel_customer' AND t.principal->>'deploymentId'=c.channel_deployment_id::text
          AND t.principal->>'participantId'=c.id::text AND t.resource_id=c.channel_deployment_id::text
          AND EXISTS(SELECT 1 FROM agents_platform.channel_deployments d JOIN agents_platform.channel_connections cn ON cn.id=d.connection_id AND cn.organization_id=d.organization_id
            WHERE d.id=c.channel_deployment_id AND d.organization_id=c.organization_id AND d.state='active' AND cn.state='active' FOR SHARE OF d,cn)))
      FOR SHARE OF t,g,a,connected`,[intent.task_id,intent.conversation_id,prior.connection_id,prior.connection_policy_revision])).rowCount;
    const binding:ConnectedUncertainIntent={operationId,organizationId:intent.organization_id,taskId:intent.task_id,conversationId:intent.conversation_id,inputMessageId:intent.input_message_id,ownershipGeneration:intent.ownership_generation};
    const result=authority ? await publish(db,binding) : {outcome:"authority_unavailable" as const};
    if(result.outcome==="authority_unavailable") {
      // Retain the cause for staff after bounded retries; do not hot-loop on expired grants.
      await defer(db,operationId,"authority_unavailable");
      return result.outcome;
    }
    if(result.outcome==="recorded") {
      const command=(await db.query("SELECT 1 FROM agents_platform.customer_commands WHERE conversation_id=$1 AND command_id=$2 AND action='request_handoff' FOR SHARE",[intent.conversation_id,result.commandId])).rowCount;
      if(!command)throw new Error("CONNECTED_ESCALATION_COMMAND_INVALID");
    }
    await db.query("UPDATE agents_platform.connected_uncertain_escalations SET state=$2,command_id=$3,last_error_code=NULL,updated_at=now() WHERE operation_id=$1",[operationId,result.outcome,result.outcome==="recorded"?result.commandId:null]);
    return result.outcome;
  });
}

// Each operation is re-locked during processing. Concurrent workers may read
// the same batch, but only the first pending owner can publish an outcome.
export async function processConnectedUncertainBatch(pool: Pool, publish: ConnectedUncertainPublisher, limit=20, onError?: (code:string)=>void): Promise<number> {
  const rows=(await pool.query(`SELECT operation_id FROM agents_platform.connected_uncertain_escalations
    WHERE state='pending' AND next_attempt_at<=now() ORDER BY next_attempt_at,operation_id LIMIT $1`,[limit])).rows;
  let count=0;
  for(const row of rows) {
    try {
      const outcome=await processConnectedUncertain(pool,row.operation_id,publish);
      if(outcome==="recorded" || outcome==="ownership_changed") count++;
    } catch {
      await defer(pool,row.operation_id,null);
      onError?.("CONNECTED_ESCALATION_RETRY");
    }
  }
  return count;
}
