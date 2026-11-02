import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import type { DeliveryTarget } from "../../adapters/providers/report-delivery";
import { resourceHandleSchema } from "../../contracts/capability-catalog";
import type { ActionScope,ConnectionDTO } from "../../contracts/connections";
import { PlatformError,requestDigest } from "../../contracts/contracts";
import { githubRepositoryHandle,githubRepositorySelectionSchema } from "../../contracts/github";
import { actionMissing,notifyActionTask,requireActionMember } from "../../infrastructure/action-authority";
import { transaction } from "../../infrastructure/database";
import { ConnectionVault } from "../../infrastructure/vault";
export const connectionProfileSchema=z.enum(["report-delivery-v1","github-public-read-v1","stash-read-v1","public-repository-read-v1"]);
export type ConnectionProfile=z.infer<typeof connectionProfileSchema>;
export const connectionProfiles=Object.freeze([
 {id:"report-delivery-v1",label:"Report delivery",allowedTransports:["builtin"]},
 {id:"github-public-read-v1",label:"GitHub",allowedTransports:["native_http","mcp_http"]},
 {id:"stash-read-v1",label:"Stash",allowedTransports:["mcp_http"]},
 {id:"public-repository-read-v1",label:"Public repositories",allowedTransports:["native_http","mcp_http"]},
]);
export const createConnectionSchema=z.strictObject({operationId:z.string().min(1).max(128),name:z.string().trim().min(1).max(120),
 targetId:z.string().max(64),apiKey:z.string().min(16).max(4096).optional(),expiresAt:z.iso.datetime().optional(),
 profileId:connectionProfileSchema.default("report-delivery-v1"),selections:z.array(githubRepositorySelectionSchema).max(20).default([]),
 stashItemIds:z.array(z.uuid().transform(id=>id.toLowerCase())).max(20).refine(ids=>new Set(ids).size===ids.length,"Duplicate Stash item").default([])});
