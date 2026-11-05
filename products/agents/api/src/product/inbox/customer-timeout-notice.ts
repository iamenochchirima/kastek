import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {requestDigest} from "../../contracts/contracts";
import {transaction} from "../../infrastructure/database";
import {enqueueChannelMessage} from "../channels/channel-outbound";

export const CUSTOMER_TIMEOUT_NOTICE="We couldn't confirm the outcome. Please check before trying again.";
const key=(taskId:string)=>`timeout-notice:${taskId}`;

/** Check the immutable origin on reads; live sends additionally fence later activity. */
export async function assertCustomerTimeoutNotice(db:PoolClient,messageId:string,live:boolean):Promise<boolean>{
 const row=await db.query(`SELECT 1 FROM agents_platform.customer_timeout_notices n
 JOIN agents_platform.tasks t ON t.id=n.task_id AND t.organization_id=n.organization_id AND t.root_task_id=t.id
 JOIN agents_platform.execution_grants g ON g.id=t.grant_id AND g.organization_id=t.organization_id AND g.principal=t.principal AND g.product=t.product AND g.version_id=t.version_id AND g.resource_id=t.resource_id AND g.caller_client_id=t.caller_client_id
 JOIN agents_platform.customer_conversations c ON c.id=n.conversation_id AND c.organization_id=n.organization_id
 JOIN agents_platform.customer_task_links l ON l.task_id=t.id AND l.conversation_id=c.id AND l.input_message_id=n.input_message_id AND l.ownership_generation=n.ownership_generation
 JOIN agents_platform.customer_messages i ON i.id=n.input_message_id AND i.conversation_id=c.id AND i.author_kind='visitor'
 JOIN agents_platform.customer_messages m ON m.id=n.message_id AND m.conversation_id=c.id AND m.author_kind='assistant'
 WHERE n.message_id=$1 AND c.channel_kind<>'website' AND m.body=$2 AND m.request_key='timeout-notice:'||t.id::text
 AND m.task_id IS NULL AND m.ownership_generation=n.ownership_generation
 AND t.principal->>'kind'='channel_customer' AND t.principal->>'deploymentId'=c.channel_deployment_id::text
 AND t.principal->>'participantId'=c.id::text AND (g.operations ? 'model.reply')
 AND EXISTS(SELECT 1 FROM agents_platform.task_events e WHERE e.task_id=t.id AND e.event_key='deadline-stop' AND e.kind='cancel_requested')
 ${live?`AND g.revoked_at IS NULL AND c.state='automation_active' AND c.ownership_generation=n.ownership_generation
 AND NOT EXISTS(SELECT 1 FROM agents_platform.customer_messages newer WHERE newer.conversation_id=c.id AND newer.sequence>i.sequence AND newer.id<>m.id)
 AND EXISTS(SELECT 1 FROM agents_platform.channel_deployments d JOIN agents_platform.channel_connections cn ON cn.id=d.connection_id AND cn.organization_id=d.organization_id
  WHERE d.id=c.channel_deployment_id AND d.organization_id=c.organization_id AND d.state='active' AND cn.state='active')
 AND EXISTS(SELECT 1 FROM agents_platform.agents a WHERE a.id=c.agent_id AND a.organization_id=c.organization_id AND a.deleted_at IS NULL)` : ''}`, [messageId,CUSTOMER_TIMEOUT_NOTICE]);
 return Boolean(row.rowCount);
}

