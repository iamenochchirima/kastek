import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import {PlatformError,requestDigest} from "./contracts";
import {transaction} from "./database";
import type {DeliveryTarget} from "./report-delivery";
import {ConnectionVault} from "./vault";
import {resourceHandleSchema,type ResourceHandle} from "./capability-catalog";
import {githubRepositorySelectionSchema,githubRepositoryHandle,type GithubRepositorySelection} from "./github-adapter";
export const connectionProfileSchema=z.enum(["report-delivery-v1","github-public-read-v1"]);
export type ConnectionProfile=z.infer<typeof connectionProfileSchema>;
export const connectionProfiles=Object.freeze([
 {id:"report-delivery-v1",label:"Report delivery",allowedTransports:["builtin"]},
 {id:"github-public-read-v1",label:"GitHub",allowedTransports:["native_http","mcp_http"]},
]);
export const createConnectionSchema=z.strictObject({operationId:z.string().min(1).max(128),name:z.string().trim().min(1).max(120),
 targetId:z.string().max(64),apiKey:z.string().min(16).max(4096),expiresAt:z.iso.datetime().optional(),
 profileId:connectionProfileSchema.default("report-delivery-v1"),selections:z.array(githubRepositorySelectionSchema).max(20).default([])});
export type CreateConnectionInput=z.input<typeof createConnectionSchema>;
export interface ActionScope {accountId:string;organizationId:string}
export interface ConnectionDTO {id:string;name:string;targetId:string;targetLabel:string;resource:string;profileId:ConnectionProfile;policyRevision:number;resources:ResourceHandle[];selections:GithubRepositorySelection[];revision:number;state:"active"|"revoked";createdAt:string;expiresAt:string}
export const actionMissing=()=>new PlatformError("ACTION_NOT_FOUND",404,"Action not found");
export async function requireActionMember(db:Pool|PoolClient,scope:ActionScope){
 if(!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE account_id=$1 AND organization_id=$2 AND revoked_at IS NULL FOR SHARE",[scope.accountId,scope.organizationId])).rowCount)throw new PlatformError("ACCESS_DENIED",403,"Workspace access is unavailable");
}
export async function notifyActionTask(db:PoolClient,taskId:string){
 const row=(await db.query("UPDATE agents_platform.tasks SET control_generation=control_generation+1,updated_at=now() WHERE id=$1 RETURNING control_generation-1 AS generation",[taskId])).rows[0];
 if(row)await db.query("INSERT INTO agents_platform.task_controls(task_id,generation,kind) VALUES($1,$2,'review') ON CONFLICT DO NOTHING",[taskId,row.generation]);
}
export class ConnectionStore {
 constructor(readonly pool:Pool,readonly vault:ConnectionVault,readonly targets:DeliveryTarget[]){}
 dto(row:Record<string,any>):ConnectionDTO{return{id:row.id,name:row.name,targetId:row.target_id,targetLabel:row.target_id==="provider:github"?"GitHub":this.targets.find(target=>target.id===row.target_id)?.label??"Unavailable destination",resource:row.resource,profileId:row.profile_id??"report-delivery-v1",policyRevision:row.policy_revision??1,resources:z.array(resourceHandleSchema).parse(row.resource_handles??[]),selections:z.array(githubRepositorySelectionSchema).parse(row.selections??[]),revision:row.revision,state:row.state,createdAt:new Date(row.created_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString()};}
 async list(scope:ActionScope){return transaction(this.pool,async db=>{await requireActionMember(db,scope);return(await db.query("SELECT * FROM agents_platform.connections WHERE organization_id=$1 AND account_id=$2 ORDER BY created_at,id",[scope.organizationId,scope.accountId])).rows.map(row=>this.dto(row));});}
 async create(scope:ActionScope,raw:CreateConnectionInput){
 const input=createConnectionSchema.parse(raw),provider=input.profileId!=="report-delivery-v1";
 const target=this.targets.find(item=>item.id===input.targetId);
 if(provider){
  if(input.targetId!=="provider:github"||!input.selections.length||new Set(input.selections.map(selection=>githubRepositoryHandle(selection).id)).size!==input.selections.length)throw new PlatformError("CONNECTION_PROFILE_INVALID",400,"Select approved GitHub repositories");
  this.providerKey(input.apiKey);if(!input.expiresAt)throw new PlatformError("CONNECTION_EXPIRY_INVALID",400,"Enter the scoped token expiry");
 }else if(!target||input.targetId==="provider:github"||input.selections.length)throw new PlatformError("DELIVERY_TARGET_DENIED",400,"Select an available destination");
 return transaction(this.pool,async db=>{
 await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);await requireActionMember(db,scope);
 const digest=requestDigest({kind:"create",...input}),old=await this.replay(db,scope,input.operationId,digest);if(old)return old;
 const expiresAt=this.expiry(input.expiresAt),id=randomUUID(),envelope=this.vault.seal(scope.organizationId,id,1,input.apiKey);
 const resources=provider?input.selections.map(githubRepositoryHandle):[{kind:"report.destination",id:target!.resource}];
 const row=(await db.query("INSERT INTO agents_platform.connections(id,organization_id,account_id,name,target_id,resource,expires_at,profile_id,resource_handles,selections) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",[id,scope.organizationId,scope.accountId,input.name,input.targetId,provider?"github:public-repositories":target!.resource,expiresAt,input.profileId,JSON.stringify(resources),JSON.stringify(input.selections)])).rows[0];
 await db.query("INSERT INTO agents_platform.connection_credentials(connection_id,revision,envelope) VALUES($1,1,$2)",[id,JSON.stringify(envelope)]);
 const dto=this.dto(row);await this.record(db,scope,input.operationId,digest,dto);return dto;
 });}
 private providerKey(key:string){if(!key.startsWith("github_pat_")||/[\r\n]/.test(key))throw new PlatformError("CONNECTION_KEY_INVALID",400,"Enter a fine-grained GitHub token");}
 // Token shape is not a permissions check; provider discovery validates the actual selected public resources.
 async resolveCredential(db:PoolClient,scope:ActionScope,id:string,expectedPolicyRevision:number){
  await requireActionMember(db,scope);
  const row=(await db.query("SELECT c.*,k.envelope FROM agents_platform.connections c JOIN agents_platform.connection_credentials k ON k.connection_id=c.id AND k.revision=c.revision WHERE c.id=$1 AND c.organization_id=$2 AND c.account_id=$3 FOR SHARE OF c",[id,scope.organizationId,scope.accountId])).rows[0];
  if(!row||row.state!=="active"||new Date(row.expires_at).getTime()<=Date.now()||row.policy_revision!==expectedPolicyRevision)throw new PlatformError("CONNECTION_INACTIVE",403,"Connection authorization is unavailable");
  return{connection:this.dto(row),authorization:this.vault.open(scope.organizationId,id,row.revision,row.envelope)};
 }
 private expiry(value?:string):Date{const expiresAt=value?new Date(value):new Date(Date.now()+30*86400000);if(expiresAt.getTime()<=Date.now()||expiresAt.getTime()>Date.now()+90*86400000)throw new PlatformError("CONNECTION_EXPIRY_INVALID",400,"Set an expiry within 90 days");return expiresAt;}
 private async replay(db:PoolClient,scope:ActionScope,operationId:string,digest:string):Promise<ConnectionDTO|undefined>{
 const old=(await db.query("SELECT * FROM agents_platform.connection_mutations WHERE organization_id=$1 AND account_id=$2 AND operation_id=$3",[scope.organizationId,scope.accountId,operationId])).rows[0];
 if(old&&old.request_digest!==digest)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"Request identity conflict");return old?.result;}
 private async record(db:PoolClient,scope:ActionScope,operationId:string,digest:string,result:ConnectionDTO){await db.query("INSERT INTO agents_platform.connection_mutations(organization_id,account_id,operation_id,request_digest,connection_id,result) VALUES($1,$2,$3,$4,$5,$6)",[scope.organizationId,scope.accountId,operationId,digest,result.id,JSON.stringify(result)]);}
 async mutate(scope:ActionScope,id:string,raw:{operationId:string;expectedRevision:number;apiKey?:string;expiresAt?:string},kind:"rotate"|"revoke"){
 z.uuid().parse(id);const input=z.strictObject({operationId:z.string().min(1).max(128),expectedRevision:z.number().int().positive(),apiKey:z.string().min(16).max(4096).optional(),expiresAt:z.iso.datetime().optional()}).parse(raw);
 if(kind==="rotate"&&!input.apiKey)throw new PlatformError("CONNECTION_KEY_INVALID",400,"Enter a scoped API key");
 return transaction(this.pool,async db=>{
 await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);await requireActionMember(db,scope);
 const digest=requestDigest({kind,id,...input}),old=await this.replay(db,scope,input.operationId,digest);if(old)return old;
 const row=(await db.query("SELECT * FROM agents_platform.connections WHERE id=$1 AND organization_id=$2 AND account_id=$3 FOR UPDATE",[id,scope.organizationId,scope.accountId])).rows[0];
 if(!row)throw actionMissing();if(row.revision!==input.expectedRevision||row.state!=="active"||(new Date(row.expires_at).getTime()<=Date.now()&&(row.profile_id==="report-delivery-v1"||kind!=="rotate"||!input.expiresAt)))throw new PlatformError("CONNECTION_REVISION_CONFLICT",409,"Connection changed; refresh and try again");
 if(kind==="rotate"&&row.profile_id!=="report-delivery-v1")this.providerKey(input.apiKey!);
 const revision=row.revision+1,expiresAt=input.expiresAt?this.expiry(input.expiresAt):row.expires_at;
 if(kind==="rotate"){const envelope=this.vault.seal(scope.organizationId,id,revision,input.apiKey!);await db.query("INSERT INTO agents_platform.connection_credentials(connection_id,revision,envelope) VALUES($1,$2,$3)",[id,revision,JSON.stringify(envelope)]);}
 const current=(await db.query("UPDATE agents_platform.connections SET revision=$2,state=$3,expires_at=$4,policy_revision=policy_revision+CASE WHEN $3='revoked' THEN 1 ELSE 0 END WHERE id=$1 RETURNING *",[id,revision,kind==="revoke"?"revoked":"active",expiresAt])).rows[0];
 const invalidated=(await db.query("UPDATE agents_platform.actions SET state='invalidated',error_code='CONNECTION_CHANGED',updated_at=now() WHERE connection_id=$1 AND state IN ('pending_review','approved') RETURNING task_id",[id])).rows;
 for(const action of invalidated)await notifyActionTask(db,action.task_id);
 const dto=this.dto(current);await this.record(db,scope,input.operationId,digest,dto);return dto;
 });}
}
