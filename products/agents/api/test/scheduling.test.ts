import {connectFixtureModel} from "./model-fixture";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {beforeAll,afterAll,afterEach,describe,it,expect} from "vitest";
import {defaultBusinessConfiguration,executionGrantSchema,type AdmissionAuthority} from "../src/contracts/contracts";
import {PlatformStore} from "../src/product/agents/store";
import {setupPlatformSchema} from "../src/composition/setup";
import {transaction} from "../src/infrastructure/database";
import {dispatchTasksOnce} from "../src/execution/lifecycle/dispatcher";
import {claimDispatchBatch} from "../src/execution/scheduling/dispatch-claims";
import {requestCapacity,activateCapacity,releaseCapacity,advanceCapacity} from "../src/execution/scheduling/capacity";
const dbUrl=process.env.AGENTS_TEST_DATABASE_URL;
(dbUrl?describe:describe.skip)("durable scheduling PostgreSQL",()=>{
 let admin:Pool,pool:Pool,store:PlatformStore;
 const dbname=`agents_schedule_${randomUUID().replaceAll('-','')}`;
 beforeAll(async()=>{admin=new Pool({connectionString:dbUrl});await admin.query(`CREATE DATABASE "${dbname}"`);const url=new URL(dbUrl!);url.pathname=`/${dbname}`;pool=new Pool({connectionString:url.href,max:8});await setupPlatformSchema(pool);store=new PlatformStore(pool);});
 afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS "${dbname}" WITH(FORCE)`);await admin.end();}});
 afterEach(async()=>{
  expect((await pool.query(`SELECT a.organization_id FROM agents_platform.tenant_admission a WHERE a.active_roots<>(SELECT count(*) FROM agents_platform.tasks t
   WHERE t.organization_id=a.organization_id AND t.parent_task_id IS NULL AND t.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain'))`)).rows).toEqual([]);
  expect((await pool.query(`SELECT b.key FROM agents_platform.capacity_buckets b WHERE b.max_active<(SELECT count(*) FROM agents_platform.capacity_holds h WHERE h.bucket_key=b.key)`)).rows).toEqual([]);
  expect((await pool.query(`SELECT s.bucket_key,s.slot FROM agents_platform.capacity_slots s LEFT JOIN agents_platform.capacity_holds h ON h.bucket_key=s.bucket_key AND h.slot=s.slot
   WHERE (s.owner_request IS NULL AND h.request_id IS NOT NULL) OR (s.owner_request IS NOT NULL AND (h.request_id IS NULL OR h.request_id<>s.owner_request OR h.generation<>s.generation))`)).rows).toEqual([]);
 });
 async function tasks(){
  const account=await store.ensureAccount({issuer:'http://localhost/test',subject:randomUUID(),email:'schedule@example.com',displayName:'Fixture'}),org=await store.createOrganization(account.id,'Scheduler fixture');
  await connectFixtureModel(pool,account.id,org.id);
  const config=defaultBusinessConfiguration();const agent=await store.createAgent({accountId:account.id,organizationId:org.id,name:'Fixture',configuration:config});
  const version=await store.createVersion({accountId:account.id,organizationId:org.id,agentId:agent.id,expectedRevision:1});
  const authority:AdmissionAuthority={product:'agents',organizationId:org.id,resourceId:agent.id,callerClientId:'agents-execution',principal:{kind:'human',issuer:account.issuer,subject:account.subject}};
  const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:['model.reply','knowledge.read'],maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,expiresAt:new Date(Date.now()+120000).toISOString(),revokedAt:null});await store.createGrant({accountId:account.id,grant});
  const results=await Promise.all([1,2].map(()=>store.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:'Hello'})));
  return results.map(r=>r.task);
 }
 it('claims bounded batches fairly without overlapping replica leases and recovers expired claims',async()=>{
  const a=await tasks(),b=await tasks();
  const serial=await claimDispatchBatch(pool,{batchSize:2});
  const tenants=(await pool.query('SELECT organization_id FROM agents_platform.tasks WHERE id=ANY($1::uuid[])',[serial.rows.map(r=>r.task_id)])).rows;expect(new Set(tenants.map(r=>r.organization_id)).size).toBe(2);
  await pool.query("UPDATE agents_platform.task_outbox SET lease_until=now()-interval '1 second' WHERE task_id=ANY($1::uuid[])",[serial.rows.map(row=>row.task_id)]);
  const [one,two]=await Promise.all([claimDispatchBatch(pool,{batchSize:2}),claimDispatchBatch(pool,{batchSize:2})]);
  const ids=[...one.rows,...two.rows].map(r=>r.task_id);expect(new Set(ids).size).toBe(4);
  expect(one.rows.length).toBe(2);expect(two.rows.length).toBe(2);
  await pool.query("UPDATE agents_platform.task_outbox SET lease_until=now()-interval '1 second' WHERE task_id=$1",[a[0]!.id]);
  const recovered=await claimDispatchBatch(pool,{batchSize:2});expect(recovered.rows.map(r=>r.task_id)).toContain(a[0]!.id);
  await pool.query('UPDATE agents_platform.task_outbox SET dispatched_at=now() WHERE task_id=ANY($1::uuid[])',[a.concat(b).map(t=>t.id)]);
 });
 it('serves a new tenant despite an older noisy tenant exceeding the initial candidate window',async()=>{
  const hot=await tasks();
  // Claim-query fixtures only: these rows do not execute or represent authorized load acceptance.
  await pool.query(`WITH fixtures AS MATERIALIZED (SELECT gen_random_uuid() id,n FROM generate_series(1,40) n)
   INSERT INTO agents_platform.tasks(id,product,organization_id,resource_id,caller_client_id,principal,version_id,grant_id,conversation_id,
   request_key,request_digest,input,turn_sequence,root_task_id,effective_composition,created_at)
   SELECT f.id,t.product,t.organization_id,t.resource_id,t.caller_client_id,t.principal,t.version_id,t.grant_id,t.conversation_id,
   f.id::text,t.request_digest,t.input,100+f.n,f.id,t.effective_composition,now()-interval '1 hour'
   FROM fixtures f CROSS JOIN agents_platform.tasks t WHERE t.id=$1`,[hot[0]!.id]);
  await pool.query(`INSERT INTO agents_platform.task_outbox(task_id,created_at) SELECT id,created_at FROM agents_platform.tasks
   WHERE organization_id=$1 AND id<>ALL($2::uuid[])`,[hot[0]!.organization_id,hot.map(t=>t.id)]);
  const quiet=await tasks(),batch=await claimDispatchBatch(pool,{batchSize:2});
  const owners=(await pool.query('SELECT organization_id FROM agents_platform.tasks WHERE id=ANY($1::uuid[])',[batch.rows.map(t=>t.task_id)])).rows.map(r=>r.organization_id);
  expect(owners).toContain(quiet[0]!.organization_id);expect(new Set(owners).size).toBe(2);
  await pool.query('UPDATE agents_platform.task_outbox SET dispatched_at=now() WHERE task_id IN(SELECT id FROM agents_platform.tasks WHERE organization_id=ANY($1::uuid[]))',[[hot[0]!.organization_id,quiet[0]!.organization_id]]);
 });
 it('does not claim tasks for an unavailable runtime release',async()=>{
  const rows=await tasks();
  const unavailable=await claimDispatchBatch(pool,{batchSize:2},['unavailable-test-release']);expect(unavailable.rows).toEqual([]);
  const pending=await pool.query('SELECT attempts FROM agents_platform.task_outbox WHERE task_id=ANY($1::uuid[])',[rows.map(t=>t.id)]);expect(pending.rows.every(row=>row.attempts===0)).toBe(true);
  await pool.query('UPDATE agents_platform.task_outbox SET dispatched_at=now() WHERE task_id=ANY($1::uuid[])',[rows.map(t=>t.id)]);
 });
 it('promotes fair tenant prefixes despite older waiters outside the batch without allowing direct barging',async()=>{
  const a=await tasks(),b=await tasks(),key=`fair-prefix:${randomUUID()}`,prefix=randomUUID();
  const request=(taskId:string,id:string)=>({id:`${prefix}:${id}`,taskId,workload:'interactive' as const,buckets:[{key,limit:8}]});
  const holders=Array.from({length:8},(_,n)=>request(a[0]!.id,`held-${n}`));
  for(const held of holders){const permit=await transaction(pool,db=>requestCapacity(db,held));expect(permit.state).toBe('granted');await transaction(pool,db=>activateCapacity(db,held.id,permit.generation));}
  const queued=[request(a[0]!.id,'a-1'),request(a[1]!.id,'a-2'),request(a[0]!.id,'a-3'),request(b[0]!.id,'b-1')];
  for(const item of queued)expect((await transaction(pool,db=>requestCapacity(db,item))).state).toBe('waiting');
  for(const held of holders)await transaction(pool,db=>releaseCapacity(db,held.id,'completed'));
  expect((await pool.query('SELECT count(*)::int n FROM agents_platform.capacity_slots WHERE bucket_key=$1 AND owner_request IS NULL',[key])).rows[0].n).toBe(8);
  const newcomer=request(b[1]!.id,'b-new');expect((await transaction(pool,db=>requestCapacity(db,newcomer))).state).toBe('waiting');
  await advanceCapacity(pool,{},2);
  const granted=(await pool.query("SELECT id FROM agents_platform.capacity_requests WHERE id=ANY($1::text[]) AND state='granted'",[queued.concat(newcomer).map(item=>item.id)])).rows.map(row=>row.id);
  expect(granted.sort()).toEqual([queued[0]!.id,queued[3]!.id].sort());
  await advanceCapacity(pool,{},2);await advanceCapacity(pool,{},2);
  const finished=(await pool.query('SELECT state FROM agents_platform.capacity_requests WHERE id=ANY($1::text[])',[queued.concat(newcomer).map(item=>item.id)])).rows;
  expect(finished).toHaveLength(5);expect(finished.every(row=>row.state==='granted')).toBe(true);
  expect((await pool.query('SELECT count(*)::int n FROM agents_platform.capacity_holds WHERE bucket_key=$1',[key])).rows[0].n).toBe(5);
 });
 it('uses the same workload age in bounded candidate selection and predecessor checks',async()=>{
  const [a,b]=await tasks(),key=`workload-age:${randomUUID()}`;
  const request=(taskId:string,workload:'interactive'|'background')=>({id:`age:${randomUUID()}`,taskId,workload,buckets:[{key,limit:1}]});
  const holder=request(a!.id,'interactive'),background=request(a!.id,'background'),interactive=request(b!.id,'interactive');
  await transaction(pool,db=>requestCapacity(db,holder));await transaction(pool,db=>activateCapacity(db,holder.id,1));
  expect((await transaction(pool,db=>requestCapacity(db,background))).state).toBe('waiting');
  expect((await transaction(pool,db=>requestCapacity(db,interactive))).state).toBe('waiting');
  await pool.query("UPDATE agents_platform.capacity_requests SET created_at=now()-interval '2 seconds' WHERE id=$1",[background.id]);
  await transaction(pool,db=>releaseCapacity(db,holder.id,'completed'));await advanceCapacity(pool,{},1);
  expect((await pool.query('SELECT state FROM agents_platform.capacity_requests WHERE id=$1',[interactive.id])).rows[0].state).toBe('granted');
  expect((await pool.query('SELECT state FROM agents_platform.capacity_requests WHERE id=$1',[background.id])).rows[0].state).toBe('waiting');
  await transaction(pool,db=>releaseCapacity(db,interactive.id,'completed'));
  await pool.query("UPDATE agents_platform.capacity_requests SET created_at=now()-interval '10 seconds' WHERE id=$1",[background.id]);
  const newer=request(b!.id,'interactive');expect((await transaction(pool,db=>requestCapacity(db,newer))).state).toBe('waiting');
  await advanceCapacity(pool,{},1);expect((await pool.query('SELECT state FROM agents_platform.capacity_requests WHERE id=$1',[background.id])).rows[0].state).toBe('granted');
  await transaction(pool,db=>releaseCapacity(db,background.id,'completed'));await advanceCapacity(pool,{},1);
  expect((await pool.query('SELECT state FROM agents_platform.capacity_requests WHERE id=$1',[newer.id])).rows[0].state).toBe('granted');
 });
 it('register/release has no lost wakeup and duplicate notifications never overlap permits',async()=>{
  const [a,b]=await tasks(),key=`test:${randomUUID()}`;
  const req=(taskId:string)=>({id:`op:${taskId}`,taskId,workload:'interactive' as const,buckets:[{key,limit:1}]});
  const first=await transaction(pool,db=>requestCapacity(db,req(a!.id)));expect(first.state).toBe('granted');
  await transaction(pool,db=>activateCapacity(db,first.requestId,first.generation));
  const [waiting]=await Promise.all([transaction(pool,db=>requestCapacity(db,req(b!.id))),transaction(pool,db=>releaseCapacity(db,first.requestId,'completed'))]);
  await Promise.all([advanceCapacity(pool),advanceCapacity(pool)]);
  const second=await transaction(pool,db=>requestCapacity(db,req(b!.id)));expect(second.state).toBe('granted');
  await Promise.all([transaction(pool,db=>activateCapacity(db,second.requestId,second.generation)),transaction(pool,db=>activateCapacity(db,second.requestId,second.generation))]);
  expect((await pool.query('SELECT count(*)::int AS n FROM agents_platform.capacity_holds WHERE bucket_key=$1',[key])).rows[0].n).toBe(1);
  expect((await pool.query('SELECT count(*)::int AS n FROM agents_platform.capacity_notifications WHERE request_id=$1 AND generation=$2',[second.requestId,second.generation])).rows[0].n).toBe(waiting.state==='waiting'?1:0);
  expect(['waiting','granted']).toContain(waiting.state);
 });
 it('retains failed durable notifications and safely republishes the same logical wakeup',async()=>{
  const [a,b]=await tasks(),request={id:`op:${randomUUID()}`,taskId:b!.id,workload:'interactive' as const,buckets:[{key:`notification:${randomUUID()}`,limit:1}]};
  const first={...request,id:`op:${randomUUID()}`,taskId:a!.id};const permit=await transaction(pool,db=>requestCapacity(db,first));
  await transaction(pool,db=>activateCapacity(db,permit.requestId,permit.generation));
  expect((await transaction(pool,db=>requestCapacity(db,request))).state).toBe('waiting');
  await transaction(pool,db=>releaseCapacity(db,first.id,'completed'));await advanceCapacity(pool);
  const keys:string[]=[];let fail=true;
  const fake:typeof fetch=async(url,options)=>{
   if(String(url).endsWith('/capacity')){keys.push(String((options?.headers as Record<string,string>)['idempotency-key']));return new Response('{}',{status:fail?503:200});}
   return Response.json({invocationId:'inv_scheduler_fixture'});
  };
  await dispatchTasksOnce(pool,{ingressUrl:'http://localhost',adminUrl:'http://localhost',fetch:fake});
  expect((await pool.query('SELECT dispatched_at FROM agents_platform.capacity_notifications WHERE request_id=$1',[request.id])).rows[0].dispatched_at).toBeNull();
  await pool.query('UPDATE agents_platform.capacity_notifications SET available_at=now() WHERE request_id=$1',[request.id]);fail=false;
  await dispatchTasksOnce(pool,{ingressUrl:'http://localhost',adminUrl:'http://localhost',fetch:fake});
  expect((await pool.query('SELECT dispatched_at FROM agents_platform.capacity_notifications WHERE request_id=$1',[request.id])).rows[0].dispatched_at).not.toBeNull();
  expect(keys.filter(key=>key===`capacity:${request.id}:1`)).toHaveLength(2);
 });
 it('does not hold a permit lock while waiting for conversation authority',async()=>{
  const [a,b]=await tasks(),key=`lock-order:${randomUUID()}`;
  const first={id:`op:${randomUUID()}`,taskId:a!.id,workload:'interactive' as const,buckets:[{key,limit:1}]},second={...first,id:`op:${randomUUID()}`,taskId:b!.id};
  const grant=await transaction(pool,db=>requestCapacity(db,first));await transaction(pool,db=>activateCapacity(db,grant.requestId,grant.generation));
  await transaction(pool,db=>requestCapacity(db,second));
  const blocker=await pool.connect(),probe=await pool.connect();let sweep:Promise<number>|undefined;
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM agents_platform.conversations WHERE id=$1 FOR UPDATE',[b!.conversation_id]);
   sweep=advanceCapacity(pool);let authorityBlocked=false;
   for(let n=0;n<100;n++){const waiting=await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT deleted_at FROM agents_platform.conversations%'");if(waiting.rowCount){authorityBlocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
   expect(authorityBlocked).toBe(true);
   await probe.query('BEGIN');await expect(probe.query('SELECT id FROM agents_platform.capacity_requests WHERE id=$1 FOR UPDATE NOWAIT',[second.id])).resolves.toMatchObject({rowCount:1});await probe.query('ROLLBACK');
  }finally{await probe.query('ROLLBACK');await blocker.query('ROLLBACK');probe.release();blocker.release();await sweep;}
 });
 it('never expires an active unconfirmed call, fences stale provisional generations and rejects expired waiters',async()=>{
  const [a,b]=await tasks(),key=`test:${randomUUID()}`,request={id:`op:${randomUUID()}`,taskId:a!.id,workload:'background' as const,buckets:[{key,limit:1}]};
  const first=await transaction(pool,db=>requestCapacity(db,request));await pool.query("UPDATE agents_platform.capacity_requests SET lease_until=now()-interval '1 second' WHERE id=$1",[request.id]);
  await advanceCapacity(pool);await expect(transaction(pool,db=>activateCapacity(db,request.id,first.generation))).rejects.toMatchObject({code:'CAPACITY_LEASE_LOST'});
  const waiting=await transaction(pool,db=>requestCapacity(db,request));expect(waiting.state).toBe('waiting');await advanceCapacity(pool);const current=await transaction(pool,db=>requestCapacity(db,request));await transaction(pool,db=>activateCapacity(db,request.id,current.generation));
  await transaction(pool,db=>releaseCapacity(db,request.id,'uncertain'));
  const second={...request,id:`op:${randomUUID()}`,taskId:b!.id};expect((await transaction(pool,db=>requestCapacity(db,second))).state).toBe('waiting');
  await pool.query("UPDATE agents_platform.capacity_requests SET deadline_at=now()-interval '1 second' WHERE id=$1",[second.id]);
  await expect(transaction(pool,db=>requestCapacity(db,second))).rejects.toMatchObject({code:'CAPACITY_WAIT_EXPIRED'});
  await advanceCapacity(pool);
  expect((await pool.query('SELECT state,error_code FROM agents_platform.capacity_requests WHERE id=$1',[second.id])).rows[0]).toMatchObject({state:'rejected',error_code:'CAPACITY_WAIT_EXPIRED'});
  expect((await pool.query('SELECT count(*)::int n FROM agents_platform.capacity_holds WHERE request_id=$1',[request.id])).rows[0].n).toBe(1);
  await transaction(pool,db=>releaseCapacity(db,request.id,'uncertain',true));expect((await pool.query('SELECT count(*)::int n FROM agents_platform.capacity_holds WHERE request_id=$1',[request.id])).rows[0].n).toBe(0);
 });
 it('grants different slots concurrently without a product-wide bucket mutex',async()=>{
  const [a,b]=await tasks(),key=`parallel:${randomUUID()}`,request=(taskId:string)=>({id:`op:${randomUUID()}`,taskId,workload:'interactive' as const,buckets:[{key,limit:4}]});
  const seed=request(a!.id);await transaction(pool,db=>requestCapacity(db,seed));await transaction(pool,db=>releaseCapacity(db,seed.id,'completed'));
  const first=await pool.connect();await first.query('BEGIN');
  try{await requestCapacity(first,request(a!.id));
   await expect(transaction(pool,async db=>{await db.query("SET LOCAL lock_timeout='500ms'");return requestCapacity(db,request(b!.id));})).resolves.toMatchObject({state:'granted'});
  }finally{await first.query('COMMIT');first.release();}
  expect((await pool.query('SELECT count(DISTINCT slot)::int n FROM agents_platform.capacity_holds WHERE bucket_key=$1',[key])).rows[0].n).toBe(2);
 });
 it('preserves hard ceilings under competing multi-bucket reservations and rolls back partial slots',async()=>{
  const [a,b]=await tasks(),key=`race:${randomUUID()}`,requests=Array.from({length:20},()=>({id:`op:${randomUUID()}`,taskId:a!.id,workload:'interactive' as const,buckets:[{key,limit:7}]}));
  const decisions=await Promise.all(requests.map(request=>transaction(pool,db=>requestCapacity(db,request))));expect(decisions.filter(decision=>decision.state==='granted')).toHaveLength(7);
  expect((await pool.query('SELECT count(*)::int n FROM agents_platform.capacity_holds WHERE bucket_key=$1',[key])).rows[0].n).toBe(7);
  const partial=`partial:${randomUUID()}`,blocked={id:`op:${randomUUID()}`,taskId:b!.id,workload:'interactive' as const,buckets:[{key,limit:7},{key:partial,limit:4}]};
  expect((await transaction(pool,db=>requestCapacity(db,blocked))).state).toBe('waiting');
  expect((await pool.query('SELECT count(*)::int n FROM agents_platform.capacity_holds WHERE request_id=$1',[blocked.id])).rows[0].n).toBe(0);
  await expect(pool.query('INSERT INTO agents_platform.capacity_slots(bucket_key,slot) VALUES($1,8)',[key])).rejects.toThrow('Capacity slot exceeds');
  await expect(pool.query('UPDATE agents_platform.capacity_buckets SET max_active=8 WHERE key=$1',[key])).rejects.toThrow('Capacity limits are immutable');
 });
 it('reconciles verified cancellation output after the repeated cancel acknowledgement is already completed',async()=>{
  const [task,other]=await tasks();
  await pool.query("UPDATE agents_platform.task_outbox SET dispatched_at=now() WHERE task_id=ANY($1::uuid[])",[[task!.id,other!.id]]);
  await pool.query("UPDATE agents_platform.tasks SET state='cancel_requested',runtime_invocation_id='inv_cancel_reconciliation' WHERE id=$1",[task!.id]);
  let outputs=0,confirmed=false;
  const fetcher:typeof fetch=async(url,options)=>{
   if(options?.method==='PATCH')return Response.json({message:'invocation already completed'},{status:409});
   if(String(url).includes('/restate/output/')){outputs++;return confirmed?Response.json({message:'Cancelled'},{status:409}):Response.json({state:'running'},{status:202});}
   throw Error('Unexpected fixture request');
  };
  await dispatchTasksOnce(pool,{ingressUrl:'http://localhost',adminUrl:'http://localhost',fetch:fetcher});
  expect((await pool.query('SELECT state FROM agents_platform.tasks WHERE id=$1',[task!.id])).rows[0].state).toBe('cancel_requested');
  confirmed=true;await dispatchTasksOnce(pool,{ingressUrl:'http://localhost',adminUrl:'http://localhost',fetch:fetcher});
  expect(outputs).toBe(2);expect((await pool.query('SELECT state FROM agents_platform.tasks WHERE id=$1',[task!.id])).rows[0].state).toBe('cancelled');
 });
 it('lets a free tenant pass an ineligible older waiter and preserves priority when that waiter becomes eligible',async()=>{
  const [a,b]=await tasks(),[c]=await tasks(),shared=`shared:${randomUUID()}`,own=`tenant-a:${randomUUID()}`;
  const request=(taskId:string,tenant:string)=>({id:`op:${randomUUID()}`,taskId,workload:'interactive' as const,buckets:[{key:shared,limit:10},{key:tenant,limit:1}]});
  const held=request(a!.id,own),older=request(a!.id,own);await transaction(pool,db=>requestCapacity(db,held));
  await transaction(pool,db=>activateCapacity(db,held.id,1));await transaction(pool,db=>releaseCapacity(db,held.id,'uncertain'));
  expect((await transaction(pool,db=>requestCapacity(db,older))).state).toBe('waiting');
  const free=request(b!.id,`tenant-b:${randomUUID()}`);expect((await transaction(pool,db=>requestCapacity(db,free))).state).toBe('granted');
  await transaction(pool,db=>releaseCapacity(db,held.id,'uncertain',true));
  const newer=request(c!.id,`tenant-c:${randomUUID()}`);expect((await transaction(pool,db=>requestCapacity(db,newer))).state).toBe('waiting');
  await advanceCapacity(pool);
  expect((await pool.query('SELECT state FROM agents_platform.capacity_requests WHERE id=$1',[older.id])).rows[0].state).toBe('granted');
  expect((await pool.query('SELECT state FROM agents_platform.capacity_requests WHERE id=$1',[newer.id])).rows[0].state).toBe('granted');
 });
 it('commits deadline cancellation with a typed observation and one export intent',async()=>{
  const [task,other]=await tasks();await pool.query('UPDATE agents_platform.task_outbox SET dispatched_at=now() WHERE task_id=ANY($1::uuid[])',[[task!.id,other!.id]]);
  await pool.query("UPDATE agents_platform.tasks SET deadline_at=now()-interval '1 second' WHERE id=$1",[task!.id]);
  await dispatchTasksOnce(pool,{ingressUrl:'http://localhost',adminUrl:'http://localhost',fetch:async()=>{throw Error('Unexpected fixture request');}});
  const event=(await pool.query("SELECT e.observation,count(x.event_sequence)::int exports FROM agents_platform.task_events e LEFT JOIN agents_platform.observation_exports x ON x.event_sequence=e.sequence WHERE e.task_id=$1 AND e.event_key='deadline-stop' GROUP BY e.sequence",[task!.id])).rows[0];
  expect(event.exports).toBe(1);expect(event.observation).toMatchObject({schemaVersion:'agent.observation.v1',kind:'cancel_requested',identity:{taskId:task!.id},metadata:{errorCode:'TASK_DEADLINE'}});
 });
});
