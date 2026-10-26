import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import {PlatformError,requestDigest,principalSchema,terminalTaskStates,type AgentConfiguration} from "../../contracts/contracts";
import {projectSubmittedEnquiry} from "./record-projection";
import {validateBuiltinArguments} from "../tool-contracts";
import {assertCurrentAuthority,loadExecution} from "../../execution/lifecycle/execution";
import {transaction} from "../../infrastructure/database";
import {notifyActionTask,requireActionMember} from "../../infrastructure/action-authority";
import {channelPorts} from "../../infrastructure/channel-ports";
import {recordEvent} from "../../observability/event-store";
import type {ActionScope} from "../../contracts/connections";

export type EnquiryFields=Partial<Record<"name"|"email"|"phone"|"service"|"message",string>>;
export function enquiryArguments(configuration:AgentConfiguration,input:unknown,operation:"enquiry.submit"|"enquiry.amend"="enquiry.submit"):{fields:EnquiryFields;enquiryId?:string}{
  const capability=configuration.capabilities.enquiries;
  if(!capability?.enabled||!configuration.tools.includes(operation))throw new PlatformError("ENQUIRY_DISABLED",403,"Enquiries are unavailable");
  const parsed=validateBuiltinArguments(operation,input) as {fields:EnquiryFields;enquiryId?:string};
  if(Object.keys(parsed.fields).some(field=>!capability.fields.includes(field as keyof EnquiryFields))||capability.fields.some(field=>!parsed.fields[field]))throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Provide the configured enquiry fields");
  if(Object.values(parsed.fields).some(value=>value?.includes("\0")))throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Enquiry fields cannot contain null characters");
  // PostgreSQL jsonb adds separator spaces when rendering the bounded stored object.
  if(Buffer.byteLength(JSON.stringify(parsed.fields),"utf8")+2*Object.keys(parsed.fields).length>8192)throw new PlatformError("TOOL_ARGUMENTS_LIMIT",413,"Enquiry details exceed the storage limit");
  return parsed;
}
const missing=()=>new PlatformError("ENQUIRY_NOT_FOUND",404,"Enquiry not found");
const dto=(row:Record<string,any>)=>({id:row.id,taskId:row.task_id,agentId:row.agent_id,conversationId:row.conversation_id,customerConversationId:row.customer_conversation_id,fields:row.fields as EnquiryFields,amendsEnquiryId:row.amends_enquiry_id??null,state:row.state as string,requestDigest:row.request_digest as string,expiresAt:new Date(row.expires_at).toISOString(),createdAt:new Date(row.created_at).toISOString(),submittedAt:row.submitted_at?new Date(row.submitted_at).toISOString():null});
export type Enquiry=ReturnType<typeof dto>;
export class EnquiryStore {
 constructor(readonly pool:Pool){}
 private async authority(db:PoolClient,taskId:string,operation="enquiry.submit"){
  const execution=await loadExecution(db,z.uuid().parse(taskId),true);await assertCurrentAuthority(db,execution);
  if(execution.task.parent_task_id||execution.task.principal.kind==="automation")throw new PlatformError("ENQUIRY_SCOPE_DENIED",403,"Enquiry submission requires a conversation");
  const grant=(await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[execution.task.grant_id])).rows[0];
  if(!grant?.operations.includes(operation))throw new PlatformError("ENQUIRY_SCOPE_DENIED",403,"Enquiry submission is unavailable");
  return execution;
 }
 async prepare(taskId:string,operationId:string,input:unknown,operation:"enquiry.submit"|"enquiry.amend"="enquiry.submit"):Promise<Enquiry>{
  z.string().min(1).max(256).parse(operationId);
  return transaction(this.pool,async db=>{
   const execution=await this.authority(db,taskId,operation),args=enquiryArguments(execution.configuration,input,operation);
   if(args.enquiryId){
    const previous=(await db.query("SELECT state FROM agents_platform.enquiries WHERE task_id=$1 AND operation_id=$2",[taskId,operationId])).rows[0];
    await this.own(db,execution,args.enquiryId,previous?.state!=="submitted");
   }
   const digest=requestDigest({...(args.enquiryId?{amendsEnquiryId:args.enquiryId}:{}),fields:args.fields,configuration:execution.configuration.capabilities.enquiries,principal:execution.task.principal});
   const inserted=await db.query(`INSERT INTO agents_platform.enquiries(id,organization_id,agent_id,task_id,conversation_id,customer_conversation_id,principal,operation_id,request_digest,fields,state,expires_at,amends_enquiry_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',LEAST($11::timestamptz,now()+interval '15 minutes'),$12) ON CONFLICT(task_id,operation_id) DO NOTHING RETURNING *`,
    [randomUUID(),execution.task.organization_id,execution.agentId,taskId,execution.task.conversation_id,execution.task.channel_binding?.customerConversationId??null,execution.task.principal,operationId,digest,args.fields,execution.task.deadline_at,args.enquiryId??null]);
   const row=inserted.rows[0]??(await db.query("SELECT * FROM agents_platform.enquiries WHERE task_id=$1 AND operation_id=$2",[taskId,operationId])).rows[0];
   if(row.request_digest!==digest)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"Enquiry details changed");
   if(row.state==="pending"&&execution.task.principal.kind==="channel_customer"){
    const port=channelPorts(db).publishEnquiryReview;
    if(!port||!execution.task.channel_binding)throw new PlatformError("CHANNEL_REVIEW_UNAVAILABLE",503,"Enquiry confirmation is unavailable");
    await port(db,{taskId,binding:execution.task.channel_binding,reviewId:row.id,requestDigest:digest,fields:args.fields});
   }
   await recordEvent(db,taskId,`enquiry:prepared:${row.id}`,"enquiry.prepared",{count:1});
   return dto(row);
  });
 }
 private async own(db:PoolClient,execution:Awaited<ReturnType<typeof loadExecution>>,id:string,requireLatest=false){
  const row=(await db.query(`SELECT e.* FROM agents_platform.enquiries e JOIN agents_platform.tasks t ON t.id=e.task_id JOIN agents_platform.conversations c ON c.id=e.conversation_id
   WHERE e.id=$1 AND e.organization_id=$2 AND e.conversation_id=$3 AND e.principal=$4::jsonb AND e.state='submitted' AND c.deleted_at IS NULL
   AND t.evaluation_trial_id IS NOT DISTINCT FROM $5::uuid FOR UPDATE OF e`,[z.uuid().parse(id),execution.task.organization_id,execution.task.conversation_id,execution.task.principal,execution.task.evaluation_trial_id??null])).rows[0];
  if(!row)throw missing();
  if(requireLatest&&(await db.query("SELECT 1 FROM agents_platform.enquiries WHERE amends_enquiry_id=$1 AND state='submitted'",[id])).rowCount)throw new PlatformError("ENQUIRY_CHANGED",409,"Read the current enquiry before changing it");
  return row;
 }
 async readOwn(taskId:string,input:unknown){
  validateBuiltinArguments("enquiry.read",input);
  return transaction(this.pool,async db=>{const execution=await this.authority(db,taskId,"enquiry.read");
   if(!execution.configuration.capabilities.enquiries?.enabled||!execution.configuration.tools.includes("enquiry.read"))throw missing();
   const rows=(await db.query(`SELECT e.* FROM agents_platform.enquiries e JOIN agents_platform.tasks t ON t.id=e.task_id JOIN agents_platform.conversations c ON c.id=e.conversation_id WHERE e.organization_id=$1 AND e.conversation_id=$2 AND e.principal=$3::jsonb AND e.state='submitted' AND c.deleted_at IS NULL AND t.evaluation_trial_id IS NOT DISTINCT FROM $4::uuid AND NOT EXISTS(SELECT 1 FROM agents_platform.enquiries correction WHERE correction.amends_enquiry_id=e.id AND correction.state='submitted') ORDER BY e.created_at DESC,e.id DESC LIMIT 10`,[execution.task.organization_id,execution.task.conversation_id,execution.task.principal,execution.task.evaluation_trial_id??null])).rows;
   return {enquiries:rows.map(row=>({enquiryId:row.id as string,fields:row.fields as EnquiryFields,amendsEnquiryId:row.amends_enquiry_id??null}))};
  });
 }
 async listForPrincipal(taskId:string,rawPrincipal:unknown):Promise<Enquiry[]>{
  const principal=principalSchema.parse(rawPrincipal);
  const task=(await this.pool.query("SELECT t.principal FROM agents_platform.tasks t JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.organization_id=t.organization_id WHERE t.id=$1 AND c.deleted_at IS NULL",[z.uuid().parse(taskId)])).rows[0];
  if(!task||requestDigest(task.principal)!==requestDigest(principal))throw missing();
  return (await this.pool.query("SELECT * FROM agents_platform.enquiries WHERE task_id=$1 ORDER BY created_at,id LIMIT 100",[taskId])).rows.map(dto);
 }
 async decide(taskId:string,principal:unknown,id:string,input:{decision:"approve"|"reject";requestDigest:string}):Promise<Enquiry>{
  z.strictObject({decision:z.enum(["approve","reject"]),requestDigest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(input);
  return transaction(this.pool,async db=>{
   const candidate=(await db.query("SELECT amends_enquiry_id FROM agents_platform.enquiries WHERE task_id=$1 AND id=$2",[taskId,z.uuid().parse(id)])).rows[0];
   const execution=await this.authority(db,taskId,candidate?.amends_enquiry_id?"enquiry.amend":"enquiry.submit");
   if(requestDigest(principalSchema.parse(principal))!==requestDigest(execution.task.principal))throw missing();
   const row=(await db.query("SELECT * FROM agents_platform.enquiries WHERE task_id=$1 AND id=$2 FOR UPDATE",[taskId,z.uuid().parse(id)])).rows[0];if(!row)throw missing();
   if(row.request_digest!==input.requestDigest)throw new PlatformError("REVIEW_CHANGED",409,"Review the current enquiry");
   const desired=input.decision==="approve"?"approved":"rejected";
   if(row.state===desired||row.state==="submitted"&&desired==="approved")return dto(row);
   if(row.state!=="pending"||new Date(row.expires_at).getTime()<=Date.now()||terminalTaskStates.has(execution.task.state))throw new PlatformError("ENQUIRY_REVIEW_EXPIRED",409,"Enquiry confirmation expired");
   const updated=(await db.query("UPDATE agents_platform.enquiries SET state=$2,confirmed_at=CASE WHEN $2='approved' THEN now() ELSE NULL END WHERE id=$1 RETURNING *",[id,desired])).rows[0];
   await notifyActionTask(db,taskId);return dto(updated);
  });
 }
 async submit(taskId:string,operationId:string,input:unknown,operation:"enquiry.submit"|"enquiry.amend"="enquiry.submit"){
  return transaction(this.pool,async db=>{
   const execution=await this.authority(db,taskId,operation),args=enquiryArguments(execution.configuration,input,operation);
   const row=(await db.query("SELECT * FROM agents_platform.enquiries WHERE task_id=$1 AND operation_id=$2 FOR UPDATE",[taskId,operationId])).rows[0];
   if(!row||row.request_digest!==requestDigest({...(args.enquiryId?{amendsEnquiryId:args.enquiryId}:{}),fields:args.fields,configuration:execution.configuration.capabilities.enquiries,principal:execution.task.principal}))throw new PlatformError("ENQUIRY_CONFIRMATION_REQUIRED",409,"Confirm the exact enquiry details");
   if(args.enquiryId)await this.own(db,execution,args.enquiryId,row.state!=="submitted");
   if(row.state!=="submitted"){
    if(row.state!=="approved"||new Date(row.expires_at).getTime()<=Date.now())throw new PlatformError("ENQUIRY_CONFIRMATION_REQUIRED",409,"Confirm the exact enquiry details");
    await db.query("UPDATE agents_platform.enquiries SET state='submitted',submitted_at=now() WHERE id=$1",[row.id]);
    await recordEvent(db,taskId,`enquiry:submitted:${row.id}`,"enquiry.submitted",{count:1});
   }
   await projectSubmittedEnquiry(db,row.id);
   return {state:"submitted" as const,enquiryId:row.id as string,receiptDigest:requestDigest({id:row.id,requestDigest:row.request_digest})};
  });
 }
 async listStaff(scope:ActionScope,filter:{agentId?:string;conversationId?:string;before?:string;limit?:number}={}){
  return transaction(this.pool,async db=>{await requireActionMember(db,scope);
   return (await db.query(`SELECT e.* FROM agents_platform.enquiries e JOIN agents_platform.tasks t ON t.id=e.task_id AND t.organization_id=e.organization_id
    LEFT JOIN agents_platform.evaluation_trials trial ON trial.id=t.evaluation_trial_id AND trial.organization_id=e.organization_id
    WHERE e.organization_id=$1 AND e.state='submitted' AND (t.evaluation_trial_id IS NULL OR trial.account_id=$6)
    AND ($2::uuid IS NULL OR e.agent_id=$2) AND ($3::uuid IS NULL OR e.customer_conversation_id=$3 OR e.conversation_id=$3)
    AND ($4::timestamptz IS NULL OR e.created_at<$4) ORDER BY e.created_at DESC,e.id DESC LIMIT $5`,[scope.organizationId,filter.agentId??null,filter.conversationId??null,filter.before??null,filter.limit??50,scope.accountId])).rows.map(dto);
  });
 }
 async readStaff(scope:ActionScope,id:string){return transaction(this.pool,async db=>{await requireActionMember(db,scope);const row=(await db.query(`SELECT e.* FROM agents_platform.enquiries e JOIN agents_platform.tasks t ON t.id=e.task_id AND t.organization_id=e.organization_id LEFT JOIN agents_platform.evaluation_trials trial ON trial.id=t.evaluation_trial_id AND trial.organization_id=e.organization_id WHERE e.organization_id=$1 AND e.id=$2 AND e.state='submitted' AND (t.evaluation_trial_id IS NULL OR trial.account_id=$3)`,[scope.organizationId,z.uuid().parse(id),scope.accountId])).rows[0];if(!row)throw missing();return dto(row);});}
}
