import {dropClosedTestDatabase} from "./support/database-cleanup";
import {connectFixtureModel} from "./model-fixture";
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {Pool} from 'pg';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {defaultBusinessConfiguration,executionGrantSchema,type AdmissionAuthority} from '../src/contracts/contracts';
import {PlatformStore} from '../src/product/agents/store';
import {setupPlatformSchema} from '../src/composition/setup';
import {transaction} from '../src/infrastructure/database';
import {dispatchTasksOnce,startDispatcher} from '../src/execution/lifecycle/dispatcher';
import {requestCapacity,activateCapacity,releaseCapacity,advanceCapacity} from '../src/execution/scheduling/capacity';

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)('bounded dispatcher phases with native PostgreSQL and HTTP',()=>{
 let admin:Pool,pool:Pool,store:PlatformStore,server:Server,origin:string;
 const database=`agents_dispatch_lifecycle_${randomUUID().replaceAll('-','')}`,sent:string[]=[],requests:string[]=[];
 beforeAll(async()=>{
  admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;
  pool=new Pool({connectionString:url.href,max:8});await setupPlatformSchema(pool);store=new PlatformStore(pool);
  server=createServer(async(req,res)=>{
   requests.push(req.url!);let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text||'{}');res.setHeader('content-type','application/json');
   if(req.url?.includes('/restate/send/')){sent.push(body.taskId);res.end(JSON.stringify({invocationId:`inv_${body.taskId}`}));}
   else if(req.url==='/restate/lookup')res.end(JSON.stringify({invocationId:`inv_${body.workflowKey}`}));
   else res.end('{}');
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 });
 afterAll(async()=>{server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 async function fixture(){
  const account=await store.ensureAccount({issuer:'http://localhost/dispatcher-fixture',subject:randomUUID(),email:'operator@example.test',displayName:'Fixture'}),org=await store.createOrganization(account.id,'Dispatcher fixture'),config=defaultBusinessConfiguration();
  await connectFixtureModel(pool,account.id,org.id);
  const agent=await store.createAgent({accountId:account.id,organizationId:org.id,name:'Fixture',configuration:config}),version=await store.createVersion({accountId:account.id,organizationId:org.id,agentId:agent.id,expectedRevision:1});
  const authority:AdmissionAuthority={product:'agents',organizationId:org.id,resourceId:agent.id,callerClientId:'agents-execution',principal:{kind:'human',issuer:account.issuer,subject:account.subject}};
  const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:['model.reply','knowledge.read'],maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,expiresAt:new Date(Date.now()+120000).toISOString(),revokedAt:null});await store.createGrant({accountId:account.id,grant});
  const roots=await Promise.all([1,2].map(()=>store.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:'Hello'})));
  return{grant,tasks:roots.map(row=>row.task)};
 }
 async function eventually(check:()=>Promise<boolean>,timeout=3000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Owned dispatcher checkpoint timed out');}
 it('preserves one-shot phase order and ignores observer failures',async()=>{
  const phases:{phase:string;success:boolean;durationMs:number}[]=[];
  await dispatchTasksOnce(pool,{ingressUrl:origin,adminUrl:origin,onPhase:(phase,durationMs,success)=>{phases.push({phase,durationMs,success});throw Error('Observer failed');}});
  expect(phases.map(item=>item.phase)).toEqual(['dispatch','reconciliation','capacity','capacity_notifications','controls']);
  expect(phases.every(item=>item.success&&Number.isFinite(item.durationMs)&&item.durationMs>=0)).toBe(true);
 });
 it('keeps invalid-route failures asynchronous and performs no database work',async()=>{
  const closed=new Pool({connectionString:pool.options.connectionString,max:1});await closed.end();
  const queries=vi.spyOn(closed,'query'),phases:{phase:string;success:boolean}[]=[],errors:string[]=[];
  const dispatcher=startDispatcher(closed,{ingressUrl:'invalid-route',adminUrl:origin,onPhase:(phase,_durationMs,success)=>phases.push({phase,success}),onError:code=>errors.push(code)});
  await eventually(async()=>phases.length===5);await dispatcher.stop();
  expect(new Set(phases.map(item=>item.phase)).size).toBe(5);expect(phases.every(item=>!item.success)).toBe(true);expect(errors).toEqual(Array(5).fill('RUNTIME_PUBLISHER_FAILED'));
  await expect(dispatchTasksOnce(closed,{ingressUrl:'invalid-route',adminUrl:origin})).rejects.toThrow('Invalid URL');expect(queries).not.toHaveBeenCalled();queries.mockRestore();
 });
 it('reports a failed phase without replacing its native error with an observer error',async()=>{
  const closed=new Pool({connectionString:pool.options.connectionString,max:1});await closed.end();const phases:{phase:string;success:boolean}[]=[];
  await expect(dispatchTasksOnce(closed,{ingressUrl:origin,adminUrl:origin,onPhase:(phase,_durationMs,success)=>{phases.push({phase,success});throw Error('Observer failed');}})).rejects.toThrow('Cannot use a pool after calling end');
  expect(phases).toEqual([{phase:'dispatch',success:false}]);
 });
 it('dispatches a newly admitted root while capacity is blocked, drains stop and retains revocation fences',async()=>{
  const waiting=await fixture(),[a,b]=waiting.tasks,key=`blocked-capacity:${randomUUID()}`;
  await pool.query('UPDATE agents_platform.task_outbox SET dispatched_at=now() WHERE task_id=ANY($1::uuid[])',[waiting.tasks.map(task=>task.id)]);
  const first={id:`capacity:${randomUUID()}`,taskId:a!.id,workload:'interactive' as const,buckets:[{key,limit:1}]},second={...first,id:`capacity:${randomUUID()}`,taskId:b!.id};
  await transaction(pool,db=>requestCapacity(db,first));await transaction(pool,db=>activateCapacity(db,first.id,1));expect((await transaction(pool,db=>requestCapacity(db,second))).state).toBe('waiting');await transaction(pool,db=>releaseCapacity(db,first.id,'completed'));
  const blocker=await pool.connect();let dispatcher:ReturnType<typeof startDispatcher>|undefined;
  const phases:{phase:string;success:boolean;durationMs:number}[]=[];
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM agents_platform.execution_grants WHERE id=$1 FOR UPDATE',[waiting.grant.id]);
   dispatcher=startDispatcher(pool,{ingressUrl:origin,adminUrl:origin,onPhase:(phase,durationMs,success)=>{phases.push({phase,durationMs,success});throw Error('Observer failure must not stop dispatch');}});
   await eventually(async()=>!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT * FROM agents_platform.execution_grants%' LIMIT 1")).rowCount);
   const fresh=await fixture();await pool.query('UPDATE agents_platform.task_outbox SET dispatched_at=now() WHERE task_id=$1',[fresh.tasks[1]!.id]);
   await eventually(async()=>sent.includes(fresh.tasks[0]!.id));
   expect(phases.some(item=>item.phase==='dispatch'&&item.success&&item.durationMs>=0)).toBe(true);
   expect(phases.some(item=>item.phase==='capacity')).toBe(false);
   expect((await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT * FROM agents_platform.execution_grants%'")).rows[0].n).toBe(1);
   let stopped=false;const stop=dispatcher.stop().then(()=>{stopped=true;});await new Promise<void>(resolve=>setImmediate(resolve));expect(stopped).toBe(false);
   const afterStop=await fixture();await blocker.query('UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1',[waiting.grant.id]);await blocker.query('COMMIT');await stop;
   expect((await pool.query('SELECT state,error_code FROM agents_platform.capacity_requests WHERE id=$1',[second.id])).rows[0]).toMatchObject({state:'rejected',error_code:'GRANT_REVOKED'});
   expect((await pool.query('SELECT id FROM agents_platform.operations WHERE task_id=$1',[b!.id])).rowCount).toBe(0);
   expect(sent.some(id=>afterStop.tasks.some(task=>task.id===id))).toBe(false);
   const observations=phases.length,requestCount=requests.length;await new Promise(resolve=>setTimeout(resolve,1100));expect(phases).toHaveLength(observations);expect(requests).toHaveLength(requestCount);
  }finally{await blocker.query('ROLLBACK');blocker.release();await dispatcher?.stop();}
 },10000);
 it('drains twenty native roots with batch one without one-second sleeps after committed acknowledgements',async()=>{
  await pool.query('UPDATE agents_platform.task_outbox SET dispatched_at=now() WHERE dispatched_at IS NULL');
  const fixtures=[];for(let n=0;n<10;n++)fixtures.push(await fixture());const ids=fixtures.flatMap(f=>f.tasks.map(task=>task.id)),started=Date.now();
  const dispatcher=startDispatcher(pool,{ingressUrl:origin,adminUrl:origin,policy:{batchSize:1,parallelism:1}});
  try{
   await eventually(async()=>Number((await pool.query('SELECT count(*)::int n FROM agents_platform.task_outbox WHERE task_id=ANY($1::uuid[]) AND dispatched_at IS NOT NULL',[ids])).rows[0].n)===20,4500);
   expect(Date.now()-started).toBeLessThan(5000);expect(sent.filter(id=>ids.includes(id))).toHaveLength(20);
   expect((await pool.query('SELECT attempts FROM agents_platform.task_outbox WHERE task_id=ANY($1::uuid[])',[ids])).rows.every(row=>row.attempts===1)).toBe(true);
  }finally{await dispatcher.stop();}
 },15000);
 it('does not count an HTTP acknowledgement after notification ownership has changed as progress',async()=>{
  await pool.query('UPDATE agents_platform.task_outbox SET dispatched_at=now() WHERE dispatched_at IS NULL');
  await pool.query('UPDATE agents_platform.capacity_notifications SET dispatched_at=now() WHERE dispatched_at IS NULL');
  const f=await fixture(),[a,b]=f.tasks,key=`notification-owner:${randomUUID()}`;
  await pool.query('UPDATE agents_platform.task_outbox SET dispatched_at=now() WHERE task_id=ANY($1::uuid[])',[f.tasks.map(t=>t.id)]);
  const first={id:`owner:${randomUUID()}`,taskId:a!.id,workload:'interactive' as const,buckets:[{key,limit:1}]},second={...first,id:`owner:${randomUUID()}`,taskId:b!.id};
  await transaction(pool,db=>requestCapacity(db,first));await transaction(pool,db=>activateCapacity(db,first.id,1));await transaction(pool,db=>requestCapacity(db,second));await transaction(pool,db=>releaseCapacity(db,first.id,'completed'));await advanceCapacity(pool);
  const foreignOwner=randomUUID(),phases:string[]=[];let delivered=0;
  const dispatcher=startDispatcher(pool,{ingressUrl:origin,adminUrl:origin,onPhase:phase=>phases.push(phase),fetch:async(url,options)=>{
   if(String(url).endsWith('/capacity')){delivered++;await pool.query('UPDATE agents_platform.capacity_notifications SET lease_owner=$2 WHERE request_id=$1',[second.id,foreignOwner]);return new Response('{}');}
   return fetch(url,options);
  }});
  try{
   await eventually(async()=>phases.includes('capacity_notifications')&&delivered===1);await new Promise(resolve=>setTimeout(resolve,150));
   expect(phases.filter(phase=>phase==='capacity_notifications')).toHaveLength(1);
   expect((await pool.query('SELECT dispatched_at,lease_owner FROM agents_platform.capacity_notifications WHERE request_id=$1',[second.id])).rows[0]).toMatchObject({dispatched_at:null,lease_owner:foreignOwner});
  }finally{await dispatcher.stop();}
 });
 it('drains another in-flight root before propagating a native acknowledgement failure or stopping',async()=>{
  await pool.query('UPDATE agents_platform.task_outbox SET dispatched_at=now() WHERE dispatched_at IS NULL');
  const f=await fixture(),[bad,good]=f.tasks;
  await pool.query(`CREATE SEQUENCE agents_platform.publisher_error_seen; CREATE FUNCTION agents_platform.reject_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.task_id='${bad!.id}' AND NEW.last_error_code='RUNTIME_DISPATCH_FAILED' THEN PERFORM nextval('agents_platform.publisher_error_seen');RAISE EXCEPTION 'Controlled retry persistence failure'; END IF;RETURN NEW;END $$;CREATE TRIGGER reject_retry BEFORE UPDATE ON agents_platform.task_outbox FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_retry()`);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let goodEntered=false,stopped=false;const phases:{phase:string;success:boolean}[]=[];
  const dispatcher=startDispatcher(pool,{ingressUrl:origin,adminUrl:origin,policy:{batchSize:2,parallelism:2},onPhase:(phase,_ms,success)=>phases.push({phase,success}),fetch:async(url,options)=>{
   if(String(url).includes('/restate/send/')){const task=JSON.parse(String(options?.body)).taskId;if(task===bad!.id)throw Error('Controlled transport failure');if(task===good!.id){goodEntered=true;await gate;}}
   return fetch(url,options);
  }});
  try{
   await eventually(async()=>goodEntered&&(await pool.query('SELECT is_called FROM agents_platform.publisher_error_seen')).rows[0].is_called);
   const stop=dispatcher.stop().then(()=>{stopped=true;});await new Promise<void>(resolve=>setImmediate(resolve));expect(stopped).toBe(false);expect(phases.some(x=>x.phase==='dispatch')).toBe(false);
   release();await stop;expect(phases.filter(x=>x.phase==='dispatch')).toEqual([{phase:'dispatch',success:false}]);
   expect((await pool.query('SELECT dispatched_at FROM agents_platform.task_outbox WHERE task_id=$1',[good!.id])).rows[0].dispatched_at).not.toBeNull();expect(sent.filter(id=>id===good!.id)).toHaveLength(1);
  }finally{release();await dispatcher.stop();}
 });

});
