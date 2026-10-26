import type {Pool,PoolClient} from "pg";
import {PlatformError,requestDigest} from "../../contracts/contracts";
import {loadExecution,assertCurrentAuthority} from "../../execution/lifecycle/execution";
import {requireActionMember} from "../../infrastructure/action-authority";
import {transaction} from "../../infrastructure/database";
import {recordCommandSchema} from "../../contracts/customer-records";
import {validateBuiltinArguments} from "../tool-contracts";
import type {ToolDefinition} from "../../execution/business/model";
import {searchStaffCustomerRecords,updateStaffCustomerRecord} from "./record-projection";

const operations:Record<string,string>={enquiry_read:"enquiry.read",enquiry_amend:"enquiry.amend",records_search:"records.read",records_update:"records.write"};
async function staffScope(db:Pool|PoolClient,execution:Awaited<ReturnType<typeof loadExecution>>){
 const {task}=execution,principal=task.principal;
 if(principal.kind!=="human"||task.parent_task_id||task.channel_binding||task.evaluation_trial_id)throw new PlatformError("RECORD_SCOPE_DENIED",403,"Staff record access is unavailable");
 const account=(await db.query("SELECT id FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2",[principal.issuer,principal.subject])).rows[0];
 if(!account)throw new PlatformError("RECORD_SCOPE_DENIED",403,"Staff record access is unavailable");
 const scope={organizationId:task.organization_id,accountId:account.id as string};await requireActionMember(db,scope);return scope;
}
export async function visibleRecordTools(pool:Pool,execution:Awaited<ReturnType<typeof loadExecution>>,tools:ToolDefinition[]):Promise<ToolDefinition[]>{
 const grant=(await pool.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1 AND revoked_at IS NULL AND expires_at>now()",[execution.task.grant_id])).rows[0];
 let staff=false;
 if(execution.task.principal.kind==="human"&&!execution.task.channel_binding&&!execution.task.parent_task_id){try{await staffScope(pool,execution);staff=true;}catch(error){if(!(error instanceof PlatformError))throw error;}}
 return tools.filter(tool=>{const op=operations[tool.function.name];return !op||(grant?.operations.includes(op)&&(!tool.function.name.startsWith("records_")||staff));});
}
export async function executeRecordTool(pool:Pool,taskId:string,operationId:string,name:"records.search"|"records.update",input:unknown){
 const args=validateBuiltinArguments(name,input);
 return transaction(pool,async db=>{
  const execution=await loadExecution(db,taskId,true);await assertCurrentAuthority(db,execution);
  if(!execution.configuration.tools.includes(name))throw new PlatformError("TOOL_DENIED",403,"Record tool is unavailable");
  const grant=(await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1 FOR SHARE",[execution.task.grant_id])).rows[0];
  if(!grant?.operations.includes(name==="records.search"?"records.read":"records.write"))throw new PlatformError("RECORD_SCOPE_DENIED",403,"Record operation is unavailable");
  const scope=await staffScope(db,execution);
  if(name==="records.search")return searchStaffCustomerRecords(db,scope,args as {search?:string;limit?:number});
  const {enquiryId,...command}=args as {enquiryId:string;expectedRevision:string;action:"set-status"|"reopen"|"set-due";status?:"new"|"in_progress"|"waiting_on_customer"|"closed";dueAt?:string|null};
  const digest=requestDigest({taskId,operationId}),commandId=`${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
  return updateStaffCustomerRecord(db,scope,enquiryId,recordCommandSchema.parse({...command,commandId}) as Extract<ReturnType<typeof recordCommandSchema.parse>,{action:"set-status"|"reopen"|"set-due"}>);
 });
}
