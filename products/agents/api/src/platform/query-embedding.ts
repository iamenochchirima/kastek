import {writeExecutionObject} from "./execution-objects";
import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import type {PrivateObjectStore} from "./artifacts";
import {PlatformError,requestDigest} from "./contracts";
import {transaction} from "./database";
import {loadExecution,assertCurrentAuthority} from "./execution";
import {assertEmbeddingVector} from "./knowledge";
import type {DocumentRuntime,DocumentReceipt} from "./document-runtime";

type Runtime=Pick<DocumentRuntime,"start"|"status"|"result"|"destroy">;
export interface QueryEmbeddingRequest {taskId:string;operationId:string;profileRelease:string;query:string}
export interface QueryEmbeddingResult {vector:number[];receipt:DocumentReceipt}
export type QueryEmbeddingAuthority=(db:PoolClient,input:QueryEmbeddingRequest)=>Promise<{organizationId:string;deadlineAt:number}>;
const denied=(code:string)=>new PlatformError(code,409,"Knowledge search cannot continue");

export async function requireQueryAuthority(db:PoolClient,input:QueryEmbeddingRequest){
 const execution=await loadExecution(db,input.taskId,true);await assertCurrentAuthority(db,execution);
 if(execution.configuration.retrievalProfile.kind!=="hybrid-v1"||execution.configuration.retrievalProfile.embeddingRelease!==input.profileRelease)throw denied("EMBEDDING_PROFILE_UNAVAILABLE");
 const operation=(await db.query("SELECT * FROM agents_platform.operations WHERE id=$1 AND task_id=$2 FOR UPDATE",[input.operationId,input.taskId])).rows[0];
 if(!operation||operation.state!=="started"||!["tool","resource"].includes(operation.kind)||operation.name!=="knowledge.search")throw denied("QUERY_OPERATION_UNAVAILABLE");
 let argumentsValue:unknown;try{argumentsValue=operation.request?.tool==="knowledge.search"?JSON.parse(operation.request.arguments):operation.request;}catch{throw denied("QUERY_OPERATION_UNAVAILABLE");}
 if(!argumentsValue||typeof argumentsValue!=="object"||!("query" in argumentsValue)||typeof argumentsValue.query!=="string"||argumentsValue.query.trim()!==input.query.trim())throw denied("QUERY_OPERATION_CONFLICT");
 const deadlineAt=Math.min(new Date(execution.task.deadline_at).getTime(),new Date(operation.started_at).getTime()+operation.reserved_ms);
 if(deadlineAt<=Date.now())throw denied("QUERY_DEADLINE");return{organizationId:execution.task.organization_id,deadlineAt};
}