export type CreateConnectionInput=z.input<typeof createConnectionSchema>;
export type { ActionScope,ConnectionDTO } from "../../contracts/connections";
export { actionMissing,notifyActionTask,requireActionMember } from "../../infrastructure/action-authority";
export class ConnectionStore {
 constructor(readonly pool:Pool,readonly vault:ConnectionVault,readonly targets:DeliveryTarget[]){}
 dto(row:Record<string,any>):ConnectionDTO{return{id:row.id,name:row.name,targetId:row.target_id,targetLabel:row.target_id==="provider:public-repository"?"Public repositories":row.target_id==="provider:stash"?"Stash":row.target_id==="provider:github"?"GitHub":this.targets.find(target=>target.id===row.target_id)?.label??"Unavailable destination",resource:row.resource,profileId:row.profile_id??"report-delivery-v1",authentication:row.profile_id==="public-repository-read-v1"?"none":"bearer",policyRevision:row.policy_revision??1,resources:z.array(resourceHandleSchema).parse(row.resource_handles??[]),selections:z.array(githubRepositorySelectionSchema).parse(row.selections??[]),stashItemIds:z.array(resourceHandleSchema).parse(row.resource_handles??[]).filter(handle=>handle.kind==="stash.item").map(handle=>z.uuid().parse(handle.id)),revision:row.revision,state:row.state,createdAt:new Date(row.created_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString()};}
 async list(scope:ActionScope,includeRemote=false){return transaction(this.pool,async db=>{await requireActionMember(db,scope);return(await db.query("SELECT * FROM agents_platform.connections WHERE organization_id=$1 AND account_id=$2 AND NOT EXISTS (SELECT 1 FROM agents_platform.native_provider_connections p WHERE p.connection_id=connections.id) AND ($3 OR profile_id NOT IN ('remote-mcp-v1','custom-api-v1')) ORDER BY created_at,id",[scope.organizationId,scope.accountId,includeRemote])).rows.map(row=>this.dto(row));});}
 async create(scope:ActionScope,raw:CreateConnectionInput){
 const input=createConnectionSchema.parse(raw),provider=input.profileId!=="report-delivery-v1",anonymous=input.profileId==="public-repository-read-v1";
 const target=this.targets.find(item=>item.id===input.targetId);
 if(anonymous){
  if(input.targetId!=="provider:public-repository"||input.stashItemIds.length||!input.selections.length||new Set(input.selections.map(selection=>githubRepositoryHandle(selection).id)).size!==input.selections.length||input.selections.some(selection=>/[\s\"'?#]/.test(selection.ref)||selection.ref.includes("://")))throw new PlatformError("CONNECTION_PROFILE_INVALID",400,"Select approved public repositories");
  if(input.apiKey!==undefined)throw new PlatformError("CONNECTION_KEY_INVALID",400,"Public repositories do not use an API key");
 }else if(input.profileId==="github-public-read-v1"){
  if(input.targetId!=="provider:github"||input.stashItemIds.length||!input.selections.length||new Set(input.selections.map(selection=>githubRepositoryHandle(selection).id)).size!==input.selections.length)throw new PlatformError("CONNECTION_PROFILE_INVALID",400,"Select approved GitHub repositories");
 }else if(input.profileId==="stash-read-v1"){
  if(input.targetId!=="provider:stash"||input.selections.length||!input.stashItemIds.length)throw new PlatformError("CONNECTION_PROFILE_INVALID",400,"Select approved Stash items");
 }else if(!target||input.targetId.startsWith("provider:")||input.selections.length||input.stashItemIds.length)throw new PlatformError("DELIVERY_TARGET_DENIED",400,"Select an available destination");
 if(!anonymous&&!input.apiKey)throw new PlatformError("CONNECTION_KEY_INVALID",400,"Enter a scoped API key");
 if(provider&&!anonymous){
  this.providerKey(input.apiKey!,input.profileId);if(!input.expiresAt)throw new PlatformError("CONNECTION_EXPIRY_INVALID",400,input.profileId==="stash-read-v1"?"Set the local connection expiry":"Enter the scoped token expiry");
 }
 return transaction(this.pool,async db=>{
 await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);await requireActionMember(db,scope);
 const digest=requestDigest({kind:"create",...input}),old=await this.replay(db,scope,input.operationId,digest);if(old)return old;
 const expiresAt=this.expiry(input.expiresAt),id=randomUUID(),envelope=anonymous?null:this.vault.seal(scope.organizationId,id,1,input.apiKey!);
 const resources=input.profileId==="stash-read-v1"?input.stashItemIds.map(id=>({kind:"stash.item",id})):provider?input.selections.map(githubRepositoryHandle):[{kind:"report.destination",id:target!.resource}];
 const row=(await db.query("INSERT INTO agents_platform.connections(id,organization_id,account_id,name,target_id,resource,expires_at,profile_id,resource_handles,selections) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",[id,scope.organizationId,scope.accountId,input.name,input.targetId,input.profileId==="stash-read-v1"?"stash:approved-items":provider?"github:public-repositories":target!.resource,expiresAt,input.profileId,JSON.stringify(resources),JSON.stringify(input.selections)])).rows[0];
 await db.query("INSERT INTO agents_platform.connection_credentials(connection_id,revision,envelope) VALUES($1,1,$2)",[id,envelope===null?null:JSON.stringify(envelope)]);
 const dto=this.dto(row);await this.record(db,scope,input.operationId,digest,dto);return dto;
 });}
 private providerKey(key:string,profileId:ConnectionProfile){
  if(profileId==="stash-read-v1"){
   if(/\s/.test(key)||/^(?:github_pat_|gh[pousr]_)/.test(key))throw new PlatformError("CONNECTION_KEY_INVALID",400,"Enter a Stash API key without whitespace");
  }else if(profileId==="github-public-read-v1"){
   if(!key.startsWith("github_pat_")||/\s/.test(key))throw new PlatformError("CONNECTION_KEY_INVALID",400,"Enter a fine-grained GitHub token");
  }else throw new PlatformError("CONNECTION_PROFILE_INVALID",400,"Select an approved connection profile");
 }
 // Key shape grants no permissions; discovery and execution check the selected resources.
 async resolveCredential(db:PoolClient,scope:ActionScope,id:string,expectedPolicyRevision:number){
  await requireActionMember(db,scope);
  const row=(await db.query("SELECT c.*,k.envelope FROM agents_platform.connections c JOIN agents_platform.connection_credentials k ON k.connection_id=c.id AND k.revision=c.revision WHERE c.id=$1 AND c.organization_id=$2 AND c.account_id=$3 FOR SHARE OF c",[id,scope.organizationId,scope.accountId])).rows[0];
  if(!row||row.state!=="active"||new Date(row.expires_at).getTime()<=Date.now()||row.policy_revision!==expectedPolicyRevision)throw new PlatformError("CONNECTION_INACTIVE",403,"Connection authorization is unavailable");
  if(row.profile_id==="public-repository-read-v1"){
   if(row.envelope!==null)throw new PlatformError("CONNECTION_AUTHENTICATION_INVALID",403,"Anonymous connection has unexpected credentials");
   return{connection:this.dto(row),authorization:""};
  }
  if((await db.query("SELECT 1 FROM agents_platform.native_provider_connections WHERE connection_id=$1",[id])).rowCount)throw new PlatformError("PROVIDER_SCOPE_REQUIRED",403,"Use the provider connection authority");
  if(row.envelope===null)throw new PlatformError("CONNECTION_AUTHENTICATION_INVALID",403,"Connection credentials are unavailable");
  if(row.profile_id==="remote-mcp-v1"){
   const metadata=(await db.query("SELECT status,auth_method FROM agents_platform.connection_onboarding WHERE connection_id=$1 FOR SHARE",[id])).rows[0];
   if(!metadata||!["ready","selection_required"].includes(metadata.status))throw new PlatformError("CONNECTION_INACTIVE",403,"Connection authorization is unavailable");
   const secret=JSON.parse(this.vault.open(scope.organizationId,id,row.revision,row.envelope));
   const token=secret.authorization?.tokens;
   if(token?.expires_in&&secret.authorization?.issuedAt&&secret.authorization.issuedAt+token.expires_in*1000<=Date.now())throw new PlatformError("AUTHENTICATION",401,"Reconnect this server to continue");
   return{connection:this.dto(row),authorization:token?.access_token??secret.secret??""};
  }
  return{connection:this.dto(row),authorization:this.vault.open(scope.organizationId,id,row.revision,row.envelope)};
 }
 private expiry(value?:string):Date{const expiresAt=value?new Date(value):new Date(Date.now()+30*86400000);if(expiresAt.getTime()<=Date.now()||expiresAt.getTime()>Date.now()+90*86400000)throw new PlatformError("CONNECTION_EXPIRY_INVALID",400,"Set an expiry within 90 days");return expiresAt;}
 private async replay(db:PoolClient,scope:ActionScope,operationId:string,digest:string):Promise<ConnectionDTO|undefined>{
 const old=(await db.query("SELECT * FROM agents_platform.connection_mutations WHERE organization_id=$1 AND account_id=$2 AND operation_id=$3",[scope.organizationId,scope.accountId,operationId])).rows[0];
 if(old&&old.request_digest!==digest)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"Request identity conflict");return old?.result;}
 private async record(db:PoolClient,scope:ActionScope,operationId:string,digest:string,result:ConnectionDTO){await db.query("INSERT INTO agents_platform.connection_mutations(organization_id,account_id,operation_id,request_digest,connection_id,result) VALUES($1,$2,$3,$4,$5,$6)",[scope.organizationId,scope.accountId,operationId,digest,result.id,JSON.stringify(result)]);}
 async mutate(scope:ActionScope,id:string,raw:{operationId:string;expectedRevision:number;apiKey?:string;expiresAt?:string},kind:"rotate"|"revoke"){
 z.uuid().parse(id);const input=z.strictObject({operationId:z.string().min(1).max(128),expectedRevision:z.number().int().positive(),apiKey:z.string().min(16).max(4096).optional(),expiresAt:z.iso.datetime().optional()}).parse(raw);
 return transaction(this.pool,async db=>{
 await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);await requireActionMember(db,scope);
 const digest=requestDigest({kind,id,...input}),old=await this.replay(db,scope,input.operationId,digest);if(old)return old;
 const row=(await db.query("SELECT * FROM agents_platform.connections WHERE id=$1 AND organization_id=$2 AND account_id=$3 FOR UPDATE",[id,scope.organizationId,scope.accountId])).rows[0];
 if(!row)throw actionMissing();
 if((await db.query("SELECT 1 FROM agents_platform.native_provider_connections WHERE connection_id=$1",[id])).rowCount)throw new PlatformError("PROVIDER_SCOPE_REQUIRED",403,"Use the provider connection controls");
 if(row.revision!==input.expectedRevision||row.state!=="active"||(new Date(row.expires_at).getTime()<=Date.now()&&row.profile_id!=="public-repository-read-v1"&&(row.profile_id==="report-delivery-v1"||kind!=="rotate"||!input.expiresAt)))throw new PlatformError("CONNECTION_REVISION_CONFLICT",409,"Connection changed; refresh and try again");
 if(kind==="rotate"&&row.profile_id==="public-repository-read-v1")throw new PlatformError("CONNECTION_ROTATION_DENIED",400,"Anonymous connections have no key to rotate");
 if(row.profile_id==="public-repository-read-v1"&&input.apiKey!==undefined)throw new PlatformError("CONNECTION_KEY_INVALID",400,"Public repositories do not use an API key");
 if(kind==="rotate"&&!input.apiKey)throw new PlatformError("CONNECTION_KEY_INVALID",400,"Enter a scoped API key");
 if(kind==="rotate"&&row.profile_id!=="report-delivery-v1")this.providerKey(input.apiKey!,connectionProfileSchema.parse(row.profile_id));
 const revision=row.revision+1,expiresAt=input.expiresAt?this.expiry(input.expiresAt):row.expires_at;
 if(kind==="rotate"){const envelope=this.vault.seal(scope.organizationId,id,revision,input.apiKey!);await db.query("INSERT INTO agents_platform.connection_credentials(connection_id,revision,envelope) VALUES($1,$2,$3)",[id,revision,JSON.stringify(envelope)]);}
 const current=(await db.query("UPDATE agents_platform.connections SET revision=$2,state=$3,expires_at=$4,policy_revision=policy_revision+CASE WHEN $3='revoked' THEN 1 ELSE 0 END WHERE id=$1 RETURNING *",[id,revision,kind==="revoke"?"revoked":"active",expiresAt])).rows[0];
 const invalidated=(await db.query("UPDATE agents_platform.actions SET state='invalidated',error_code='CONNECTION_CHANGED',updated_at=now() WHERE connection_id=$1 AND state IN ('pending_review','approved') RETURNING task_id",[id])).rows;
 for(const action of invalidated)await notifyActionTask(db,action.task_id);
 const dto=this.dto(current);await this.record(db,scope,input.operationId,digest,dto);return dto;
 });}
}
