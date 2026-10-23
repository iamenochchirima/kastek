import type {Pool, PoolClient} from "pg";
import type {OperationsAuditPage,OperationsSource,OperationsSnapshot,OperationsSignal} from "@kasitek-labs/contracts";
export interface OperationsMeasurement {key:string;group:string;unit:OperationsSignal["unit"];sql?:string;unsupported?:boolean;minimumSamples?:number;sampleSql?:string;}
/** A late pool acquisition is released instead of leaking a connection after the observer times out. */
export async function connectOperationsSource(pool:Pool,timeoutMs=2000):Promise<PoolClient>{
 let expired=false,timer:ReturnType<typeof setTimeout>|undefined;
 const connection=pool.connect().then(client=>{if(expired){client.release();throw Error('Source connection deadline exceeded');}return client;});
 const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error('Source connection deadline exceeded'));},timeoutMs);});
 try{return await Promise.race([connection,timeout]);}finally{if(timer)clearTimeout(timer);}
}
/** Each statement is isolated: an unavailable measurement cannot turn the others into healthy zeroes. */
export async function readOperationsSource(pool:Pool,source:OperationsSource,environment:NodeJS.ProcessEnv,measurements:OperationsMeasurement[]):Promise<OperationsSnapshot>{
 const result:OperationsSnapshot={contractVersion:"1",source,environment:environment.OPS_ENVIRONMENT??"development",observedAt:new Date().toISOString(),release:(environment.KASITEK_RELEASE_ID??environment.RELEASE_VERSION??environment.GIT_SHA??"development").replace(/[^a-zA-Z0-9._:-]/g,"_").slice(0,128),signals:[]};
 let db:PoolClient|undefined;
 try {db=await connectOperationsSource(pool);await db.query("BEGIN READ ONLY");await db.query("SET LOCAL statement_timeout='2s'");
 for(const measurement of measurements){
  const signal:OperationsSignal={key:measurement.key,group:measurement.group,unit:measurement.unit,status:measurement.unsupported?"unsupported":"unknown",value:null,coverage:"unknown",evidence:[]};
  if(measurement.sql){await db.query("SAVEPOINT measurement");try{
   const row=(await db.query(measurement.sql)).rows[0];
   if(row){signal.value=row.value===null?null:String(row.value);signal.denominator=row.denominator===undefined?undefined:String(row.denominator);signal.status=signal.value===null?"no_activity":"available";signal.coverage="complete";
    if(measurement.minimumSamples!==undefined&&BigInt(row.denominator??0)<BigInt(measurement.minimumSamples)){signal.status="no_activity";signal.value=null;signal.code="insufficient_samples";}
    if(measurement.sampleSql){const samples=(await db.query(measurement.sampleSql)).rows.slice(0,20);signal.evidence=samples.map(r=>({product:source,resourceType:String(r.resource_type),resourceId:String(r.resource_id),...(r.customer_id?{customerId:String(r.customer_id)}:{}),...(r.operation_id?{operationId:String(r.operation_id)}:{})}));}
    if(row.window_start)signal.windowStart=new Date(row.window_start).toISOString();if(row.window_end)signal.windowEnd=new Date(row.window_end).toISOString();
   }
  }catch{await db.query("ROLLBACK TO SAVEPOINT measurement");signal.status="unknown";signal.value=null;signal.coverage="unknown";signal.evidence=[];signal.code="measurement_unavailable";}await db.query("RELEASE SAVEPOINT measurement");}
  else if(!measurement.unsupported){signal.status="not_configured";signal.code="worker_inventory_not_configured";}
  result.signals.push(signal);
 }
 const inventory=(environment.OPS_EXPECTED_WORKERS??'').split(',').filter(Boolean).slice(0,50);
 if(!inventory.length)result.signals.push({key:'worker.inventory.age_seconds',group:'workers',unit:'seconds',status:'not_configured',value:null,coverage:'unknown',evidence:[],code:'worker_inventory_not_configured'});
 for(const entry of inventory){
  if(!/^[a-z][a-z0-9_]{0,40}@[a-zA-Z0-9_-]{1,64}$/.test(entry))continue;
  const [worker,instance]=entry.split('@');const signal:OperationsSignal={key:`worker.${worker}.${instance}.age_seconds`,group:'workers',unit:'seconds',status:'unknown',value:null,coverage:'unknown',evidence:[],expectedIntervalSeconds:30};
  await db.query('SAVEPOINT heartbeat');try{const row=(await db.query("SELECT GREATEST(0,floor(extract(epoch FROM now()-observed_at)))::text age FROM operations_worker_heartbeats WHERE worker=$1 AND instance=$2 AND environment=$3",[worker,instance,result.environment])).rows[0];if(row){signal.status='available';signal.value=row.age;signal.coverage='complete';}else signal.code='heartbeat_not_observed';}catch{await db.query('ROLLBACK TO SAVEPOINT heartbeat');signal.code='heartbeat_unavailable';}await db.query('RELEASE SAVEPOINT heartbeat');result.signals.push(signal);
 }
 await db.query("COMMIT");
 result.signals.push({key:"source.read_ready",group:"source",unit:"count",status:"available",value:"1",coverage:"complete",evidence:[]});
 }catch{if(db)await db.query("ROLLBACK").catch(()=>{});result.signals=measurements.map(m=>({key:m.key,group:m.group,unit:m.unit,status:m.unsupported?"unsupported":"unknown",value:null,coverage:"unknown",evidence:[],code:"source_read_unavailable"}));result.signals.push({key:"source.read_ready",group:"source",unit:"count",status:"available",value:"0",coverage:"complete",evidence:[],code:"source_read_unavailable"});}
 finally{db?.release();}return result;
}
export const publicationMeasurements:OperationsMeasurement[]=[
 {key:"publication.overdue_seconds",group:"publication",unit:"seconds",sql:`SELECT COALESCE(GREATEST(0,floor(extract(epoch FROM now()-min(CASE WHEN delivery_status='leased' THEN lease_expires_at ELSE next_attempt_at END))))::text,'0') value FROM public.analytics_outbox WHERE (delivery_status='pending' AND next_attempt_at<=now()) OR (delivery_status='leased' AND lease_expires_at<=now())`},
 {key:"publication.quarantined",group:"publication",unit:"count",sql:`SELECT count(*)::text value FROM public.analytics_outbox WHERE delivery_status='quarantined'`}
];
export function parseOperationsAuditQuery(query:Record<string,unknown>):{limit:number;cursor:string|null;actor:string|null;customer:string|null;resource:string|null;status:string|null;action:string|null}{
 const limit=Number(query.limit??50);if(!Number.isInteger(limit)||limit<1||limit>100)throw Error("Invalid audit page size");
 const field=(key:string)=>{const value=query[key];if(value===undefined||value===null||value==='')return null;if(typeof value!=="string"||value.length>256||/[\u0000-\u001f]/.test(value))throw Error("Invalid audit filter");return value;};
 return {limit,cursor:field("cursor"),actor:field("actorId"),customer:field("customerId"),resource:field("resourceId"),status:field("status"),action:field("action")};
}
/** SQL is product-owned and returns only normalized metadata columns, never reason or payload. */
export async function readOperationsAudit(pool:Pool,source:OperationsSource,environment:string,sql:string,query:Record<string,unknown>):Promise<OperationsAuditPage>{
 const q=parseOperationsAuditQuery(query),db=await pool.connect();try{await db.query("BEGIN READ ONLY");await db.query("SET LOCAL statement_timeout='2s'");
 const rows=(await db.query(`SELECT * FROM (${sql}) audit WHERE ($1::text IS NULL OR id<$1) AND ($2::text IS NULL OR actor_id=$2) AND ($3::text IS NULL OR customer_id=$3) AND ($4::text IS NULL OR action=$4) AND ($5::text IS NULL OR resource_id=$5) AND ($6::text IS NULL OR status=$6) ORDER BY id DESC LIMIT $7`,[q.cursor,q.actor,q.customer,q.action,q.resource,q.status,q.limit+1])).rows;
 await db.query("COMMIT");return {entries:rows.slice(0,q.limit).map(r=>({id:r.id,source,environment,occurredAt:new Date(r.occurred_at).toISOString(),actorId:r.actor_id,action:r.action,status:r.status,customerId:r.customer_id,resourceType:r.resource_type,resourceId:r.resource_id,operationId:r.operation_id,code:r.code})),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null};
 }catch(error){await db.query("ROLLBACK").catch(()=>{});throw error;}finally{db.release();}
}

