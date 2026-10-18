import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import {PlatformError,canonicalJson} from "../../contracts/contracts";
import {transaction} from "../../infrastructure/database";
import {assertCurrentAuthority} from "../context/evidence-policy";
import {loadExecution} from "../lifecycle/state";

export const capacityPolicySchema=z.object({
 maxQueued:z.number().int().min(1).max(100000).default(1000),
 maxWaitMs:z.number().int().min(1000).max(900000).default(120000),
 grantLeaseMs:z.number().int().min(1000).max(120000).default(30000),
});
const bucketSchema=z.object({key:z.string().min(1).max(256),limit:z.number().int().min(1).max(100000)});
export interface CapacityRequest {id:string;taskId:string;workload:"interactive"|"background"|"ingestion"|"sandbox"|"evaluation";buckets:{key:string;limit:number}[]}
export type CapacityDecision={state:"granted";requestId:string;generation:number}|{state:"waiting";requestId:string;generation:number;deadline:string};
export type CapacityPolicy=z.infer<typeof capacityPolicySchema>;
async function lockBuckets(db:PoolClient,keys:string[]){
 for(const key of [...keys].sort())await db.query("SELECT key FROM agents_platform.capacity_buckets WHERE key=$1 FOR UPDATE",[key]);
}
async function grantIfAvailable(db:PoolClient,row:any,leaseMs:number,publish=true):Promise<boolean>{
 await lockBuckets(db,row.bucket_keys);
 const blocked=await db.query(`SELECT b.key FROM agents_platform.capacity_buckets b WHERE b.key=ANY($1::text[])
 AND (SELECT count(*) FROM agents_platform.capacity_holds h WHERE h.bucket_key=b.key)>=b.max_active`,[row.bucket_keys]);
 if(blocked.rowCount)return false;
 // FIFO within each shared bucket, with age promotion so background work cannot starve.
 const older=await db.query(`SELECT 1 FROM agents_platform.capacity_requests q WHERE q.state='waiting' AND q.id<>$1 AND q.bucket_keys && $2::text[]
 AND (q.created_at+CASE WHEN q.workload='interactive' THEN interval '0 seconds' ELSE interval '5 seconds' END,q.id)
 <($3::timestamptz+CASE WHEN $4='interactive' THEN interval '0 seconds' ELSE interval '5 seconds' END,$1) LIMIT 1`,[row.id,row.bucket_keys,row.created_at,row.workload]);
 if(older.rowCount)return false;
 await db.query(`INSERT INTO agents_platform.capacity_holds(request_id,bucket_key,generation) SELECT $1,unnest($2::text[]),$3 ON CONFLICT DO NOTHING`,[row.id,row.bucket_keys,row.generation]);
 await db.query(`UPDATE agents_platform.capacity_requests SET state='granted',granted_at=now(),lease_until=now()+$2*interval '1 millisecond' WHERE id=$1`,[row.id,leaseMs]);
 if(publish)await notify(db,row);return true;
}
async function notify(db:PoolClient,row:any){await db.query(`INSERT INTO agents_platform.capacity_notifications(request_id,generation,task_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[row.id,row.generation,row.task_id]);}
/** Call after current authority checks. A waiting return must commit, never throw/rollback. */
export async function requestCapacity(db:PoolClient,input:CapacityRequest,options:Partial<CapacityPolicy>={}):Promise<CapacityDecision>{
 const policy=capacityPolicySchema.parse(options),buckets=z.array(bucketSchema).min(1).max(8).parse(input.buckets).sort((a,b)=>a.key.localeCompare(b.key));
 if(!input.id||input.id.length>512||new Set(buckets.map(b=>b.key)).size!==buckets.length)throw new PlatformError("CAPACITY_REQUEST_INVALID",400,"Invalid capacity request");
 for(const bucket of buckets)await db.query(`INSERT INTO agents_platform.capacity_buckets(key,max_active) VALUES($1,$2) ON CONFLICT(key) DO NOTHING`,[bucket.key,bucket.limit]);
 // Bucket limits are operator-owned; a request cannot silently rewrite another replica's policy.
 for(const bucket of buckets){const actual=(await db.query("SELECT max_active FROM agents_platform.capacity_buckets WHERE key=$1",[bucket.key])).rows[0];if(actual.max_active!==bucket.limit)throw new PlatformError("CAPACITY_POLICY_CONFLICT",409,"Capacity policy differs between replicas");}
 await db.query(`INSERT INTO agents_platform.capacity_requests(id,task_id,bucket_keys,workload,state,deadline_at)
 VALUES($1,$2,$3,$4,'waiting',least(now()+$5*interval '1 millisecond',(SELECT deadline_at FROM agents_platform.tasks WHERE id=$2))) ON CONFLICT DO NOTHING`,[input.id,input.taskId,buckets.map(b=>b.key),input.workload,policy.maxWaitMs]);
 const row=(await db.query("SELECT * FROM agents_platform.capacity_requests WHERE id=$1 FOR UPDATE",[input.id])).rows[0];
 if(!row||row.task_id!==input.taskId||canonicalJson(row.bucket_keys)!==canonicalJson(buckets.map(b=>b.key))||row.workload!==input.workload)throw new PlatformError("CAPACITY_REQUEST_CONFLICT",409,"Capacity request identity conflict");
 if(['released','rejected','uncertain'].includes(row.state))throw new PlatformError(row.error_code??"CAPACITY_REQUEST_FINISHED",409,"Capacity request is unavailable");
 if(row.state==='granted'&&row.lease_until.getTime()<=Date.now()){
  await lockBuckets(db,row.bucket_keys);await db.query('DELETE FROM agents_platform.capacity_holds WHERE request_id=$1',[row.id]);
  await db.query("UPDATE agents_platform.capacity_requests SET state='waiting',generation=generation+1,lease_until=NULL WHERE id=$1",[row.id]);row.generation++;row.state='waiting';
 }
 if(row.state==='active'||row.state==='granted')return {state:'granted',requestId:row.id,generation:row.generation};
 await lockBuckets(db,row.bucket_keys);
 const queued=await db.query(`SELECT count(*)::int AS n FROM agents_platform.capacity_requests WHERE state='waiting' AND bucket_keys && $1::text[]`,[row.bucket_keys]);
 if(queued.rows[0].n>policy.maxQueued)throw new PlatformError("CAPACITY_QUEUE_FULL",429,"Capacity queue is full; retry after 5 seconds");
 if(await grantIfAvailable(db,row,policy.grantLeaseMs,false))return{state:'granted',requestId:row.id,generation:row.generation};
 return{state:'waiting',requestId:row.id,generation:row.generation,deadline:row.deadline_at.toISOString()};
}
/** Fences the transition immediately before external I/O inside operation admission. */
export async function activateCapacity(db:PoolClient,requestId:string,generation:number):Promise<void>{
 const result=await db.query(`UPDATE agents_platform.capacity_requests SET state='active',lease_until=NULL
 WHERE id=$1 AND generation=$2 AND (state='active' OR state='granted' AND lease_until>now()) RETURNING id`,[requestId,generation]);
 if(!result.rowCount)throw new PlatformError("CAPACITY_LEASE_LOST",409,"Execution capacity changed");
}
/** Unconfirmed external calls retain holds. Only explicit effect reconciliation may release them. */
export async function releaseCapacity(db:PoolClient,requestId:string,outcome:"completed"|"failed"|"uncertain",reconciled=false):Promise<void>{
 const row=(await db.query("SELECT * FROM agents_platform.capacity_requests WHERE id=$1 FOR UPDATE",[requestId])).rows[0];if(!row||row.state==='released')return;
 await lockBuckets(db,row.bucket_keys);
 if(outcome==='uncertain'&&!reconciled){await db.query("UPDATE agents_platform.capacity_requests SET state='uncertain',lease_until=NULL WHERE id=$1",[requestId]);return;}
 await db.query("DELETE FROM agents_platform.capacity_holds WHERE request_id=$1",[requestId]);
 await db.query("UPDATE agents_platform.capacity_requests SET state='released',finished_at=now(),lease_until=NULL WHERE id=$1",[requestId]);
 // Transactional wakeup hint; polling the durable queue is recovery, never a worker capacity spin.
 await db.query("SELECT pg_notify('agents_capacity_ready','')");
}
export async function advanceCapacity(pool:Pool,options:Partial<CapacityPolicy>={},limit=64):Promise<void>{
 const policy=capacityPolicySchema.parse(options);if(!Number.isInteger(limit)||limit<1||limit>256)throw Error("Invalid capacity sweep bound");
 const candidates=await transaction(pool,async db=>{
  const tenants=(await db.query(`SELECT st.organization_id FROM agents_platform.scheduling_tenants st WHERE EXISTS(
   SELECT 1 FROM agents_platform.capacity_requests q JOIN agents_platform.tasks t ON t.id=q.task_id
   WHERE t.organization_id=st.organization_id AND (q.state='waiting' OR q.state='granted' AND q.lease_until<=now()))
   ORDER BY st.last_capacity_at,st.organization_id FOR UPDATE OF st SKIP LOCKED LIMIT $1`,[limit])).rows;
  if(!tenants.length)return [];
  const ids=tenants.map(t=>t.organization_id);
  await db.query('UPDATE agents_platform.scheduling_tenants SET last_capacity_at=now() WHERE organization_id=ANY($1::uuid[])',[ids]);
  return (await db.query(`WITH due AS (SELECT q.id,q.task_id,q.created_at,t.organization_id,row_number() OVER(PARTITION BY t.organization_id ORDER BY q.created_at,q.id) AS rank
   FROM agents_platform.capacity_requests q JOIN agents_platform.tasks t ON t.id=q.task_id WHERE t.organization_id=ANY($1::uuid[])
   AND (q.state='waiting' OR q.state='granted' AND q.lease_until<=now())) SELECT id,task_id FROM due ORDER BY rank,created_at,id LIMIT $2`,[ids,limit])).rows;
 });
 for(const candidate of candidates){
  await transaction(pool,async db=>{
   let errorCode:string|undefined;
   try{const execution=await loadExecution(db,candidate.task_id);await assertCurrentAuthority(db,execution);}
   catch(error){if(!(error instanceof PlatformError))throw error;errorCode=error.code;}
   const row=(await db.query(`SELECT * FROM agents_platform.capacity_requests WHERE id=$1 AND (state='waiting' OR state='granted' AND lease_until<=now()) FOR UPDATE SKIP LOCKED`,[candidate.id])).rows[0];if(!row)return;
   if(row.state==='granted'){
    await lockBuckets(db,row.bucket_keys);await db.query("DELETE FROM agents_platform.capacity_holds WHERE request_id=$1",[row.id]);
    await db.query("UPDATE agents_platform.capacity_requests SET state='waiting',generation=generation+1,lease_until=NULL WHERE id=$1",[row.id]);row.generation++;row.state='waiting';
   }
   if(row.deadline_at.getTime()<=Date.now())errorCode='CAPACITY_WAIT_EXPIRED';
   if(errorCode){await db.query("UPDATE agents_platform.capacity_requests SET state='rejected',error_code=$2,finished_at=now() WHERE id=$1",[row.id,errorCode]);await notify(db,row);return true;}
   return grantIfAvailable(db,row,policy.grantLeaseMs);
  });
 }
}
/** Stops queued/provisional work only; active and uncertain calls require settlement. */
export async function stopTaskCapacity(db:PoolClient,taskId:string,errorCode='TASK_STOPPED'):Promise<void>{
 const rows=(await db.query(`SELECT * FROM agents_platform.capacity_requests WHERE task_id=$1 AND state IN ('waiting','granted') ORDER BY id FOR UPDATE`,[taskId])).rows;
 for(const row of rows){await lockBuckets(db,row.bucket_keys);await db.query('DELETE FROM agents_platform.capacity_holds WHERE request_id=$1',[row.id]);
  await db.query("UPDATE agents_platform.capacity_requests SET state='rejected',error_code=$2,finished_at=now(),lease_until=NULL WHERE id=$1",[row.id,errorCode]);await notify(db,row);}
 if(rows.length)await db.query("SELECT pg_notify('agents_capacity_ready','')");
}