/** Runs only inside an already budgeted tool operation; allocation identity survives worker loss. */
export class QueryEmbeddingService {
 constructor(readonly pool:Pool,readonly objects:PrivateObjectStore,readonly runtime:Runtime,readonly authorize:QueryEmbeddingAuthority=requireQueryAuthority){}
 private async authority(db:PoolClient,input:QueryEmbeddingRequest){
  const initial=(await db.query("SELECT organization_id FROM agents_platform.tasks WHERE id=$1",[input.taskId])).rows[0];if(!initial)throw denied("TASK_NOT_FOUND");
  await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[initial.organization_id]);
  const scope=await this.authorize(db,input);if(scope.organizationId!==initial.organization_id||scope.deadlineAt<=Date.now())throw denied("QUERY_DEADLINE");return scope;
 }
 async embed(input:QueryEmbeddingRequest):Promise<QueryEmbeddingResult>{
  z.uuid().parse(input.taskId);z.string().min(1).max(256).parse(input.operationId);z.string().regex(/^document-processing-v1@[a-f0-9]{64}$/).parse(input.profileRelease);
  z.string().min(1).max(1024).refine(value=>!!value.trim()&&Buffer.byteLength(value)<=1024).parse(input.query);
  const digest=requestDigest({query:input.query,profileRelease:input.profileRelease});
  const allocation=await transaction(this.pool,async db=>{
   const scope=await this.authority(db,input);let row=(await db.query("SELECT * FROM agents_platform.query_embedding_allocations WHERE task_id=$1 AND operation_id=$2 FOR UPDATE",[input.taskId,input.operationId])).rows[0];
   if(row){if(row.input_digest!==digest||row.profile_release!==input.profileRelease)throw denied("QUERY_RESOURCE_CONFLICT");if(row.result_key)return row;if(row.state==="destroyed"||new Date(row.lease_expires_at).getTime()<=Date.now())throw denied("QUERY_RESOURCE_EXPIRED");return row;}
   const live=(await db.query(`SELECT (SELECT count(*) FROM agents_platform.document_allocations WHERE organization_id=$1 AND state<>'destroyed')+
    (SELECT count(*) FROM agents_platform.query_embedding_allocations WHERE organization_id=$1 AND state<>'destroyed') AS count`,[scope.organizationId])).rows[0];
   if(Number(live.count)>=2)throw new PlatformError("PROVIDER_BUSY",429,"Document processing capacity is busy");
   row=(await db.query(`INSERT INTO agents_platform.query_embedding_allocations(id,organization_id,task_id,operation_id,profile_release,input_digest,state,lease_expires_at)
    VALUES($1,$2,$3,$4,$5,$6,'admitted',$7) RETURNING *`,[randomUUID(),scope.organizationId,input.taskId,input.operationId,input.profileRelease,digest,new Date(Math.min(Date.now()+90000,scope.deadlineAt))])).rows[0];return row;
  });
  if(allocation.result_key)return this.readResult(allocation);
  await transaction(this.pool,async db=>{
   await this.authority(db,input);const row=(await db.query("SELECT * FROM agents_platform.query_embedding_allocations WHERE id=$1 FOR UPDATE",[allocation.id])).rows[0];
   if(row.result_key)return;if(row.state==="destroyed"||new Date(row.lease_expires_at).getTime()<=Date.now())throw denied("QUERY_RESOURCE_EXPIRED");
   await this.runtime.start({allocationId:row.id,jobId:input.taskId,profileRelease:input.profileRelease,input:{kind:"embed",mode:"query",texts:[input.query]}});
   await db.query("UPDATE agents_platform.query_embedding_allocations SET state='running',updated_at=now() WHERE id=$1",[row.id]);
  });
  while(Date.now()<new Date(allocation.lease_expires_at).getTime()){
   const cached=await this.cached(input,allocation.id);if(cached)return cached;const state=await this.runtime.status(allocation.id);
   if(state.state==="completed"||state.state==="failed"){
    let result;try{result=await this.runtime.result(allocation.id);}catch(error){const completed=await this.cached(input,allocation.id);if(completed)return completed;throw error;}
    if(!result){const completed=await this.cached(input,allocation.id);if(completed)return completed;}
    if(!result||result.receipt.allocationId!==allocation.id||result.receipt.jobId!==input.taskId||result.receipt.profileRelease!==input.profileRelease)throw denied("QUERY_RECEIPT_INVALID");
    if(!result.ok)throw denied(result.errorCode);if(result.result.kind!=="embed"||result.result.mode!=="query"||result.result.vectors.length!==1)throw denied("QUERY_RECEIPT_INVALID");
    const value:QueryEmbeddingResult={vector:result.result.vectors[0]!,receipt:result.receipt};assertEmbeddingVector(value.vector);
    const bytes=Buffer.from(JSON.stringify(value)),resultDigest=requestDigest(value),key=`knowledge-query/${allocation.organization_id}/${input.taskId}/${allocation.id}/${resultDigest}`;
    await writeExecutionObject(this.pool,this.objects,{taskId:input.taskId,operationId:input.operationId,key,bytes,contentType:"application/json"});
    await transaction(this.pool,async db=>{await this.authority(db,input);const row=(await db.query("SELECT * FROM agents_platform.query_embedding_allocations WHERE id=$1 FOR UPDATE",[allocation.id])).rows[0];
     if(row.result_digest){if(row.result_digest!==resultDigest)throw denied("QUERY_RECEIPT_INVALID");return;}
     if(row.state==="destroyed"||new Date(row.lease_expires_at).getTime()<=Date.now())throw denied("QUERY_RESOURCE_EXPIRED");
     await db.query("UPDATE agents_platform.query_embedding_allocations SET state='completed',result_key=$2,result_digest=$3,receipt=$4,updated_at=now() WHERE id=$1",[allocation.id,key,resultDigest,JSON.stringify(value.receipt)]);
    });
    await this.cleanup(allocation.id);return value;
   }
   if(!["prepared","running"].includes(state.state)){const completed=await this.cached(input,allocation.id);if(completed)return completed;throw denied("QUERY_RESOURCE_UNCERTAIN");}await new Promise(done=>setTimeout(done,50));
  }throw denied("QUERY_DEADLINE");
 }
 private async cached(input:QueryEmbeddingRequest,id:string):Promise<QueryEmbeddingResult|undefined>{
  const row=await transaction(this.pool,async db=>{await this.authority(db,input);return(await db.query("SELECT * FROM agents_platform.query_embedding_allocations WHERE id=$1 FOR SHARE",[id])).rows[0];});
  return row?.result_key?this.readResult(row):undefined;
 }
 private async readResult(row:Record<string,any>):Promise<QueryEmbeddingResult>{
  const bytes=await this.objects.get(row.result_key);if(bytes.length>65536)throw denied("QUERY_RECEIPT_INVALID");const result=JSON.parse(Buffer.from(bytes).toString("utf8")) as QueryEmbeddingResult;
  if(requestDigest(result)!==row.result_digest||result.receipt.allocationId!==row.id||result.receipt.profileRelease!==row.profile_release||result.receipt.jobId!==row.task_id)throw denied("QUERY_RECEIPT_INVALID");assertEmbeddingVector(result.vector);return result;
 }
 async cleanup(id:string):Promise<void>{await cleanupQueryEmbeddingAllocation(this.pool,this.runtime,id);}
 async reap():Promise<void>{await reapQueryEmbeddingResources(this.pool,this.runtime);}
}

