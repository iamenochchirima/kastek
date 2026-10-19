import {execFile} from 'node:child_process';
import type {Pool} from 'pg';

/** Fixture-only failure metadata; SQL arguments, details and messages are never emitted. */
export function observeFixtureDatabaseErrors(pool:Pool){
 const seen=new WeakSet<object>();
 function report(error:any,text:unknown){
  if(!error||typeof error!=='object'||seen.has(error))return;seen.add(error);
  const sql=typeof text==='string'?text:typeof (text as any)?.text==='string'?(text as any).text:'';
  const boundary=['capacity_','execution_roots','organizations','actions','task_events','evidence','usage_'].find(part=>sql.includes(part))??'other';
  const safe=(value:unknown)=>typeof value==='string'&&/^[a-zA-Z0-9_]{1,128}$/.test(value)?value:undefined;
  const message=String(error.message),code=typeof error.code==='string'&&/^[0-9A-Z]{5}$/.test(error.code)?error.code:/trying to connect/i.test(message)?'POOL_ACQUIRE_TIMEOUT':/query read timeout/i.test(message)?'QUERY_READ_TIMEOUT':/timeout/i.test(message)?'TIMEOUT':'UNCLASSIFIED';
  process.stdout.write(JSON.stringify({fixtureDatabaseError:true,code,boundary,constraint:safe(error.constraint),table:safe(error.table),schema:safe(error.schema)})+'\n');
 }
 function wrap(target:any){
  const query=target.query;
  target.query=function(...args:any[]){
   const last=args.length-1;
   if(typeof args[last]==='function'){const callback=args[last];args[last]=function(error:unknown,...rest:unknown[]){if(error)report(error,args[0]);return callback(error,...rest);};}
   try{const result=query.apply(this,args);return result?.catch?result.catch((error:unknown)=>{report(error,args[0]);throw error;}):result;}
   catch(error){report(error,args[0]);throw error;}
  };
 }
 pool.on('connect',wrap);wrap(pool);
}

export function loadDiagnostics(pool:Pool,container:string,onRoots?:(rows:{state:string;n:number}[])=>void){
 const samples:unknown[]=[];let stopping=false,pending:Promise<void>|undefined;
 const tick=async()=>{
  const [waits,stats,roots,capacity,sharedPools]=await Promise.all([
   pool.query(`SELECT wait_event_type,wait_event,CASE WHEN query LIKE '%capacity_buckets%' THEN 'capacity-bucket'
    WHEN query LIKE '%execution_roots%' THEN 'execution-root' WHEN query LIKE '%organizations%' THEN 'organization'
    WHEN query LIKE '%task_outbox%' THEN 'dispatch' ELSE 'other' END AS boundary,count(*)::int n
    FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state<>'idle'
    GROUP BY wait_event_type,wait_event,boundary`),
   pool.query(`SELECT xact_commit,xact_rollback,blks_read,blks_hit,temp_bytes,deadlocks,numbackends FROM pg_stat_database WHERE datname=current_database()`),
   pool.query(`SELECT state,count(*)::int n FROM agents_platform.tasks WHERE parent_task_id IS NULL AND channel_binding IS NULL GROUP BY state`),
   pool.query(`SELECT state,count(*)::int n,min(created_at) oldest_created_at,min(granted_at) oldest_granted_at FROM agents_platform.capacity_requests GROUP BY state`),
   pool.query(`SELECT b.key,b.max_active,count(s.owner_request)::int held,b.max_active-count(s.owner_request)::int free,
    count(*) FILTER(WHERE q.state='active')::int active,count(*) FILTER(WHERE q.state='granted')::int provisional,count(*) FILTER(WHERE q.state='uncertain')::int uncertain
    FROM agents_platform.capacity_buckets b LEFT JOIN agents_platform.capacity_slots s ON s.bucket_key=b.key
    LEFT JOIN agents_platform.capacity_requests q ON q.id=s.owner_request WHERE b.key LIKE 'product:%' OR b.key LIKE 'provider:%'
    GROUP BY b.key,b.max_active ORDER BY b.key LIMIT 16`)
  ]);
  const runtime=await new Promise<unknown>(resolve=>execFile('docker',['stats','--no-stream','--format','{{json .}}',container],{encoding:'utf8',timeout:5000},(error,stdout)=>{try{resolve(error?{error:'Container sampling unavailable'}:JSON.parse(stdout));}catch{resolve({error:'Invalid container sample'});}}));
  onRoots?.(roots.rows);samples.push({at:new Date().toISOString(),roots:roots.rows,waits:waits.rows,database:stats.rows[0],capacity:capacity.rows,sharedPools:sharedPools.rows,runtime});
 };
 const timer=setInterval(()=>{if(!stopping&&!pending)pending=tick().catch(()=>{samples.push({error:'Diagnostic sampling failed'});}).finally(()=>{pending=undefined;});},2000);timer.unref();
 return{samples,async stop(){stopping=true;clearInterval(timer);await pending;},async plans(){
  const due=await pool.query(`EXPLAIN (FORMAT JSON) SELECT o.task_id FROM agents_platform.task_outbox o
   JOIN agents_platform.tasks t ON t.id=o.task_id WHERE o.dispatched_at IS NULL AND o.available_at<=now()
   AND (o.lease_until IS NULL OR o.lease_until<now()) ORDER BY o.created_at,o.task_id LIMIT 128`);
  const queue=await pool.query(`EXPLAIN (FORMAT JSON) SELECT id FROM agents_platform.capacity_requests WHERE state='waiting' AND bucket_keys && ARRAY['product:agents']::text[] LIMIT 64`);
  return{due:due.rows,queue:queue.rows};
 }};
}
