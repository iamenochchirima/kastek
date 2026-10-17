import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import {PlatformError,requestDigest} from "./contracts";
import {transaction} from "./database";
import type {DeliveryTarget} from "./report-delivery";
import {ConnectionVault} from "./vault";
export interface ActionScope {accountId:string;organizationId:string}
export interface ConnectionDTO {id:string;name:string;targetId:string;targetLabel:string;resource:string;revision:number;state:"active"|"revoked";createdAt:string;expiresAt:string}
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
 dto(row:Record<string,any>):ConnectionDTO{return{id:row.id,name:row.name,targetId:row.target_id,targetLabel:this.targets.find(target=>target.id===row.target_id)?.label??"Unavailable destination",resource:row.resource,revision:row.revision,state:row.state,createdAt:new Date(row.created_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString()};}
 async list(scope:ActionScope){return transaction(this.pool,async db=>{await requireActionMember(db,scope);return(await db.query("SELECT * FROM agents_platform.connections WHERE organization_id=$1 AND account_id=$2 ORDER BY created_at,id",[scope.organizationId,scope.accountId])).rows.map(row=>this.dto(row));});}
 async create(scope:ActionScope,raw:{operationId:string;name:string;targetId:string;apiKey:string;expiresAt?:string}){
 const input=z.strictObject({operationId:z.string().min(1).max(128),name:z.string().trim().min(1).max(120),targetId:z.string().max(64),apiKey:z.string().min(16).max(4096),expiresAt:z.iso.datetime().optional()}).parse(raw);
 const target=this.targets.find(item=>item.id===input.targetId);if(!target)throw new PlatformError("DELIVERY_TARGET_DENIED",400,"Select an available destination");
 return transaction(this.pool,async db=>{
 await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);await requireActionMember(db,scope);
 const digest=requestDigest({kind:"create",...input}),old=await this.replay(db,scope,input.operationId,digest);if(old)return old;
 const expiresAt=this.expiry(input.expiresAt),id=randomUUID(),envelope=this.vault.seal(scope.organizationId,id,1,input.apiKey);
 const row=(await db.query("INSERT INTO agents_platform.connections(id,organization_id,account_id,name,target_id,resource,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[id,scope.organizationId,scope.accountId,input.name,target.id,target.resource,expiresAt])).rows[0];
 await db.query("INSERT INTO agents_platform.connection_credentials(connection_id,revision,envelope) VALUES($1,1,$2)",[id,JSON.stringify(envelope)]);
 const dto=this.dto(row);await this.record(db,scope,input.operationId,digest,dto);return dto;
 });}
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
 if(!row)throw actionMissing();if(row.revision!==input.expectedRevision||row.state!=="active"||new Date(row.expires_at).getTime()<=Date.now())throw new PlatformError("CONNECTION_REVISION_CONFLICT",409,"Connection changed; refresh and try again");
 const revision=row.revision+1,expiresAt=input.expiresAt?this.expiry(input.expiresAt):row.expires_at;
 if(kind==="rotate"){const envelope=this.vault.seal(scope.organizationId,id,revision,input.apiKey!);await db.query("INSERT INTO agents_platform.connection_credentials(connection_id,revision,envelope) VALUES($1,$2,$3)",[id,revision,JSON.stringify(envelope)]);}
 const current=(await db.query("UPDATE agents_platform.connections SET revision=$2,state=$3,expires_at=$4 WHERE id=$1 RETURNING *",[id,revision,kind==="revoke"?"revoked":"active",expiresAt])).rows[0];
 const invalidated=(await db.query("UPDATE agents_platform.actions SET state='invalidated',error_code='CONNECTION_CHANGED',updated_at=now() WHERE connection_id=$1 AND state IN ('pending_review','approved') RETURNING task_id",[id])).rows;
 for(const action of invalidated)await notifyActionTask(db,action.task_id);
 const dto=this.dto(current);await this.record(db,scope,input.operationId,digest,dto);return dto;
 });}
}
