import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import {procedureApplicabilitySchema,procedureEvidenceSchema,procedureReferenceSchema,procedureScopeSchema,procedureUpdateSchema,type ProcedureApplicability,type ProcedureEvidence,type ProcedureInstance,type ProcedureReference,type ProcedureScope,type ProcedureUpdate} from "../../contracts/procedures";
import {PlatformError,requestDigest} from "../../contracts/primitives";
import {transaction} from "../../infrastructure/database";
import {resolveProcedure} from "./definitions";

export type ProcedureEvidenceVerifier=(db:PoolClient,scope:ProcedureScope,evidence:ProcedureEvidence)=>Promise<boolean|void>;
const missing=()=>new PlatformError("PROCEDURE_NOT_FOUND",404,"Procedure not found");
const conflict=()=>new PlatformError("PROCEDURE_CONFLICT",409,"Procedure changed. Inspect it and try again");
function dto(row:any):ProcedureInstance {
 const progress=resolveProcedure({id:row.definition_id,version:row.definition_version}).progress(row.route,row.receipts);
 return {id:row.id,organizationId:row.organization_id,agentId:row.agent_id,conversationId:row.conversation_id,definition:{id:row.definition_id,version:row.definition_version},revision:String(row.revision),status:row.status,route:row.route,applicability:row.applicability,receipts:row.receipts,missing:progress.missing,hasUnknownEffects:progress.hasUnknownEffects,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()};
}
export class ProcedureStore {
 constructor(readonly pool:Pool|PoolClient,readonly verifyEvidence?:ProcedureEvidenceVerifier){}
 private run<T>(work:(db:PoolClient)=>Promise<T>):Promise<T>{return "release" in this.pool?work(this.pool as PoolClient):transaction(this.pool as Pool,work);}
 private async authorize(db:PoolClient,raw:ProcedureScope){
  const scope=procedureScopeSchema.parse(raw);
  if(!(await db.query(`SELECT 1 FROM agents_platform.conversations WHERE organization_id=$1 AND agent_id=$2 AND id=$3 AND deleted_at IS NULL FOR SHARE`,[scope.organizationId,scope.agentId,scope.conversationId])).rowCount)throw missing();
 }
 private async command(db:PoolClient,scope:ProcedureScope,commandId:string,input:unknown,work:()=>Promise<ProcedureInstance>){
  await this.authorize(db,scope);
  // Commands serialize before reading their receipt, including concurrent starts.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${scope.organizationId}:${commandId}`]);
  const digest=requestDigest({scope,input});
  const existing=(await db.query('SELECT request_digest,result FROM agents_platform.business_procedure_commands WHERE organization_id=$1 AND command_id=$2',[scope.organizationId,commandId])).rows[0];
  if(existing){if(existing.request_digest!==digest)throw new PlatformError("PROCEDURE_COMMAND_CONFLICT",409,"Command was already used with different input");return existing.result as ProcedureInstance;}
  const result=await work();
  await db.query('INSERT INTO agents_platform.business_procedure_commands(organization_id,instance_id,command_id,request_digest,result) VALUES($1,$2,$3,$4,$5)',[scope.organizationId,result.id,commandId,digest,result]);
  return result;
 }
 async start(scope:ProcedureScope,rawReference:ProcedureReference,raw:{commandId:string;applicability:ProcedureApplicability;taskId?:string}){
  const reference=procedureReferenceSchema.parse(rawReference),commandId=z.uuid().parse(raw.commandId),applicability=procedureApplicabilitySchema.parse(raw.applicability);
  const taskId=raw.taskId===undefined?null:z.uuid().parse(raw.taskId);
  const definition=resolveProcedure(reference);
  if(!definition.validateApplicability(applicability))throw new PlatformError("PROCEDURE_NOT_APPLICABLE",409,"Procedure is not applicable to the current facts");
  return this.run(db=>this.command(db,scope,commandId,{reference,applicability,taskId},async()=>{
   if(taskId&&!(await db.query(`SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.organization_id=t.organization_id WHERE t.id=$1 AND t.organization_id=$2 AND t.conversation_id=$3 AND v.agent_id=$4 FOR SHARE OF t,v`,[taskId,scope.organizationId,scope.conversationId,scope.agentId])).rowCount)throw new PlatformError("PROCEDURE_ORIGIN_DENIED",403,"Procedure origin is unavailable");
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${scope.organizationId}:${scope.conversationId}:${reference.id}:${reference.version}`]);const existing=(await db.query("SELECT * FROM agents_platform.business_procedure_instances WHERE organization_id=$1 AND agent_id=$2 AND conversation_id=$3 AND definition_id=$4 AND definition_version=$5 AND status IN ('active','suspended') FOR UPDATE",[scope.organizationId,scope.agentId,scope.conversationId,reference.id,reference.version])).rows[0];if(existing){if(taskId&&!existing.origin_task_id)return dto((await db.query('UPDATE agents_platform.business_procedure_instances SET origin_task_id=$3,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *',[scope.organizationId,existing.id,taskId])).rows[0]);return dto(existing);}return dto((await db.query(`INSERT INTO agents_platform.business_procedure_instances(id,organization_id,agent_id,conversation_id,definition_id,definition_version,applicability,origin_task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[randomUUID(),scope.organizationId,scope.agentId,scope.conversationId,reference.id,reference.version,applicability,taskId])).rows[0]);}));
 }
 async inspect(scope:ProcedureScope,id?:string):Promise<ProcedureInstance[]> {
  if(id)z.uuid().parse(id);
  return this.run(async db=>{await this.authorize(db,scope);return (await db.query(`SELECT * FROM agents_platform.business_procedure_instances WHERE organization_id=$1 AND agent_id=$2 AND conversation_id=$3 AND ($4::uuid IS NULL OR id=$4) ORDER BY (status IN ('active','suspended')) DESC,created_at DESC,id DESC LIMIT 100`,[scope.organizationId,scope.agentId,scope.conversationId,id??null])).rows.map(dto);});
 }
 private async locked(db:PoolClient,scope:ProcedureScope,id:string,revision:string){
  const row=(await db.query('SELECT * FROM agents_platform.business_procedure_instances WHERE organization_id=$1 AND agent_id=$2 AND conversation_id=$3 AND id=$4 FOR UPDATE',[scope.organizationId,scope.agentId,scope.conversationId,z.uuid().parse(id)])).rows[0];
  if(!row)throw missing();if(String(row.revision)!==revision)throw conflict();return row;
 }
 async update(scope:ProcedureScope,id:string,raw:ProcedureUpdate){
  const input=procedureUpdateSchema.parse(raw);
  return this.run(db=>this.command(db,scope,input.commandId,{id,...input},async()=>{
   const row=await this.locked(db,scope,id,input.expectedRevision);
   if(row.status==='cancelled'||row.status==='completed')throw new PlatformError("PROCEDURE_TERMINAL",409,"Procedure has already ended");
   const status=input.action==='cancel'?'cancelled':input.action==='suspend'?'suspended':resolveProcedure({id:row.definition_id,version:row.definition_version}).progress(row.route,row.receipts).complete?'completed':'active';
   return dto((await db.query('UPDATE agents_platform.business_procedure_instances SET status=$3,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *',[scope.organizationId,id,status])).rows[0]);
  }));
 }
 /** Only product adapters may supply evidence; model-facing tools must never expose this input. */
 async recordEvidence(scope:ProcedureScope,id:string,raw:ProcedureEvidence){
  const input=procedureEvidenceSchema.parse(raw);
  if(!this.verifyEvidence)throw new PlatformError("PROCEDURE_EVIDENCE_UNAVAILABLE",409,"Product evidence validation is unavailable");
  return this.run(db=>this.command(db,scope,input.commandId,{id,...input},async()=>{
   const row=await this.locked(db,scope,id,input.expectedRevision);
   const terminal=row.status==='cancelled'||row.status==='completed';
   if(terminal&&input.route!==undefined&&input.route!==row.route)throw new PlatformError("PROCEDURE_TERMINAL",409,"Procedure has already ended");
   if(await this.verifyEvidence!(db,scope,input)===false)throw new PlatformError("PROCEDURE_EVIDENCE_DENIED",403,"Procedure evidence is unavailable");
   const merged=new Map<string,ProcedureEvidence['receipts'][number]>(row.receipts.map((r:ProcedureEvidence['receipts'][number])=>[`${r.kind}:${r.sourceId}`,r]));
   for(const receipt of input.receipts)merged.set(`${receipt.kind}:${receipt.sourceId}`,receipt);
   if(merged.size>256)throw new PlatformError("PROCEDURE_RECEIPT_LIMIT",409,"Procedure receipt limit reached");
   const receipts=[...merged.values()],route=input.route??row.route,progress=resolveProcedure({id:row.definition_id,version:row.definition_version}).progress(route,receipts);
   const status=terminal?row.status:row.status==='suspended'?'suspended':progress.complete?'completed':'active';
   return dto((await db.query('UPDATE agents_platform.business_procedure_instances SET route=$3,receipts=$4,status=$5,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *',[scope.organizationId,id,route,JSON.stringify(receipts),status])).rows[0]);
  }));
 }
}
