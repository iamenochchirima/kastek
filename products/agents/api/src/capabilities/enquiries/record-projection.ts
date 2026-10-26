import {randomUUID} from "node:crypto";
import type {PoolClient} from "pg";
import {PlatformError,requestDigest} from "../../contracts/contracts";
import type {ActionScope} from "../../contracts/connections";
import {recordCommandSchema,type RecordCommand,type RecordEnquiry,type CustomerContact} from "../../contracts/customer-records";
import {requireActionMember} from "../../infrastructure/action-authority";
const iso=(value:any)=>value?new Date(value).toISOString():null;
export const recordDTO=(r:any):RecordEnquiry=>({id:r.id,revision:String(r.revision),status:r.status,fields:r.fields,originalFields:r.original_fields,sourceEnquiryId:r.source_enquiry_id,sourceTaskId:r.source_task_id,agentId:r.agent_id,conversationId:r.conversation_id,customerConversationId:r.customer_conversation_id,channel:r.channel,contactId:r.contact_id,assigneeAccountId:r.assignee_account_id,dueAt:iso(r.due_at),createdAt:iso(r.created_at)!,updatedAt:iso(r.updated_at)!});
export const contactDTO=(r:any):CustomerContact=>({id:r.id,revision:String(r.revision),name:r.name,email:r.email,phone:r.phone,createdAt:iso(r.created_at)!,updatedAt:iso(r.updated_at)!});
export const recordMissing=()=>new PlatformError("CUSTOMER_RECORD_NOT_FOUND",404,"Customer record not found");
export async function recordRole(db:PoolClient,scope:ActionScope){await requireActionMember(db,scope);return (await db.query("SELECT role FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2",[scope.organizationId,scope.accountId])).rows[0].role as string;}
export async function recordActivity(db:PoolClient,organizationId:string,id:string,kind:string,actor:string|null,body:string|null=null){await db.query("INSERT INTO agents_platform.customer_record_activity(id,organization_id,enquiry_id,kind,actor_account_id,body) VALUES($1,$2,$3,$4,$5,$6)",[randomUUID(),organizationId,id,kind,actor,body]);}
export async function recordCommand<T>(db:PoolClient,scope:ActionScope,commandId:string,request:unknown,work:()=>Promise<T>):Promise<T>{
 const digest=requestDigest({actor:scope.accountId,request});
 await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${scope.organizationId}:${commandId}`]);
 const existing=(await db.query("SELECT * FROM agents_platform.customer_record_commands WHERE organization_id=$1 AND command_id=$2",[scope.organizationId,commandId])).rows[0];
 if(existing){if(existing.request_digest!==digest)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"Command was already used");return existing.result;}
 const result=await work();
 await db.query("INSERT INTO agents_platform.customer_record_commands(organization_id,command_id,actor_account_id,request_digest,result) VALUES($1,$2,$3,$4,$5)",[scope.organizationId,commandId,scope.accountId,digest,JSON.stringify(result)]);return result;
}
/** Only a verified customer principal projects into business records; operator tests and trials remain isolated. */
export async function projectSubmittedEnquiry(db:PoolClient,enquiryId:string):Promise<void>{
 const row=(await db.query(`SELECT e.*,c.channel_kind,c.session_id,c.channel_deployment_id,c.external_sender_id,c.deployment_id FROM agents_platform.enquiries e
 JOIN agents_platform.tasks t ON t.id=e.task_id AND t.organization_id=e.organization_id
 JOIN agents_platform.customer_conversations c ON c.id=e.customer_conversation_id AND c.organization_id=e.organization_id AND c.execution_conversation_id=e.conversation_id
 WHERE e.id=$1 AND e.state='submitted' AND t.evaluation_trial_id IS NULL AND t.principal=e.principal
 AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_channels x WHERE x.deployment_id=c.deployment_id)
 AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels x WHERE x.deployment_id=c.channel_deployment_id)
 AND ((e.principal->>'kind'='visitor' AND e.principal->>'deploymentId'=c.deployment_id::text AND e.principal->>'sessionId'=c.session_id::text)
 OR (e.principal->>'kind'='channel_customer' AND e.principal->>'deploymentId'=c.channel_deployment_id::text AND e.principal->>'participantId'=c.id::text))
 FOR UPDATE OF e`,[enquiryId])).rows[0];
 if(!row)return;
 if(row.amends_enquiry_id){
  const prior=(await db.query('SELECT r.* FROM agents_platform.customer_record_enquiries r JOIN agents_platform.customer_record_submissions s ON s.record_id=r.id AND s.organization_id=r.organization_id WHERE r.organization_id=$1 AND s.source_enquiry_id=$2 FOR UPDATE OF r',[row.organization_id,row.amends_enquiry_id])).rows[0];
  if(prior){
   const correctionKey='customer-corrected';
   if(!(await db.query("SELECT 1 FROM agents_platform.customer_record_submissions WHERE source_enquiry_id=$1",[row.id])).rowCount){
    await db.query('UPDATE agents_platform.customer_record_enquiries SET fields=$2,revision=revision+1,updated_at=now() WHERE id=$1',[prior.id,row.fields]);
    await db.query('INSERT INTO agents_platform.customer_record_submissions(organization_id,source_enquiry_id,record_id) VALUES($1,$2,$3)',[row.organization_id,row.id,prior.id]);
    await recordActivity(db,row.organization_id,prior.id,correctionKey,null);
   }
   return;
  }
 }
 if((await db.query("SELECT 1 FROM agents_platform.customer_record_submissions WHERE source_enquiry_id=$1",[enquiryId])).rowCount)return;
 // A channel sender or website session is a verified participant boundary; matching email alone never merges people.
 const key=row.channel_kind==='website'?`website:${row.deployment_id}:${row.session_id}`:`${row.channel_kind}:${row.channel_deployment_id}:${row.external_sender_id}`;
 const fields=row.fields;
 const contact=(await db.query(`INSERT INTO agents_platform.customer_contacts(id,organization_id,participant_key,name,email,phone) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(organization_id,participant_key) DO UPDATE SET participant_key=EXCLUDED.participant_key RETURNING id`,[randomUUID(),row.organization_id,key,fields.name??null,fields.email??null,fields.phone??null])).rows[0];
 const id=randomUUID();await db.query(`INSERT INTO agents_platform.customer_record_enquiries(id,organization_id,source_enquiry_id,source_task_id,agent_id,conversation_id,customer_conversation_id,channel,contact_id,original_fields,fields)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,[id,row.organization_id,row.id,row.task_id,row.agent_id,row.conversation_id,row.customer_conversation_id,row.channel_kind,contact.id,fields]);
 await db.query('INSERT INTO agents_platform.customer_record_submissions(organization_id,source_enquiry_id,record_id) VALUES($1,$2,$3)',[row.organization_id,row.id,id]);
 await recordActivity(db,row.organization_id,id,'submitted',null);
}
export async function mutateStaffRecord(db:PoolClient,scope:ActionScope,id:string,raw:RecordCommand):Promise<RecordEnquiry>{
 const input=recordCommandSchema.parse(raw),role=await recordRole(db,scope);
 return recordCommand(db,scope,input.commandId,{id,input},async()=>{
  const row=(await db.query("SELECT * FROM agents_platform.customer_record_enquiries WHERE organization_id=$1 AND id=$2 FOR UPDATE",[scope.organizationId,id])).rows[0];if(!row)throw recordMissing();
  if(String(row.revision)!==input.expectedRevision)throw new PlatformError("CUSTOMER_RECORD_CONFLICT",409,"Customer record changed. Refresh and try again");
  const assigned=row.assignee_account_id===scope.accountId;
  const denied=()=>{throw new PlatformError("CUSTOMER_RECORD_ACCESS_DENIED",403,"Claim this enquiry before updating it");};
  if(!['claim','assign','unassign'].includes(input.action)&&role!=='owner'&&!assigned)denied();
  let {status,assignee_account_id:assignee,due_at:due,fields,contact_id:contact}=row;
  switch(input.action){
   case 'claim':if(assignee&&!assigned)denied();assignee=scope.accountId;break;
   case 'assign':if(role!=='owner')denied();await requireActionMember(db,{...scope,accountId:input.assigneeAccountId});assignee=input.assigneeAccountId;break;
   case 'unassign':if(role!=='owner'&&!assigned)denied();assignee=null;break;
   case 'set-status':if(status==='closed'&&input.status!=='closed')throw new PlatformError('CUSTOMER_RECORD_REOPEN_REQUIRED',409,'Reopen this enquiry first');status=input.status;break;
   case 'reopen':if(status!=='closed')throw new PlatformError('CUSTOMER_RECORD_NOT_CLOSED',409,'Enquiry is already open');status='new';break;
   case 'set-due':due=input.dueAt;break;
   case 'correct':fields=input.fields;break;
   case 'link-contact':if(input.contactId&&!(await db.query('SELECT 1 FROM agents_platform.customer_contacts WHERE organization_id=$1 AND id=$2 FOR SHARE',[scope.organizationId,input.contactId])).rowCount)throw recordMissing();contact=input.contactId;break;
   case 'note':break;
  }
  const updated=(await db.query(`UPDATE agents_platform.customer_record_enquiries SET status=$3,assignee_account_id=$4,due_at=$5,fields=$6,contact_id=$7,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,[scope.organizationId,id,status,assignee,due,fields,contact])).rows[0];
  await recordActivity(db,scope.organizationId,id,input.action,scope.accountId,input.action==='note'?input.body:null);
  return recordDTO(updated);
 });
}
export async function searchStaffCustomerRecords(db:PoolClient,scope:ActionScope,filter:{search?:string;status?:string;limit?:number}={}){
 await requireActionMember(db,scope);
 const rows=(await db.query(`SELECT * FROM agents_platform.customer_record_enquiries WHERE organization_id=$1 AND ($2::text IS NULL OR status=$2)
 AND ($3::text IS NULL OR fields::text ILIKE '%'||$3||'%') ORDER BY created_at DESC,id DESC LIMIT $4`,[scope.organizationId,filter.status??null,filter.search??null,Math.min(30,Math.max(1,filter.limit??10))])).rows;
 return {records:rows.map(r=>({enquiryId:r.id,fields:r.fields,status:r.status,revision:String(r.revision),dueAt:iso(r.due_at)}))};
}
export async function updateStaffCustomerRecord(db:PoolClient,scope:ActionScope,id:string,input:Extract<RecordCommand,{action:'set-status'|'reopen'|'set-due'}>){
 const record=await mutateStaffRecord(db,scope,id,input);
 return {enquiryId:record.id,status:record.status,revision:record.revision,dueAt:record.dueAt,receiptDigest:requestDigest({commandId:input.commandId,id,revision:record.revision})};
}