export async function cleanupQueryEmbeddingAllocation(pool:Pool,runtime:Pick<DocumentRuntime,"destroy">,id:string):Promise<void>{
 const initial=(await pool.query("SELECT organization_id FROM agents_platform.query_embedding_allocations WHERE id=$1",[id])).rows[0];if(!initial)return;
 await transaction(pool,async db=>{await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[initial.organization_id]);const row=(await db.query("SELECT * FROM agents_platform.query_embedding_allocations WHERE id=$1 FOR UPDATE",[id])).rows[0];
  if(row.state==="destroyed")return;const state=await runtime.destroy(id);if(state.state!=="destroyed")throw denied("DOCUMENT_CLEANUP_PENDING");await db.query("UPDATE agents_platform.query_embedding_allocations SET state='destroyed',updated_at=now() WHERE id=$1",[id]);
 });
}

export async function reapQueryEmbeddingResources(pool:Pool,runtime:Pick<DocumentRuntime,"destroy">):Promise<void>{
 const rows=(await pool.query(`SELECT q.id FROM agents_platform.query_embedding_allocations q JOIN agents_platform.tasks t ON t.id=q.task_id
  JOIN agents_platform.tasks root ON root.id=t.root_task_id JOIN agents_platform.execution_grants g ON g.id=t.grant_id
  JOIN agents_platform.conversations c ON c.id=t.conversation_id LEFT JOIN agents_platform.operations o ON o.id=q.operation_id WHERE q.state<>'destroyed' AND
  (q.state='completed' OR q.lease_expires_at<=now() OR t.deadline_at<=now() OR g.revoked_at IS NOT NULL OR g.expires_at<=now() OR c.deleted_at IS NOT NULL
  OR root.state IN ('completed','failed','cancelled','uncertain','incomplete','refused','cancel_requested') OR t.state IN ('completed','failed','cancelled','uncertain','incomplete','refused','cancel_requested') OR o.state IS DISTINCT FROM 'started') LIMIT 20`)).rows;
 for(const row of rows)await cleanupQueryEmbeddingAllocation(pool,runtime,row.id);
}