const lastHeartbeat=new WeakMap<Pool,Map<string,number>>();
/** Called by the actual worker loop, never by an API observer or an unrelated process timer. */
export async function recordOperationsWorkerHeartbeat(pool:Pool,worker:string,environment:NodeJS.ProcessEnv=process.env):Promise<void>{
 if(environment.OPS_HEARTBEATS_ENABLED!=='1')return;
 const instance=environment.OPS_WORKER_INSTANCE;if(!instance||!/^[a-zA-Z0-9_-]{1,64}$/.test(instance)||!/^[a-z][a-z0-9_]{0,40}$/.test(worker))return;
 const previous=lastHeartbeat.get(pool)??new Map<string,number>();lastHeartbeat.set(pool,previous);const key=worker+'@'+instance,now=Date.now();if(now-(previous.get(key)??0)<30000)return;previous.set(key,now);
 try{await pool.query(`INSERT INTO operations_worker_heartbeats(worker,instance,environment,observed_at) VALUES($1,$2,$3,now()) ON CONFLICT(worker,instance,environment) DO UPDATE SET observed_at=excluded.observed_at`,[worker,instance,environment.OPS_ENVIRONMENT??'development']);previous.set(key,now);}catch{/* Missing instrumentation must not prevent the owning worker from running. */}
}
