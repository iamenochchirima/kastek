import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
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
 async function tasks(){
  const account=await store.ensureAccount({issuer:'http://localhost/test',subject:randomUUID(),email:'schedule@example.com',displayName:'Fixture'}),org=await store.createOrganization(account.id,'Scheduler fixture');
  const config=defaultBusinessConfiguration();const agent=await store.createAgent({accountId:account.id,organizationId:org.id,name:'Fixture',configuration:config});
  const version=await store.createVersion({accountId:account.id,organizationId:org.id,agentId:agent.id,expectedRevision:1});
  const authority:AdmissionAuthority={product:'agents',organizationId:org.id,resourceId:agent.id,callerClientId:'agents-execution',principal:{kind:'human',issuer:account.issuer,subject:account.subject}};
  const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:['model.reply','knowledge.read'],maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,expiresAt:new Date(Date.now()+120000).toISOString(),revokedAt:null});await store.createGrant({accountId:account.id,grant});
  const results=await Promise.all([1,2].map(()=>store.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:'Hello'})));
  return results.map(r=>r.task);
 }
 it('claims bounded batches fairly without overlapping replica leases and recovers expired claims',async()=>{
  const a=await tasks(),b=await tasks();
  const [one,two]=await Promise.all([claimDispatchBatch(pool,{batchSize:2}),claimDispatchBatch(pool,{batchSize:2})]);
  const ids=[...one.rows,...two.rows].map(r=>r.task_id);expect(new Set(ids).size).toBe(4);
  expect(one.rows.length).toBe(2);expect(two.rows.length).toBe(2);
  const tenants=(await pool.query('SELECT organization_id FROM agents_platform.tasks WHERE id=ANY($1::uuid[])',[one.rows.map(r=>r.task_id)])).rows;expect(new Set(tenants.map(r=>r.organization_id)).size).toBe(2);
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
  const blocker=await pool.connect(),probe=await pool.connect();let sweep:Promise<void>|undefined;
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
  const current=await transaction(pool,db=>requestCapacity(db,request));await transaction(pool,db=>activateCapacity(db,request.id,current.generation));
  await transaction(pool,db=>releaseCapacity(db,request.id,'uncertain'));
  const second={...request,id:`op:${randomUUID()}`,taskId:b!.id};expect((await transaction(pool,db=>requestCapacity(db,second))).state).toBe('waiting');
  await pool.query("UPDATE agents_platform.capacity_requests SET deadline_at=now()-interval '1 second' WHERE id=$1",[second.id]);await advanceCapacity(pool);
  expect((await pool.query('SELECT state,error_code FROM agents_platform.capacity_requests WHERE id=$1',[second.id])).rows[0]).toMatchObject({state:'rejected',error_code:'CAPACITY_WAIT_EXPIRED'});
  expect((await pool.query('SELECT count(*)::int n FROM agents_platform.capacity_holds WHERE request_id=$1',[request.id])).rows[0].n).toBe(1);
  await transaction(pool,db=>releaseCapacity(db,request.id,'uncertain',true));expect((await pool.query('SELECT count(*)::int n FROM agents_platform.capacity_holds WHERE request_id=$1',[request.id])).rows[0].n).toBe(0);
 });
});
