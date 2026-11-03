import type {ProcedureDomainSnapshot} from "../../contracts/procedure-domain";
import {procedureReady} from "../../contracts/procedure-tools";
import {resolveProcedure} from "../../contracts/procedure-definitions";
import {requestHumanAssistanceSchema,updateHumanAssistanceSchema} from "../../contracts/human-assistance";
export {requestHumanAssistanceSchema,updateHumanAssistanceSchema,requestHumanAssistanceInputSchema,updateHumanAssistanceInputSchema,preferredSupportContactSchema} from "../../contracts/human-assistance";
import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {agentConfigurationSchema,PlatformError,requestDigest} from "../../contracts/contracts";
import {type ChannelBinding} from "../../contracts/channel";
import type {ProcedureEvidence,ProcedureScope} from "../../contracts/procedures";
import {supportStatusV2} from "../../capabilities/support-status-v2";
import type {CustomerConversation,CustomerMessage,HumanRequestView} from "./inbox-contracts";
export type {HumanRequestView} from "./inbox-contracts";
import {enqueueChannelMessage} from "../channels/channel-outbound";

type Db=Pool|PoolClient;
export type HumanAssistanceResult={requestId:string;status:HumanRequestView["status"];state:CustomerConversation["state"];noticeMessageId:string;supportFacts:Awaited<ReturnType<typeof supportStatusV2>>};

type Ports={assertBinding(db:Db,binding:ChannelBinding,task:{organization_id:string;version_id:string;root_task_id:string}):Promise<void>;append(db:PoolClient,row:CustomerConversation,input:{key:string;digest:string;kind:"assistant";body:string}):Promise<CustomerMessage>;cancel(db:PoolClient,id:string,generation:string,exceptTaskId?:string):Promise<void>};
const denied=()=>new PlatformError("HUMAN_ASSISTANCE_SCOPE_DENIED",403,"Human assistance is unavailable");

