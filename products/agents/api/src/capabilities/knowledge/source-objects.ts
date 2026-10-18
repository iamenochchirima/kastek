import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { PlatformError } from "../../contracts/contracts";
import { textDigest } from "../../contracts/source-contracts";
import { transaction } from "../../infrastructure/database";
import { PrivateObjectStore } from "../../infrastructure/object-store";

export interface SourceObjectWrite {jobId:string;key:string;bytes:Uint8Array;contentType:string;kind:"raw"|"stage"|"text"}
const fail=(code:string)=>new PlatformError(code,409,"Source content cannot be stored");
const leaseMs=30000,replayMs=7*86400000+900000;

async function current(db:PoolClient,jobId:string,lock=false){
 const first=(await db.query("SELECT organization_id FROM agents_platform.ingestion_jobs WHERE id=$1",[jobId])).rows[0];if(!first)throw fail("SOURCE_NOT_FOUND");
 if(lock)await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[first.organization_id]);
 const job=(await db.query(`SELECT j.*,s.state AS source_state,s.generation AS source_generation,
  EXISTS(SELECT 1 FROM agents_platform.memberships m WHERE m.organization_id=j.organization_id AND m.account_id=j.importer_account_id AND m.revoked_at IS NULL) AS member_active
  FROM agents_platform.ingestion_jobs j JOIN agents_platform.sources s ON s.id=j.source_id WHERE j.id=$1 ${lock?"FOR UPDATE OF j,s":""}`,[jobId])).rows[0];return job;
}
function eligible(job:Record<string,any>):boolean{return job.member_active&&job.source_state==="active"&&job.source_generation===job.accepted_generation&&!["cancelled","failed"].includes(job.state)&&(job.state==="ready"||new Date(job.deadline).getTime()>Date.now());}
function assertKey(input:SourceObjectWrite,job:Record<string,any>,digest:string){
 if(input.kind==="raw"){if(input.key!==job.raw_key||job.raw_digest&&job.raw_digest!==digest)throw fail("SOURCE_OBJECT_CONFLICT");}
 else if(input.kind==="text"){if(input.key!==`knowledge/${job.organization_id}/${job.source_id}/${job.revision_id}/${digest}`)throw fail("SOURCE_OBJECT_CONFLICT");}
 else if(!new RegExp(`^knowledge/${job.organization_id}/${job.id}/stages/[a-f0-9-]{36}/${digest}$`).test(input.key))throw fail("SOURCE_OBJECT_CONFLICT");
}

/** All network calls hold only their intent row, so cancellation never waits for storage. */
export async function writeSourceObject(pool:Pool,objects:PrivateObjectStore,input:SourceObjectWrite):Promise<void>{
 const limit=input.kind==="raw"?10485760:input.kind==="stage"?8388608:1048576;
 if(!input.bytes.byteLength||input.bytes.byteLength>limit||!input.contentType||input.contentType.length>200||/[\r\n]/.test(input.contentType))throw fail("SOURCE_OBJECT_LIMIT");
 const digest=textDigest(input.bytes);let token=randomUUID();
 let intent:Record<string,any>;
 try{intent=await transaction(pool,async db=>{
  const job=await current(db,input.jobId,true);if(!eligible(job))throw fail("INGESTION_INVALIDATED");assertKey(input,job,digest);
  const existing=(await db.query("SELECT * FROM agents_platform.source_objects WHERE object_key=$1 FOR UPDATE",[input.key])).rows[0];
  if(existing){
   if(existing.job_id!==input.jobId||existing.content_digest!==digest||existing.bytes!==input.bytes.byteLength||existing.kind!==input.kind)throw fail("SOURCE_OBJECT_CONFLICT");
   if(existing.state==="available")return existing;
   if(["delete_pending","deleted"].includes(existing.state))throw fail("SOURCE_WRITE_UNCERTAIN");
   if(existing.put_ack_at||!existing.write_error_at&&new Date(existing.write_lease_until).getTime()>Date.now())return existing;
   if(existing.write_attempts>=3)throw fail("SOURCE_WRITE_UNCERTAIN");
   return(await db.query("UPDATE agents_platform.source_objects SET write_token=$2,write_attempts=write_attempts+1,write_lease_until=$3,put_ack_at=NULL,write_error_at=NULL,updated_at=now() WHERE id=$1 RETURNING *",[existing.id,token,new Date(Date.now()+leaseMs)])).rows[0];
  }
  if(job.state==="ready")throw fail(input.kind==="text"?"EXTRACTION_INTEGRITY":"INGESTION_ALREADY_SEALED");
  return(await db.query(`INSERT INTO agents_platform.source_objects(id,organization_id,job_id,object_key,kind,content_digest,bytes,state,write_token,write_attempts,write_lease_until)
   VALUES($1,$2,$3,$4,$5,$6,$7,'writing',$8,1,$9) RETURNING *`,[randomUUID(),job.organization_id,input.jobId,input.key,input.kind,digest,input.bytes.byteLength,token,new Date(Date.now()+leaseMs)])).rows[0];
 });}catch(error){if((error as {code?:string}).code==="55P03")throw fail("SOURCE_WRITE_BUSY");throw error;}
 if(intent.state==="available")return;
 token=intent.write_token;
 let writeError:unknown;
 await transaction(pool,async db=>{
  const row=(await db.query("SELECT * FROM agents_platform.source_objects WHERE id=$1 FOR UPDATE",[intent.id])).rows[0];
  if(row.state==="available")return;
  if(row.write_token!==token||row.state!=="writing"||new Date(row.write_lease_until).getTime()<=Date.now())throw fail("SOURCE_WRITE_UNCERTAIN");
  if(row.put_ack_at)return;
  const job=await current(db,input.jobId);if(!eligible(job)){await db.query("UPDATE agents_platform.source_objects SET state='delete_pending',next_cleanup_at=now(),updated_at=now() WHERE id=$1",[row.id]);writeError=fail("INGESTION_INVALIDATED");return;}
  try{await objects.put(input.key,input.bytes,input.contentType);await db.query("UPDATE agents_platform.source_objects SET put_ack_at=now(),updated_at=now() WHERE id=$1",[row.id]);}
  catch(error){writeError=error;await db.query("UPDATE agents_platform.source_objects SET write_error_at=now(),updated_at=now() WHERE id=$1",[row.id]);}
 });
 if(writeError)throw writeError;
 await transaction(pool,async db=>{
  const job=await current(db,input.jobId,true);const row=(await db.query("SELECT * FROM agents_platform.source_objects WHERE id=$1 FOR UPDATE",[intent.id])).rows[0];
  if(row.state==="available")return;
  if(row.write_token!==token||row.state!=="writing"||!eligible(job)){
   await db.query("UPDATE agents_platform.source_objects SET state='delete_pending',next_cleanup_at=now(),updated_at=now() WHERE id=$1",[row.id]);writeError=fail("INGESTION_INVALIDATED");return;
  }
  await db.query("UPDATE agents_platform.source_objects SET state='available',updated_at=now() WHERE id=$1",[row.id]);
 });
 if(writeError)throw writeError;
}

