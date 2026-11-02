import { deadlineMillis } from "../../execution/lifecycle/deadline";
import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { ReportDeliveryHTTP,type DeliveryReceipt,type DeliveryTarget,type ReportPayload } from "../../adapters/providers/report-delivery";
import { REPORT_WORKFLOW_BINDING,toolDescriptor } from "../../capabilities/tool-descriptors";
import type { ActionScope } from "../../contracts/connections";
import { PlatformError,requestDigest } from "../../contracts/contracts";
import { assertDependencyManifest } from "../../contracts/source-contracts";
import { TaskArtifactStore } from "../../execution/artifacts/task-artifacts";
import { assertCurrentEvidence } from "../../execution/context/evidence";
import { resolveAutomationOwner,resolveAutomationReviewer } from "../../execution/lifecycle/automation-authority";
import { assertCurrentAuthority,event,loadExecution } from "../../execution/lifecycle/execution";
import { actionMissing,notifyActionTask,requireActionMember } from "../../infrastructure/action-authority";
import { transaction } from "../../infrastructure/database";
import { ConnectionVault } from "../../infrastructure/vault";
export type ActionState="pending_review"|"approved"|"rejected"|"expired"|"invalidated"|"claimed"|"delivered"|"failed"|"uncertain";
export interface ActionCitation {id:string;label:string;text:string;title:string;page:number|null;section:string|null;contentDigest:string;acquiredAt:string}
export interface ActionDTO {id:string;reviewId:string;accountId:string;reviewerAccountId:string;taskId:string;rootTaskId:string;connectionId:string;connectionRevision:number;destination:{label:string;resource:string};artifactId:string;title:string;payloadDigest:string;reviewDigest:string;state:ActionState;expiresAt:string;preview:{name:string;contentType:string;content:string};receipt?:DeliveryReceipt;errorCode?:string;citedPassages?:ActionCitation[]}
export interface ActionOptions {vault:ConnectionVault;targets:DeliveryTarget[];artifacts:TaskArtifactStore;adapter?:ReportDeliveryHTTP}
export class ActionService {
 private readonly adapter:ReportDeliveryHTTP;
 constructor(readonly pool:Pool,readonly options:ActionOptions){this.adapter=options.adapter??new ReportDeliveryHTTP();}
 private dto(row:Record<string,any>):ActionDTO{const payload=row.payload as ReportPayload;return{id:row.id,reviewId:row.id,accountId:row.account_id,reviewerAccountId:row.reviewer_account_id,taskId:row.task_id,rootTaskId:row.root_task_id,connectionId:row.connection_id,connectionRevision:row.connection_revision,
  destination:{label:this.options.targets.find(target=>target.id===row.target_id)?.label??"Unavailable destination",resource:payload.resource},artifactId:row.artifact_id,title:row.title,payloadDigest:row.payload_digest,reviewDigest:row.review_digest,state:row.state,
  expiresAt:new Date(row.expires_at).toISOString(),preview:{name:payload.report.name,contentType:payload.report.contentType,content:Buffer.from(payload.report.contentBase64,"base64").toString("utf8")},...(row.receipt?{receipt:row.receipt}:{}),...(row.error_code?{errorCode:row.error_code}:{})};}
 private async visibleDTO(db:PoolClient,row:Record<string,any>):Promise<ActionDTO>{
  const dto=this.dto(row);try{await this.source(db,row);
   if(this.options.artifacts.evidence){const passages=await this.options.artifacts.evidence.reviewerPassagesWithin(db,{organizationId:row.organization_id,accountId:row.account_id},row.task_id,row.artifact_id);
    dto.citedPassages=passages.map(passage=>({id:passage.reference.id,label:passage.label,text:passage.text,title:passage.title,page:passage.page,section:passage.section,contentDigest:passage.reference.contentDigest,acquiredAt:passage.reference.acquiredAt}));}
  }catch(error){if(!(error instanceof PlatformError))throw error;dto.preview.content="[Report source unavailable]";dto.citedPassages=[];}return dto;
 }
 private async owner(db:Pool|PoolClient,task:Record<string,any>):Promise<string>{
  if(task.principal.kind==="automation")return resolveAutomationOwner(db,task.organization_id,task.principal);
  if(task.principal.kind!=="human")throw actionMissing();
  const account=(await db.query("SELECT id FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2",[task.principal.issuer,task.principal.subject])).rows[0];if(!account)throw actionMissing();return account.id;
 }
 private async lockedExecution(db:PoolClient,taskId:string){
  const before=await loadExecution(db,taskId);await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[before.task.organization_id]);
  const value=await loadExecution(db,taskId,true);await assertCurrentAuthority(db,value);
  const config=value.configuration as any;
  const grant=(await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[value.task.grant_id])).rows[0];
  if(value.task.parent_task_id||!config.capabilities.workflows.enabled||config.capabilities.workflows.profileId!=="report-delivery-v1"||!grant.operations.includes("effect.deliver"))throw new PlatformError("ACTION_SCOPE_DENIED",403,"Report delivery is unavailable");
  return{...value,accountId:await this.owner(db,value.task),connectionId:config.capabilities.workflows.connectionId as string};
 }
 private bindingDigest(execution:Awaited<ReturnType<typeof loadExecution>>,reviewer:string){return requestDigest({versionId:execution.task.version_id,configuration:execution.configuration,toolBindings:execution.toolBindings,workflow:REPORT_WORKFLOW_BINDING,descriptor:toolDescriptor("report.deliver"),reviewer});}
 private async source(db:PoolClient,row:Record<string,any>){
  await requireActionMember(db,{organizationId:row.organization_id,accountId:row.account_id});
  const reviewNode=(await db.query("SELECT manifest FROM agents_platform.evidence_nodes WHERE id=$1 AND task_id=$2 AND organization_id=$3 AND kind='artifact' AND owner_id=$4",[row.evidence_node_id,row.task_id,row.organization_id,`review:${row.id}`])).rows[0];
  if(!reviewNode)throw new PlatformError("ACTION_SOURCE_INVALID",409,"Report evidence is unavailable");
  await assertCurrentEvidence(db,row.task_id,assertDependencyManifest(reviewNode.manifest),{requireActiveTask:false});
  const root=(await db.query(`SELECT c.deleted_at,g.revoked_at FROM agents_platform.tasks t JOIN agents_platform.conversations c ON c.id=t.conversation_id
   JOIN agents_platform.execution_grants g ON g.id=t.grant_id WHERE t.id=$1 FOR SHARE OF c,g`,[row.root_task_id])).rows[0];
  if(!root||root.deleted_at||root.revoked_at)throw new PlatformError("ACTION_SOURCE_INVALID",409,"Report source is unavailable");
  const seen=new Set<string>();let inspected=0;
  const visit=async(id:string,depth:number,expectedDigest?:string):Promise<void>=>{
   if(depth>32||++inspected>128||seen.has(id))throw new PlatformError("ACTION_SOURCE_INVALID",409,"Report source graph is unavailable");
   seen.add(id);
   const artifact=(await db.query(`SELECT a.*,c.deleted_at,g.revoked_at FROM agents_platform.artifacts a JOIN agents_platform.tasks t ON t.id=a.task_id
    JOIN agents_platform.conversations c ON c.id=t.conversation_id JOIN agents_platform.execution_grants g ON g.id=t.grant_id
    WHERE a.id=$1 AND a.root_task_id=$2 FOR SHARE OF a,c,g`,[id,row.root_task_id])).rows[0];
   if(!artifact||artifact.state!=="available"||artifact.deleted_at||artifact.revoked_at||(expectedDigest&&artifact.content_digest!==expectedDigest))throw new PlatformError("ACTION_SOURCE_INVALID",409,"Report source is unavailable");
   await this.options.artifacts.assertEvidence(db,artifact.task_id,artifact.id);
   if(artifact.task_id!==row.task_id)await this.options.artifacts.assertEvidence(db,row.task_id,artifact.id);
   if(!Array.isArray(artifact.source_references)||artifact.source_references.length>128)throw new PlatformError("ACTION_SOURCE_INVALID",409,"Report source graph is unavailable");
   for(const reference of artifact.source_references){
    if(reference.kind==="artifact")await visit(z.uuid().parse(reference.id),depth+1);
    else if(reference.kind==="memory_scope"){
     const fence=(await db.query("SELECT generation,next_expiry_at FROM agents_platform.memory_scopes WHERE id=$1 FOR SHARE",[z.uuid().parse(reference.id)])).rows[0];
     if(!fence||Number(fence.generation)!==Number(reference.generation)||(fence.next_expiry_at&&new Date(fence.next_expiry_at).getTime()<=Date.now())||(reference.expiresAt!==undefined&&Number(reference.expiresAt)<=Date.now()))throw new PlatformError("ACTION_SOURCE_INVALID",409,"Report memory source changed");
    }
   }
   seen.delete(id);
  };
  await visit(row.artifact_id,0,row.artifact_digest);
 }
 async prepare(taskId:string,operationId:string,raw:{connectionId:string;artifactId:string;title?:string}):Promise<ActionDTO>{
  const input=z.strictObject({connectionId:z.uuid(),artifactId:z.uuid(),title:z.string().trim().min(1).max(120).optional()}).parse(raw);z.string().min(1).max(128).parse(operationId);
  const request=requestDigest(input);
  const existing=(await this.pool.query("SELECT * FROM agents_platform.actions WHERE task_id=$1 AND operation_id=$2",[taskId,operationId])).rows[0];
  if(existing){if(existing.request_digest!==request)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"Action identity conflict");return this.get(taskId,existing.id);}
  const report=await this.options.artifacts.readForTask(taskId,input.artifactId);
  const content=new TextDecoder("utf-8",{fatal:true}).decode(report.content);if(report.artifact.contentType==="application/json")JSON.parse(content);
  await this.options.artifacts.validateReport(taskId,input.artifactId,content);
  return transaction(this.pool,async db=>{
   const execution=await this.lockedExecution(db,taskId),task=execution.task;
   if(execution.connectionId!==input.connectionId)throw new PlatformError("CONNECTION_SCOPE_DENIED",403,"Connection is not permitted by the published workflow");
   const previous=(await db.query("SELECT * FROM agents_platform.actions WHERE root_task_id=$1",[task.root_task_id])).rows[0];
   if(previous){if(previous.operation_id!==operationId||previous.request_digest!==request)throw new PlatformError("ACTION_ALREADY_PREPARED",409,"This task already has a report action");return this.dto(previous);}
   const connection=(await db.query("SELECT * FROM agents_platform.connections WHERE id=$1 AND organization_id=$2 AND account_id=$3 AND state='active' FOR SHARE",[input.connectionId,task.organization_id,execution.accountId])).rows[0];
   const target=this.options.targets.find(target=>target.id===connection?.target_id&&target.resource===connection.resource);
   if(!connection||connection.profile_id!=="report-delivery-v1"||!target||new Date(connection.expires_at).getTime()<=Date.now())throw new PlatformError("CONNECTION_UNAVAILABLE",403,"Connection is unavailable");
   const id=randomUUID(),title=input.title??report.artifact.name;
   const payload:ReportPayload={schema:"report-delivery-v1",resource:target.resource,title,report:{name:report.artifact.name,contentType:report.artifact.contentType,digest:report.artifact.contentDigest,contentBase64:Buffer.from(report.content).toString("base64")}};
   const payloadDigest=requestDigest(payload),expiresAt=new Date(Math.min(deadlineMillis(task.deadline_at),Date.now()+24*60*60*1000,new Date(connection.expires_at).getTime()));
   const reviewer=task.principal.kind==="automation"?await resolveAutomationReviewer(db,task.organization_id,task.root_task_id):execution.accountId;
   await requireActionMember(db,{organizationId:task.organization_id,accountId:reviewer});
   const bindingDigest=this.bindingDigest(execution,reviewer);
   await this.options.artifacts.assertEvidence(db,taskId,input.artifactId);
   if(!this.options.artifacts.evidence)throw new PlatformError("OBJECT_STORE_UNAVAILABLE",503,"Private storage is unavailable");
   const evidenceNode=await this.options.artifacts.evidence.deriveWithin(db,taskId,"artifact",`review:${id}`),evidenceManifest=evidenceNode.manifest;
   const reviewDigest=requestDigest({evidenceManifestDigest:evidenceManifest.digest,id,taskId,rootTaskId:task.root_task_id,principal:task.principal,connectionId:connection.id,connectionRevision:connection.revision,target,payloadDigest,artifactId:input.artifactId,expiresAt:expiresAt.toISOString(),bindingDigest,reviewer});
   const row=(await db.query(`INSERT INTO agents_platform.actions(id,organization_id,account_id,task_id,root_task_id,operation_id,connection_id,connection_revision,target_id,artifact_id,artifact_digest,title,request_digest,payload,payload_digest,review_digest,state,expires_at,reviewer_account_id,target_digest,binding_digest,evidence_node_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending_review',$17,$18,$19,$20,$21) RETURNING *`,[id,task.organization_id,execution.accountId,taskId,task.root_task_id,operationId,connection.id,connection.revision,target.id,input.artifactId,report.artifact.contentDigest,title,request,JSON.stringify(payload),payloadDigest,reviewDigest,expiresAt,reviewer,requestDigest(target),bindingDigest,evidenceNode.id])).rows[0];
   await this.source(db,row);await event(db,taskId,`action:${id}:prepared`,"action.prepared",{actionId:id,payloadDigest,reviewDigest});return this.dto(row);
  });
 }
 async get(taskId:string,actionId:string):Promise<ActionDTO>{
  z.uuid().parse(actionId);await this.pool.query("UPDATE agents_platform.actions SET state='expired',updated_at=now() WHERE id=$1 AND task_id=$2 AND expires_at<=now() AND state IN ('pending_review','approved')",[actionId,taskId]);
  const row=(await this.pool.query("SELECT * FROM agents_platform.actions WHERE id=$1 AND task_id=$2",[actionId,taskId])).rows[0];if(!row)throw actionMissing();return this.dto(row);
 }
 getReview(taskId:string,actionId:string){return this.get(taskId,actionId);}
 async listForTask(scope:ActionScope,taskId:string):Promise<ActionDTO[]>{return transaction(this.pool,async db=>{
  await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);
  await requireActionMember(db,scope);
  const rows=(await db.query("SELECT * FROM agents_platform.actions WHERE task_id=$1 AND organization_id=$2 AND (account_id=$3 OR reviewer_account_id=$3) ORDER BY created_at,id",[taskId,scope.organizationId,scope.accountId])).rows;
  const result:ActionDTO[]=[];for(const row of rows)result.push(await this.visibleDTO(db,row));return result;
 });}
 async decide(scope:ActionScope,taskId:string,actionId:string,raw:{operationId:string;decision:"approve"|"reject";expectedDigest:string}):Promise<ActionDTO>{
  const input=z.strictObject({operationId:z.string().min(1).max(128),decision:z.enum(["approve","reject"]),expectedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(raw);
  return transaction(this.pool,async db=>{
   await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);await requireActionMember(db,scope);
   const row=(await db.query("SELECT * FROM agents_platform.actions WHERE id=$1 AND task_id=$2 AND organization_id=$3 AND reviewer_account_id=$4 FOR UPDATE",[actionId,taskId,scope.organizationId,scope.accountId])).rows[0];if(!row)throw actionMissing();
   const digest=requestDigest(input),old=(await db.query("SELECT * FROM agents_platform.action_decisions WHERE action_id=$1 AND operation_id=$2",[actionId,input.operationId])).rows[0];
   if(old){if(old.request_digest!==digest)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"Decision identity conflict");return this.visibleDTO(db,row);}
   if(row.review_digest!==input.expectedDigest)throw new PlatformError("REVIEW_DIGEST_CONFLICT",409,"Review changed; refresh before deciding");
   if(row.state!=="pending_review")throw new PlatformError("REVIEW_ALREADY_DECIDED",409,"This review is no longer pending");
   const state=new Date(row.expires_at).getTime()<=Date.now()?"expired":input.decision==="approve"?"approved":"rejected";
   if(state==="approved"){
    const task=(await db.query("SELECT * FROM agents_platform.tasks WHERE id=$1 FOR NO KEY UPDATE",[taskId])).rows[0];
    const grant=(await db.query("SELECT * FROM agents_platform.execution_grants WHERE id=$1 FOR SHARE",[task.grant_id])).rows[0];
    if(!grant||grant.revoked_at)throw new PlatformError("GRANT_REVOKED",403,"Execution access was revoked");
    if(new Date(grant.expires_at).getTime()<=Date.now()){
     const id=randomUUID(),expiresAt=new Date(Math.min(Date.now()+30*60_000,deadlineMillis(task.deadline_at)));
     if(expiresAt.getTime()<=Date.now())throw new PlatformError("TASK_DEADLINE",409,"Task deadline reached");
     await db.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,max_input_bytes,max_output_tokens,max_context_tokens,root_token_limit,expires_at,source_revision_ids,connected_tool_binding_ids)
      SELECT $2,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,max_input_bytes,max_output_tokens,max_context_tokens,root_token_limit,$3,source_revision_ids,connected_tool_binding_ids FROM agents_platform.execution_grants WHERE id=$1`,[grant.id,id,expiresAt]);
     await db.query("UPDATE agents_platform.tasks SET grant_id=$2 WHERE id=$1",[taskId,id]);
    }
    await this.lockedExecution(db,taskId);await this.source(db,row);
    const connection=(await db.query("SELECT * FROM agents_platform.connections WHERE id=$1 FOR SHARE",[row.connection_id])).rows[0];
    const target=this.options.targets.find(target=>target.id===row.target_id);
    if(!connection||connection.profile_id!=="report-delivery-v1"||connection.state!=="active"||new Date(connection.expires_at).getTime()<=Date.now()||connection.revision!==row.connection_revision||!target||requestDigest(target)!==row.target_digest)throw new PlatformError("CONNECTION_CHANGED",409,"Connection changed after review");
   }
   const updated=(await db.query("UPDATE agents_platform.actions SET state=$2,approved_at=CASE WHEN $2='approved' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING *",[actionId,state])).rows[0];
   const dto=await this.visibleDTO(db,updated);await db.query("INSERT INTO agents_platform.action_decisions(action_id,operation_id,request_digest,result) VALUES($1,$2,$3,$4)",[actionId,input.operationId,digest,JSON.stringify({id:dto.id,state:dto.state})]);
   await notifyActionTask(db,taskId);await event(db,taskId,`action:${actionId}:decision`,"action.decided",{actionId,state});return dto;
  });
 }
 private async claim(taskId:string,actionId:string):Promise<{row:Record<string,any>;fresh:boolean}>{
  // Object integrity is checked before the claim; current metadata and source authority are locked again below.
  const first=(await this.pool.query("SELECT * FROM agents_platform.actions WHERE id=$1 AND task_id=$2",[actionId,taskId])).rows[0];if(!first)throw actionMissing();
  if(first.state==="approved")await this.options.artifacts.readForTask(taskId,first.artifact_id);
  return transaction(this.pool,async db=>{
   const before=await loadExecution(db,taskId);await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[before.task.organization_id]);
   const row=(await db.query("SELECT * FROM agents_platform.actions WHERE id=$1 AND task_id=$2 FOR UPDATE",[actionId,taskId])).rows[0];if(!row)throw actionMissing();
   if(row.state!=="approved")return{row,fresh:false};
   const execution=await this.lockedExecution(db,taskId);
   const connection=(await db.query("SELECT * FROM agents_platform.connections WHERE id=$1 AND organization_id=$2 AND account_id=$3 FOR SHARE",[row.connection_id,row.organization_id,row.account_id])).rows[0];
   const target=this.options.targets.find(target=>target.id===row.target_id&&target.resource===connection?.resource);
   if(!connection||connection.profile_id!=="report-delivery-v1"||connection.state!=="active"||new Date(connection.expires_at).getTime()<=Date.now()||connection.revision!==row.connection_revision||execution.connectionId!==row.connection_id||execution.accountId!==row.account_id||!target||requestDigest(target)!==row.target_digest)throw new PlatformError("CONNECTION_CHANGED",409,"Connection changed after review");
   if(new Date(row.expires_at).getTime()<=Date.now()){const expired=(await db.query("UPDATE agents_platform.actions SET state='expired',updated_at=now() WHERE id=$1 RETURNING *",[actionId])).rows[0];return{row:expired,fresh:false};}
   await this.source(db,row);await requireActionMember(db,{organizationId:row.organization_id,accountId:row.reviewer_account_id});
   if(this.bindingDigest(execution,row.reviewer_account_id)!==row.binding_digest)throw new PlatformError("ACTION_BINDING_CHANGED",409,"Published report workflow changed");
   if(requestDigest(row.payload)!==row.payload_digest)throw new PlatformError("ACTION_PAYLOAD_CHANGED",409,"Reviewed report changed");
   const credentials=(await db.query("SELECT envelope FROM agents_platform.connection_credentials WHERE connection_id=$1 AND revision=$2",[connection.id,connection.revision])).rows[0];
   this.options.vault.open(row.organization_id,connection.id,connection.revision,credentials.envelope);
   const claimed=(await db.query("UPDATE agents_platform.actions SET state='claimed',claimed_at=now(),updated_at=now() WHERE id=$1 RETURNING *",[actionId])).rows[0];
   await event(db,taskId,`action:${actionId}:claimed`,"action.claimed",{actionId,payloadDigest:row.payload_digest});return{row:claimed,fresh:true};
  });
 }
 private async credentials(row:Record<string,any>){
  const target=this.options.targets.find(target=>target.id===row.target_id&&target.resource===row.payload.resource);if(!target||requestDigest(target)!==row.target_digest)throw new PlatformError("DELIVERY_CONFIGURATION",503,"Report destination is unavailable");
  const credential=(await this.pool.query("SELECT envelope FROM agents_platform.connection_credentials WHERE connection_id=$1 AND revision=$2",[row.connection_id,row.connection_revision])).rows[0];
  if(!credential)throw new PlatformError("CONNECTION_VAULT_UNAVAILABLE",503,"Connection credentials are unavailable");
  return{target,apiKey:this.options.vault.open(row.organization_id,row.connection_id,row.connection_revision,credential.envelope)};
 }
 async deliver(taskId:string,actionId:string):Promise<ActionDTO>{
  const claim=await this.claim(taskId,actionId);if(!claim.fresh)return["claimed","uncertain"].includes(claim.row.state)?this.reconcile(actionId):this.dto(claim.row);
  const {target,apiKey}=await this.credentials(claim.row),outcome=await this.adapter.request(target,apiKey,actionId,claim.row.payload,claim.row.payload_digest);
  return this.saveOutcome(claim.row,outcome);
 }
 execute(taskId:string,actionId:string){return this.deliver(taskId,actionId);}
 private async saveOutcome(row:Record<string,any>,outcome:Awaited<ReturnType<ReportDeliveryHTTP["request"]>>):Promise<ActionDTO>{
  const state=outcome.state==="absent"?"uncertain":outcome.state,error=outcome.state==="absent"?"DELIVERY_NOT_OBSERVED":outcome.state==="uncertain"||outcome.state==="failed"?outcome.errorCode:null;
  const result=(await this.pool.query("UPDATE agents_platform.actions SET state=$2,receipt=coalesce(receipt,$3),error_code=$4,updated_at=now() WHERE id=$1 AND state IN ('claimed','uncertain') RETURNING *",[row.id,state,outcome.state==="delivered"?JSON.stringify(outcome.receipt):null,error])).rows[0];
  return result?this.dto(result):this.get(row.task_id,row.id);
 }
 async reconcile(actionId:string):Promise<ActionDTO>{
  const row=(await this.pool.query("SELECT * FROM agents_platform.actions WHERE id=$1",[actionId])).rows[0];if(!row)throw actionMissing();if(!["claimed","uncertain"].includes(row.state))return this.dto(row);
  // Only a scoped status GET is permitted here: no renewed task authority and no fresh provider write.
  try{const {target,apiKey}=await this.credentials(row);return this.saveOutcome(row,await this.adapter.request(target,apiKey,actionId,undefined,row.payload_digest));}
  catch{return this.saveOutcome(row,{state:"uncertain",errorCode:"DELIVERY_RECONCILIATION_UNAVAILABLE"});}
 }
 async reconcilePending():Promise<number>{const rows=(await this.pool.query("SELECT id FROM agents_platform.actions WHERE state IN ('claimed','uncertain') ORDER BY updated_at LIMIT 100")).rows;for(const row of rows)await this.reconcile(row.id);return rows.length;}
}