/** Factual receipt is committed with the request; the model remains free to continue helping. */
export function humanAssistanceNotice(facts:Awaited<ReturnType<typeof supportStatusV2>>):string {
  const opening=facts.hours.state==="closed"&&facts.nextOpening ? new Intl.DateTimeFormat("en-GB",{timeZone:facts.hours.timeZone,weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(facts.nextOpening)) : null;
  const hours=facts.hours.state==="closed" ? `Support is closed.${opening ? ` Hours resume ${opening} (${facts.hours.timeZone}).` : ""}` : facts.hours.state==="unknown" ? "Support hours are unavailable." : "Support request recorded.";
  return `${hours}${facts.hours.state==="open"?"":" Request recorded."} I can still help.`;
}
async function taskScope(db:PoolClient,row:CustomerConversation,binding:ChannelBinding,taskId:string,ports:Pick<Ports,"assertBinding">){
  const task=(await db.query(`SELECT t.organization_id,t.version_id,t.root_task_id,v.configuration FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.organization_id=t.organization_id JOIN agents_platform.execution_grants g ON g.id=t.grant_id AND g.organization_id=t.organization_id JOIN agents_platform.customer_task_links l ON l.task_id=t.id WHERE t.id=$1 AND t.root_task_id=t.id AND t.parent_task_id IS NULL AND t.organization_id=$2 AND l.conversation_id=$3 AND l.input_message_id=$4 AND l.ownership_generation=$5 AND t.channel_binding->>'customerConversationId'=$3::text AND t.channel_binding->>'inputMessageId'=$4::text AND t.channel_binding->>'ownershipGeneration'=$5::text AND g.product=t.product AND g.version_id=t.version_id AND g.principal=t.principal AND g.resource_id=t.resource_id AND g.caller_client_id=t.caller_client_id AND t.state IN ('accepted','running') AND (t.deadline_at IS NULL OR t.deadline_at>clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM agents_platform.customer_cancellations cancel WHERE cancel.task_id=t.id) AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() FOR SHARE OF t,v,g`,[taskId,row.organization_id,row.id,binding.inputMessageId,binding.ownershipGeneration])).rows[0];
  if(!task)throw denied();
  await ports.assertBinding(db,binding,task);
  return task;
}
export async function humanAssistanceSnapshot(db:PoolClient,row:CustomerConversation,scope:ProcedureScope,binding:ChannelBinding,taskId:string,ports:Pick<Ports,"assertBinding">):Promise<ProcedureDomainSnapshot>{
 if(row.id!==binding.customerConversationId||row.organization_id!==scope.organizationId||row.agent_id!==scope.agentId||row.execution_conversation_id!==scope.conversationId)throw denied();
 await taskScope(db,row,binding,taskId,ports);
 const latest=(await db.query(`SELECT v.configuration FROM agents_platform.agents a JOIN LATERAL (SELECT configuration FROM agents_platform.agent_versions WHERE organization_id=a.organization_id AND agent_id=a.id ORDER BY number DESC LIMIT 1) v ON true WHERE a.organization_id=$1 AND a.id=$2 AND a.deleted_at IS NULL FOR SHARE OF a`,[scope.organizationId,scope.agentId])).rows[0];
 if(!latest)throw denied();
 const configuration=agentConfigurationSchema.parse(latest.configuration);
 const request=(await db.query(`SELECT r.*,choice.customer_choice_message_id,choice.disposition FROM agents_platform.human_assistance_requests r LEFT JOIN LATERAL (SELECT cmd.customer_choice_message_id,cmd.disposition FROM agents_platform.human_assistance_commands cmd JOIN agents_platform.customer_messages m ON m.id=cmd.customer_choice_message_id WHERE cmd.request_id=r.id AND cmd.disposition IS NOT NULL ORDER BY m.sequence DESC LIMIT 1) choice ON true WHERE r.organization_id=$1 AND r.conversation_id=$2 ORDER BY r.requested_at DESC LIMIT 1`,[scope.organizationId,row.id])).rows[0];
 const customerEvidence=(await db.query(`SELECT m.id,m.body FROM agents_platform.customer_messages m JOIN agents_platform.customer_messages current ON current.id=$2 AND current.conversation_id=m.conversation_id WHERE m.conversation_id=$1 AND m.author_kind='visitor' AND m.sequence<=current.sequence ORDER BY m.sequence DESC LIMIT 5`,[row.id,binding.inputMessageId])).rows.map(message=>({id:message.id,text:message.body}));
 return {currentProcedures:(configuration.procedures??[]).filter(ref=>procedureReady(configuration,ref)),customerEvidence,request:request?{id:request.id,status:request.status,noticeMessageId:request.notice_message_id,inputMessageId:request.input_message_id,choiceMessageId:request.customer_choice_message_id??null,disposition:request.disposition??null,noticeStatus:await humanAssistanceNoticeStatus(db,scope,request.notice_message_id)}:null};
}
async function replay(db:PoolClient,taskId:string,operationId:string,digest:string):Promise<HumanAssistanceResult|null>{
  const prior=(await db.query("SELECT request_digest,result FROM agents_platform.human_assistance_commands WHERE task_id=$1 AND operation_id=$2",[taskId,operationId])).rows[0];
  if(prior&&prior.request_digest!==digest)throw new PlatformError("HUMAN_ASSISTANCE_CONFLICT",409,"Human assistance request changed");
  return prior?.result??null;
}
async function remember(db:PoolClient,taskId:string,operationId:string,digest:string,result:HumanAssistanceResult,choice?:{messageId?:string;disposition?:string}){await db.query("INSERT INTO agents_platform.human_assistance_commands(task_id,operation_id,request_digest,request_id,result,customer_choice_message_id,disposition) VALUES($1,$2,$3,$4,$5,$6,$7)",[taskId,operationId,digest,result.requestId,result,choice?.messageId??null,choice?.disposition??null]);return result;}
export async function requestHumanAssistance(db:PoolClient,row:CustomerConversation,binding:ChannelBinding,taskId:string,raw:unknown,ports:Ports):Promise<HumanAssistanceResult>{
  const input=requestHumanAssistanceSchema.parse(raw),digest=requestDigest({binding,input});
  const prior=await replay(db,taskId,input.operationId,digest);if(prior)return prior;
  const task=await taskScope(db,row,binding,taskId,ports);
  const active=(await db.query("SELECT * FROM agents_platform.human_assistance_requests WHERE conversation_id=$1 AND status IN ('requested','human_owned') FOR UPDATE",[row.id])).rows[0];
  if(active)return remember(db,taskId,input.operationId,digest,{requestId:active.id,status:active.status,state:row.state,noticeMessageId:active.notice_message_id,supportFacts:active.support_facts});
  const supportFacts=await supportStatusV2(db,row.organization_id,task.configuration.supportHours),body=humanAssistanceNotice(supportFacts),id=randomUUID();
  await db.query("INSERT INTO agents_platform.human_assistance_requests(id,organization_id,conversation_id,task_id,input_message_id,ownership_generation,status,brief,support_facts,notice_body) VALUES($1,$2,$3,$4,$5,$6,'requested',$7,$8,$9)",[id,row.organization_id,row.id,taskId,binding.inputMessageId,row.ownership_generation,input.brief,supportFacts,body]);
  const message=await ports.append(db,row,{key:`human-assistance:${id}`,digest:requestDigest(body),kind:"assistant",body});
  await db.query("UPDATE agents_platform.human_assistance_requests SET notice_message_id=$2 WHERE id=$1",[id,message.id]);
  await db.query("UPDATE agents_platform.customer_conversations SET revision=revision+1,updated_at=now() WHERE id=$1",[row.id]);
  await enqueueChannelMessage(db,row,message);
  return remember(db,taskId,input.operationId,digest,{requestId:id,status:"requested",state:row.state,noticeMessageId:message.id,supportFacts});
}
async function customerEvidence(db:Db,row:CustomerConversation,binding:ChannelBinding,id:string|undefined,quote:string|undefined):Promise<string>{
  if(!id||!quote)throw new PlatformError("HUMAN_ASSISTANCE_EVIDENCE_REQUIRED",400,"Customer confirmation is required");
  const source=(await db.query(`SELECT m.body FROM agents_platform.customer_messages m JOIN agents_platform.customer_messages current ON current.id=$3 AND current.conversation_id=m.conversation_id WHERE m.id=$1 AND m.conversation_id=$2 AND m.author_kind='visitor' AND m.ownership_generation=$4 AND m.sequence<=current.sequence`,[id,row.id,binding.inputMessageId,binding.ownershipGeneration])).rows[0];
  if(!source||!source.body.includes(quote))throw new PlatformError("HUMAN_ASSISTANCE_EVIDENCE_INVALID",400,"Customer confirmation is unavailable");
  return source.body;
}
export async function updateHumanAssistance(db:PoolClient,row:CustomerConversation,binding:ChannelBinding,taskId:string,raw:unknown,ports:Ports):Promise<HumanAssistanceResult>{
  const input=updateHumanAssistanceSchema.parse(raw),digest=requestDigest({binding,input});
  const prior=await replay(db,taskId,input.operationId,digest);if(prior)return prior;
  await taskScope(db,row,binding,taskId,ports);
  const request=(await db.query("SELECT * FROM agents_platform.human_assistance_requests WHERE id=$1 AND conversation_id=$2 AND organization_id=$3 AND status='requested' FOR UPDATE",[input.requestId,row.id,row.organization_id])).rows[0];if(!request)throw denied();
  if(input.contact){
    const consentBody=await customerEvidence(db,row,binding,input.contact.evidenceMessageId,input.contact.consentQuote);
    for(const key of ["value","name","preferredTime"] as const){const value=input.contact[key];if(!value)continue;
      const sourceId=input.contact.fieldEvidence?.[key];
      const sourceBody=sourceId?await customerEvidence(db,row,binding,sourceId,value):consentBody;
      if(!sourceBody.includes(value))throw new PlatformError("HUMAN_ASSISTANCE_CONTACT_INVALID",400,"Use the customer's exact contact details");
    }
  }
  if(input.disposition)await customerEvidence(db,row,binding,input.evidenceMessageId,input.evidenceQuote);
  const status=input.disposition==="withdrawn"||input.disposition==="declined"?"withdrawn":input.disposition==="self_service"?"completed":"requested";
  await db.query("UPDATE agents_platform.human_assistance_requests SET contact=coalesce($2::jsonb,contact),human_only=human_only OR $3,status=$4,updated_at=now() WHERE id=$1",[request.id,input.contact??null,input.disposition==="human_only",status]);
  if(input.disposition==="human_only"){
    const updated=(await db.query<CustomerConversation>("UPDATE agents_platform.customer_conversations SET state='handoff_pending',ownership_generation=ownership_generation+1,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",[row.id])).rows[0]!;
    await ports.cancel(db,row.id,updated.ownership_generation,taskId);row=updated;
  }else await db.query("UPDATE agents_platform.customer_conversations SET revision=revision+1,updated_at=now() WHERE id=$1",[row.id]);
  return remember(db,taskId,input.operationId,digest,{requestId:request.id,status,state:row.state,noticeMessageId:request.notice_message_id,supportFacts:request.support_facts},{messageId:input.evidenceMessageId??input.contact?.evidenceMessageId,disposition:input.disposition});
}
export async function currentHumanRequest(db:Db,conversationId:string):Promise<HumanRequestView|null>{
  const row=(await db.query("SELECT * FROM agents_platform.human_assistance_requests WHERE conversation_id=$1 AND status IN ('requested','human_owned') ORDER BY requested_at DESC LIMIT 1",[conversationId])).rows[0];
  if(!row)return null;
  const current=(await db.query(`SELECT p.definition_id,p.definition_version,p.status,p.route,p.receipts FROM agents_platform.business_procedure_instances p JOIN agents_platform.customer_conversations c ON c.organization_id=p.organization_id AND c.agent_id=p.agent_id AND c.execution_conversation_id=p.conversation_id WHERE c.id=$1 ORDER BY p.updated_at DESC,p.id DESC LIMIT 1`,[conversationId])).rows[0];
  const workflow=current?(()=>{try{const definition=resolveProcedure({id:current.definition_id,version:current.definition_version});return {name:definition.metadata.title,status:current.status,missing:definition.progress(current.route,current.receipts).missing};}catch{return undefined;}})():undefined;
  return {id:row.id,status:row.status,requestedAt:row.requested_at.toISOString(),brief:row.brief,contact:row.contact,humanOnly:row.human_only,...(workflow?{workflow}:{})};
}
/** Historical reads and physical dispatch require this immutable server receipt. */
export async function humanAssistanceNoticeValid(db:Db,message:Pick<CustomerMessage,"id"|"conversation_id"|"body"|"ownership_generation">,live=false):Promise<boolean>{return !!(await db.query(`SELECT 1 FROM agents_platform.human_assistance_requests h JOIN agents_platform.tasks t ON t.id=h.task_id JOIN agents_platform.execution_grants g ON g.id=t.grant_id AND g.organization_id=h.organization_id JOIN agents_platform.customer_conversations c ON c.id=h.conversation_id WHERE h.conversation_id=$1 AND h.notice_message_id=$2 AND h.notice_body=$3 AND h.ownership_generation=$4 AND ($5=false OR (g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND g.product=t.product AND g.version_id=t.version_id AND g.principal=t.principal AND g.resource_id=t.resource_id AND g.caller_client_id=t.caller_client_id AND c.state='automation_active' AND c.ownership_generation=h.ownership_generation AND NOT EXISTS(SELECT 1 FROM agents_platform.customer_cancellations cancel WHERE cancel.task_id=t.id)))`,[message.conversation_id,message.id,message.body,message.ownership_generation,live])).rowCount;}
/** A queued or uncertain send is not evidence that the customer received the notice. */
export async function humanAssistanceNoticeStatus(db:Db,scope:ProcedureScope,noticeMessageId:string):Promise<"confirmed"|"unknown"|"failed"|null>{
  const notice=(await db.query(`SELECT c.channel_kind FROM agents_platform.human_assistance_requests h JOIN agents_platform.customer_conversations c ON c.id=h.conversation_id AND c.organization_id=h.organization_id JOIN agents_platform.customer_messages m ON m.id=h.notice_message_id AND m.conversation_id=h.conversation_id AND m.body=h.notice_body WHERE c.organization_id=$1 AND c.agent_id=$2 AND c.execution_conversation_id=$3 AND h.notice_message_id::text=$4 AND h.support_facts#>>'{hours,state}'='closed'`,[scope.organizationId,scope.agentId,scope.conversationId,noticeMessageId])).rows[0];
  if(!notice)return null;
  if(notice.channel_kind==='website')return 'confirmed';
  const deliveries=(await db.query("SELECT state FROM agents_platform.channel_outbound WHERE message_id::text=$1",[noticeMessageId])).rows;
  const terminal=['sent','delivered','read','failed','rejected','suppressed'];
  if(!deliveries.length||deliveries.some(row=>!terminal.includes(row.state)))return 'unknown';
  return deliveries.some(row=>['failed','rejected','suppressed'].includes(row.state))?'failed':'confirmed';
}
export async function verifyHumanAssistanceEvidence(db:PoolClient,scope:ProcedureScope,evidence:ProcedureEvidence):Promise<boolean>{
  const request=(await db.query(`SELECT h.*,c.channel_kind FROM agents_platform.human_assistance_requests h JOIN agents_platform.customer_conversations c ON c.id=h.conversation_id AND c.organization_id=h.organization_id WHERE c.organization_id=$1 AND c.agent_id=$2 AND c.execution_conversation_id=$3 ORDER BY h.requested_at DESC,h.id DESC LIMIT 1`,[scope.organizationId,scope.agentId,scope.conversationId])).rows[0];
  if(!request)return false;
  const expected=evidence.route==='self_service'?'self_service':evidence.route==='declined'?'declined':evidence.route==='withdrawn'?'withdrawn':null;
  if(expected){
    if(!(await db.query("SELECT 1 FROM agents_platform.human_assistance_commands WHERE request_id=$1 AND disposition=$2 AND customer_choice_message_id IS NOT NULL",[request.id,expected])).rowCount)return false;
    if(request.status!==(expected==='self_service'?'completed':'withdrawn'))return false;
  }else if(evidence.route==='callback'&&!['requested','human_owned'].includes(request.status))return false;
  for(const receipt of evidence.receipts){
    if(receipt.kind==="customer_choice"){
      if(receipt.status!=="confirmed")return false;
      if(expected){
        if(!(await db.query(`SELECT 1 FROM agents_platform.human_assistance_commands command JOIN agents_platform.customer_messages m ON m.id=command.customer_choice_message_id WHERE command.request_id=$1 AND m.conversation_id=$2 AND m.id::text=$3 AND m.author_kind='visitor' AND command.disposition=$4`,[request.id,request.conversation_id,receipt.sourceId,expected])).rowCount)return false;
      }else if(receipt.sourceId!==request.input_message_id&&!(await db.query("SELECT 1 FROM agents_platform.human_assistance_commands WHERE request_id=$1 AND customer_choice_message_id::text=$2",[request.id,receipt.sourceId])).rowCount)return false;
    }else if(receipt.kind==="human_request"){
      if(receipt.status!=="confirmed")return false;
      if(receipt.sourceId!==request.id||!['requested','human_owned'].includes(request.status))return false;
    }else if(receipt.kind==='after_hours_notice'||receipt.kind==='help_offer'){
      if(receipt.sourceId!==request.notice_message_id)return false;
      if(receipt.status!==await humanAssistanceNoticeStatus(db,scope,receipt.sourceId))return false;
    }else return false;
  }return true;
}