export async function reapSourceObjects(pool:Pool,objects:PrivateObjectStore,options:{limit?:number;now?:Date}={}):Promise<void>{
 const now=options.now??new Date(),limit=options.limit??20;if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw fail("SOURCE_OBJECT_LIMIT");
 const rows=(await pool.query(`SELECT o.id FROM agents_platform.source_objects o JOIN agents_platform.ingestion_jobs j ON j.id=o.job_id
  JOIN agents_platform.sources s ON s.id=j.source_id WHERE
  ((o.state IN ('delete_pending','deleted') AND (o.next_cleanup_at IS NULL OR o.next_cleanup_at<=$1)) OR
   (o.state='writing' AND (o.write_lease_until<=$1 OR o.put_ack_at IS NOT NULL AND
    (s.state='withdrawn' OR j.state IN ('failed','cancelled') OR j.deadline<=$1 OR j.accepted_generation<>s.generation))) OR
   (o.state='available' AND (s.state='withdrawn' OR j.state IN ('failed','cancelled') OR
    (j.state='ready' AND o.kind<>'stage' AND NOT EXISTS(SELECT 1 FROM agents_platform.source_revisions r WHERE r.id=j.revision_id AND (r.raw_key=o.object_key OR r.text_key=o.object_key))) OR
    (o.kind='stage' AND greatest(o.created_at,j.updated_at)<=$1::timestamptz-interval '7 days 15 minutes') OR
    (j.state<>'ready' AND (j.deadline<=$1 OR j.accepted_generation<>s.generation OR NOT EXISTS(SELECT 1 FROM agents_platform.memberships m WHERE m.organization_id=j.organization_id AND m.account_id=j.importer_account_id AND m.revoked_at IS NULL))))))
  ORDER BY coalesce(o.next_cleanup_at,o.created_at),o.id LIMIT $2`,[now,limit])).rows;
 for(const candidate of rows)await transaction(pool,async db=>{
  const row=(await db.query("SELECT * FROM agents_platform.source_objects WHERE id=$1 FOR UPDATE SKIP LOCKED",[candidate.id])).rows[0];if(!row)return;
  if(!row.put_ack_at&&new Date(row.write_lease_until).getTime()>now.getTime())return;
  const job=await current(db,row.job_id);
  const sealed=(await db.query("SELECT 1 FROM agents_platform.source_revisions WHERE source_id=$1 AND id=$2 AND (raw_key=$3 OR text_key=$3)",[job.source_id,job.revision_id,row.object_key])).rowCount;
  if(row.state==="available"&&row.kind!=="stage"&&job.source_state==="active"&&sealed)return;
  // Keep seven days after job settlement plus its wall-time/acknowledgment margin.
  if(row.state==="available"&&row.kind==="stage"&&eligible(job)&&Math.max(new Date(row.created_at).getTime(),new Date(job.updated_at).getTime())+replayMs>now.getTime())return;
  await db.query("UPDATE agents_platform.source_objects SET state='delete_pending',updated_at=now() WHERE id=$1",[row.id]);
  await objects.delete(row.object_key);
  await db.query("UPDATE agents_platform.source_objects SET state='deleted',delete_ack_at=$2,next_cleanup_at=$3,updated_at=now() WHERE id=$1",[row.id,now,new Date(now.getTime()+60000)]);
 });
}