export async function publishCustomerTimeoutNotice(pool:Pool,taskId:string):Promise<boolean>{
 return transaction(pool,async db=>{
  const task=(await db.query(`SELECT t.id,t.organization_id,t.channel_binding,t.principal FROM agents_platform.tasks t
   JOIN agents_platform.execution_grants g ON g.id=t.grant_id AND g.organization_id=t.organization_id AND g.principal=t.principal AND g.product=t.product AND g.version_id=t.version_id AND g.resource_id=t.resource_id AND g.caller_client_id=t.caller_client_id
   WHERE g.revoked_at IS NULL AND (g.operations ? 'model.reply') AND t.id=$1 AND t.root_task_id=t.id AND t.principal->>'kind'='channel_customer'
    AND (t.state='cancel_requested' AND t.error_code='TASK_DEADLINE' OR t.state IN ('uncertain','cancelled','incomplete','failed'))
    AND EXISTS(SELECT 1 FROM agents_platform.task_events e WHERE e.task_id=t.id AND e.event_key='deadline-stop' AND e.kind='cancel_requested') FOR UPDATE OF t,g`,[taskId])).rows[0];
  if(!task)return false;
  if((await db.query('SELECT 1 FROM agents_platform.customer_timeout_notices WHERE task_id=$1',[taskId])).rowCount)return false;
  const row=(await db.query(`SELECT c.*,i.sequence AS input_sequence,i.id AS input_id FROM agents_platform.customer_task_links l
   JOIN agents_platform.customer_conversations c ON c.id=l.conversation_id AND c.organization_id=$2
   JOIN agents_platform.customer_messages i ON i.id=l.input_message_id AND i.conversation_id=c.id AND i.author_kind='visitor'
   WHERE l.task_id=$1 AND c.channel_kind<>'website' AND c.state='automation_active' AND c.ownership_generation=l.ownership_generation
    AND NOT EXISTS(SELECT 1 FROM agents_platform.customer_messages m WHERE m.conversation_id=c.id AND m.sequence>i.sequence)
    AND EXISTS(SELECT 1 FROM agents_platform.channel_deployments d JOIN agents_platform.channel_connections cn ON cn.id=d.connection_id AND cn.organization_id=d.organization_id WHERE d.id=c.channel_deployment_id AND d.organization_id=c.organization_id AND d.state='active' AND cn.state='active')
    AND EXISTS(SELECT 1 FROM agents_platform.agents a WHERE a.id=c.agent_id AND a.organization_id=c.organization_id AND a.deleted_at IS NULL)
   FOR UPDATE OF c`,[taskId,task.organization_id])).rows[0];
  if(!row || task.principal?.deploymentId!==row.channel_deployment_id || task.principal?.participantId!==row.id || task.channel_binding?.customerConversationId!==row.id || task.channel_binding?.inputMessageId!==row.input_id || String(task.channel_binding?.ownershipGeneration)!==String(row.ownership_generation))return false;
  const message=(await db.query(`INSERT INTO agents_platform.customer_messages(id,conversation_id,sequence,author_kind,body,request_key,request_digest,ownership_generation)
   VALUES($1,$2,$3,'assistant',$4,$5,$6,$7) RETURNING *`,[randomUUID(),row.id,row.next_sequence,CUSTOMER_TIMEOUT_NOTICE,key(taskId),requestDigest(CUSTOMER_TIMEOUT_NOTICE),row.ownership_generation])).rows[0];
  await db.query('UPDATE agents_platform.customer_conversations SET next_sequence=next_sequence+1,updated_at=now() WHERE id=$1',[row.id]);
  await db.query(`INSERT INTO agents_platform.customer_timeout_notices(task_id,organization_id,conversation_id,input_message_id,message_id,ownership_generation)
   VALUES($1,$2,$3,$4,$5,$6)`,[taskId,task.organization_id,row.id,row.input_id,message.id,row.ownership_generation]);
  await enqueueChannelMessage(db,row,message);
  return true;
 });
}
const firstTaskId="00000000-0000-0000-0000-000000000000";
let timeoutBatchAfter=firstTaskId;
export async function publishCustomerTimeoutBatch(pool:Pool,limit=20,onError?:(code:string)=>void):Promise<number>{
 let after=timeoutBatchAfter,count=0;
 for(let scanned=0;scanned<200 && count<limit;scanned++){
  const row=(await pool.query(`SELECT t.id FROM agents_platform.tasks t JOIN agents_platform.task_events e ON e.task_id=t.id AND e.event_key='deadline-stop' AND e.kind='cancel_requested'
   WHERE t.id>$1::uuid AND t.principal->>'kind'='channel_customer' AND (t.state='cancel_requested' AND t.error_code='TASK_DEADLINE' OR t.state IN ('uncertain','cancelled','incomplete','failed'))
   AND NOT EXISTS(SELECT 1 FROM agents_platform.customer_timeout_notices n WHERE n.task_id=t.id) ORDER BY t.id LIMIT 1`,[after])).rows[0];
  if(!row){timeoutBatchAfter=firstTaskId;break;}after=row.id;timeoutBatchAfter=after;
  try{if(await publishCustomerTimeoutNotice(pool,row.id))count++;}catch{onError?.('CUSTOMER_TIMEOUT_NOTICE_UNAVAILABLE');}
 }
 return count;
}
