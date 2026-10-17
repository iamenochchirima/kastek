import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import type {PrivateObjectStore} from "./artifacts";
import {PlatformError} from "./contracts";
import {transaction} from "./database";
import {loadExecution,assertCurrentAuthority} from "./execution";
import {textDigest} from "./source-contracts";

interface ExecutionObjectWrite {taskId:string;operationId:string;key:string;bytes:Uint8Array;contentType:string}
const fail=(code:string)=>new PlatformError(code,409,"Private operation content is unavailable");
const leaseMs=30000;
/** The intent owns bytes before PUT. Only its row stays locked across storage I/O. */
export async function writeExecutionObject(pool:Pool,objects:PrivateObjectStore,input:ExecutionObjectWrite):Promise<void>{
 if(!input.bytes.byteLength||input.bytes.byteLength>10485760||!input.contentType||input.contentType.length>200||/[\r\n]/.test(input.contentType))throw fail("EXECUTION_OBJECT_LIMIT");
 const digest=textDigest(input.bytes);
 const intent=await transaction(pool,async db=>{
  const initial=await loadExecution(db,input.taskId);
  await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[initial.task.organization_id]);
  const execution=await loadExecution(db,input.taskId);await assertCurrentAuthority(db,execution);
  if(!(await db.query("SELECT 1 FROM agents_platform.operations WHERE id=$1 AND task_id=$2 AND state='started'",[input.operationId,input.taskId])).rowCount)throw fail("EXECUTION_OBJECT_SCOPE_DENIED");
  const prefixes=[`evidence/${execution.task.organization_id}/${execution.task.root_task_id}/`,`connected/${execution.task.organization_id}/${execution.task.root_task_id}/`,`knowledge-query/${execution.task.organization_id}/${input.taskId}/`];
  if(!prefixes.some(prefix=>input.key.startsWith(prefix))||input.key.includes("..")||input.key.length>1024)throw fail("EXECUTION_OBJECT_SCOPE_DENIED");
  const prior=(await db.query("SELECT * FROM agents_platform.execution_objects WHERE object_key=$1 FOR UPDATE",[input.key])).rows[0];
  if(prior){
   if(prior.organization_id!==execution.task.organization_id||prior.root_task_id!==execution.task.root_task_id||prior.content_digest!==digest||prior.bytes!==input.bytes.byteLength)throw fail("EXECUTION_OBJECT_CONFLICT");
   if(prior.state==='available')return prior;
   if(prior.state!=='writing'||prior.write_attempts>=3)throw fail("EXECUTION_OBJECT_UNCERTAIN");
   if(prior.write_error_at)return(await db.query("UPDATE agents_platform.execution_objects SET write_attempts=write_attempts+1,write_error_at=NULL,write_lease_until=$2,updated_at=now() WHERE id=$1 RETURNING *",[prior.id,new Date(Date.now()+leaseMs)])).rows[0];
   return prior;
  }
  return(await db.query(`INSERT INTO agents_platform.execution_objects(id,organization_id,root_task_id,task_id,operation_id,object_key,content_digest,bytes,state,write_lease_until)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,'writing',$9) RETURNING *`,[randomUUID(),execution.task.organization_id,execution.task.root_task_id,input.taskId,input.operationId,input.key,digest,input.bytes.byteLength,new Date(Date.now()+leaseMs)])).rows[0];
 });
 if(intent.state==='available')return;
 let failure:unknown;
 await transaction(pool,async db=>{
  const row=(await db.query("SELECT * FROM agents_platform.execution_objects WHERE id=$1 FOR UPDATE",[intent.id])).rows[0];
  if(row.state==='available')return;
  if(row.state!=='writing'||new Date(row.write_lease_until).getTime()<=Date.now())throw fail("EXECUTION_OBJECT_UNCERTAIN");
  const task=(await db.query("SELECT state,deadline_at FROM agents_platform.tasks WHERE id=$1",[input.taskId])).rows[0];
  if(!task||['cancel_requested','completed','incomplete','refused','failed','cancelled','uncertain'].includes(task.state)||new Date(task.deadline_at).getTime()<=Date.now())throw fail("TASK_CANCELLED");
  try{await objects.put(input.key,input.bytes,input.contentType);await db.query("UPDATE agents_platform.execution_objects SET state='available',put_ack_at=now(),updated_at=now() WHERE id=$1",[row.id]);}
  catch(error){failure=error;await db.query("UPDATE agents_platform.execution_objects SET write_error_at=now(),updated_at=now() WHERE id=$1",[row.id]);}
 });
 if(failure)throw failure;
}

/** Retain linked receipts; clean abandoned private writes after their owning work settles. */
export async function reapExecutionObjects(pool:Pool,objects:PrivateObjectStore,now=new Date()):Promise<void>{
 const candidates=(await pool.query(`SELECT o.id FROM agents_platform.execution_objects o JOIN agents_platform.tasks t ON t.id=o.task_id
  JOIN agents_platform.operations p ON p.id=o.operation_id WHERE
  (o.state IN ('delete_pending','deleted') AND coalesce(o.next_cleanup_at,o.created_at)<=$1) OR
  (o.write_lease_until<=$1 AND p.state<>'started' AND t.state IN ('completed','incomplete','refused','failed','cancelled','uncertain')
   AND NOT EXISTS(SELECT 1 FROM agents_platform.evidence_contents c WHERE c.object_key=o.object_key)
   AND NOT EXISTS(SELECT 1 FROM agents_platform.connected_response_bodies c WHERE c.object_key=o.object_key)
   AND NOT EXISTS(SELECT 1 FROM agents_platform.connected_reads c WHERE c.body_key=o.object_key)
   AND NOT EXISTS(SELECT 1 FROM agents_platform.query_embedding_allocations q WHERE q.result_key=o.object_key))
  ORDER BY o.created_at LIMIT 20`,[now])).rows;
 for(const candidate of candidates)await transaction(pool,async db=>{
  const row=(await db.query("SELECT * FROM agents_platform.execution_objects WHERE id=$1 FOR UPDATE SKIP LOCKED",[candidate.id])).rows[0];if(!row||new Date(row.write_lease_until).getTime()>now.getTime())return;
  const linked=(await db.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM agents_platform.evidence_contents WHERE object_key=$1)
   OR EXISTS(SELECT 1 FROM agents_platform.connected_response_bodies WHERE object_key=$1)
   OR EXISTS(SELECT 1 FROM agents_platform.connected_reads WHERE body_key=$1)
   OR EXISTS(SELECT 1 FROM agents_platform.query_embedding_allocations WHERE result_key=$1)`,[row.object_key])).rowCount;
  if(linked)return;
  await db.query("UPDATE agents_platform.execution_objects SET state='delete_pending',updated_at=now() WHERE id=$1",[row.id]);
  await objects.delete(row.object_key);
  await db.query("UPDATE agents_platform.execution_objects SET state='deleted',delete_ack_at=$2,next_cleanup_at=$3,updated_at=now() WHERE id=$1",[row.id,now,new Date(now.getTime()+60000)]);
 });
}
