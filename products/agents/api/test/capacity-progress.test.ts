import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {defaultBusinessConfiguration,executionGrantSchema,type AdmissionAuthority} from '../src/contracts/contracts';
import {PlatformStore} from '../src/product/agents/store';
import {setupPlatformSchema} from '../src/composition/setup';
import {transaction} from '../src/infrastructure/database';
import {selectCapacityCandidates} from '../src/execution/scheduling/capacity-turns';
import {claimDispatchBatch} from '../src/execution/scheduling/dispatch-claims';
import {requestCapacity,activateCapacity,releaseCapacity,advanceCapacity,type CapacityRequest} from '../src/execution/scheduling/capacity';

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)('durable hierarchical native capacity sweeps',()=>{
 let admin:Pool,pool:Pool,store:PlatformStore,database:string;
 beforeEach(async()=>{database=`agents_capacity_progress_${randomUUID().replaceAll('-','')}`;admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href,max:8});await setupPlatformSchema(pool);store=new PlatformStore(pool);});
 afterEach(async()=>{await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`);await admin.end();}});
 async function fixture(){
  const account=await store.ensureAccount({issuer:'http://localhost/capacity-progress',subject:randomUUID(),email:'fixture@example.test',displayName:'Fixture'}),org=await store.createOrganization(account.id,'Capacity fixture');
  const config=defaultBusinessConfiguration(),agent=await store.createAgent({accountId:account.id,organizationId:org.id,name:'Fixture',configuration:config}),version=await store.createVersion({accountId:account.id,organizationId:org.id,agentId:agent.id,expectedRevision:1});
  const authority:AdmissionAuthority={product:'agents',organizationId:org.id,resourceId:agent.id,callerClientId:'agents-execution',principal:{kind:'human',issuer:account.issuer,subject:account.subject}};
  const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:['model.reply','knowledge.read'],maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,expiresAt:new Date(Date.now()+120000).toISOString(),revokedAt:null});await store.createGrant({accountId:account.id,grant});
  const {task}=await store.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:'Capacity fixture'});
  return{task,grant};
 }
 const providerKey=(kind:'model'|'connected'|'local',account=randomUUID())=>`provider:${kind}:${createHash('sha256').update(account).digest('hex').slice(0,40)}`;
 const request=(taskId:string,key:string):CapacityRequest=>({id:randomUUID(),taskId,workload:'interactive',buckets:[{key,limit:1}]});
 async function hold(input:CapacityRequest){const grant=await transaction(pool,db=>requestCapacity(db,input));expect(grant.state).toBe('granted');await transaction(pool,db=>activateCapacity(db,input.id,grant.generation));}
 async function queued(taskId:string){const key=randomUUID(),holder=request(taskId,key),waiting=request(taskId,key);await hold(holder);expect((await transaction(pool,db=>requestCapacity(db,waiting))).state).toBe('waiting');await transaction(pool,db=>releaseCapacity(db,holder.id,'completed'));return waiting;}
 async function eventually(check:()=>Promise<boolean>){for(let n=0;n<200;n++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Native capacity checkpoint timed out');}
 async function blocked(){return !!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT * FROM agents_platform.execution_grants%' LIMIT 1")).rowCount;}
 it('grants a free model bucket beyond64blocked local waiters and still rejects revoked blocked work',async()=>{
  const f=await fixture(),localKey=providerKey('local'),modelKey=providerKey('model'),localHolder=request(f.task.id,localKey),modelHolder=request(f.task.id,modelKey);
  await hold(localHolder);await hold(modelHolder);const locals=[];
  for(let n=0;n<65;n++){const item=request(f.task.id,localKey);locals.push(item);expect((await transaction(pool,db=>requestCapacity(db,item))).state).toBe('waiting');}
  const model=request(f.task.id,modelKey);expect((await transaction(pool,db=>requestCapacity(db,model))).state).toBe('waiting');await transaction(pool,db=>releaseCapacity(db,modelHolder.id,'completed'));
  await advanceCapacity(pool);
  expect((await pool.query('SELECT state FROM agents_platform.capacity_requests WHERE id=$1',[model.id])).rows[0].state).toBe('granted');
  expect((await pool.query("SELECT count(*)::int n FROM agents_platform.capacity_requests WHERE id=ANY($1::text[]) AND state='waiting'",[locals.map(item=>item.id)])).rows[0].n).toBe(65);
  await pool.query('UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1',[f.grant.id]);await advanceCapacity(pool);
  expect((await pool.query('SELECT state,error_code FROM agents_platform.capacity_requests WHERE id=$1',[locals[0]!.id])).rows[0]).toMatchObject({state:'rejected',error_code:'GRANT_REVOKED'});
  expect((await pool.query('SELECT id FROM agents_platform.operations WHERE task_id=$1',[f.task.id])).rowCount).toBe(0);
 });
 it('probes availability only for due bucket keys in the actual native candidate query',async()=>{
  const f=await fixture(),key=randomUUID(),held=request(f.task.id,key),waiting=request(f.task.id,key);await hold(held);
  expect((await transaction(pool,db=>requestCapacity(db,waiting))).state).toBe('waiting');
  await pool.query("INSERT INTO agents_platform.capacity_buckets(key,max_active) SELECT 'unrelated:'||n,1 FROM generate_series(1,5000) n");
  await pool.query('ANALYZE agents_platform.capacity_buckets');await pool.query('ANALYZE agents_platform.capacity_requests');
  const client=await pool.connect(),spy=vi.spyOn(client,'query');client.release();
  let selected:readonly unknown[]|undefined;
  try{await advanceCapacity(pool);selected=spy.mock.calls.find(args=>typeof args[0]==='string'&&args[0].includes('unavailable AS MATERIALIZED'));}finally{spy.mockRestore();}
  expect(selected).toBeDefined();
  const plan=(await pool.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${selected![0]}`,selected![1] as unknown[])).rows[0]['QUERY PLAN'];
  const auditDirectory=resolve(__dirname,'../../../../.audit');await mkdir(auditDirectory,{recursive:true,mode:0o700});
  await writeFile(resolve(auditDirectory,'capacity-availability-plan.json'),JSON.stringify(plan,null,2),{mode:0o600});
  const nodes:Record<string,any>[]=[];const visit=(node:Record<string,any>)=>{nodes.push(node);for(const child of node.Plans??[])visit(child);};visit(plan[0].Plan);
  const bucketScans=nodes.filter(node=>node['Relation Name']==='capacity_buckets');expect(bucketScans).toHaveLength(1);
  expect(bucketScans[0]!['Node Type']).toMatch(/Index/);expect(bucketScans[0]!['Actual Rows']).toBe(1);expect(bucketScans[0]!['Rows Removed by Filter']??0).toBe(0);
  expect((await pool.query('SELECT count(*)::int n FROM agents_platform.capacity_buckets')).rows[0].n).toBe(5001);
 });
 it('reclaims an expired grant despite its full bucket and supports a one-connection pool',async()=>{
  const f=await fixture(),item=request(f.task.id,randomUUID()),first=await transaction(pool,db=>requestCapacity(db,item));
  await pool.query("UPDATE agents_platform.capacity_requests SET lease_until=now()-interval '1 second' WHERE id=$1",[item.id]);
  const single=new Pool({connectionString:pool.options.connectionString,max:1});try{
   expect(await advanceCapacity(single,{},1)).toBe(1);
   expect((await pool.query('SELECT state,generation FROM agents_platform.capacity_requests WHERE id=$1',[item.id])).rows[0]).toMatchObject({state:'waiting',generation:2});
   expect((await pool.query('SELECT count(*)::int n FROM agents_platform.capacity_holds WHERE request_id=$1',[item.id])).rows[0].n).toBe(0);
   expect(await advanceCapacity(single,{},1)).toBe(1);
  }finally{await single.end();}
  expect((await pool.query('SELECT state,generation FROM agents_platform.capacity_requests WHERE id=$1',[item.id])).rows[0]).toMatchObject({state:'granted',generation:2});
  await expect(transaction(pool,db=>activateCapacity(db,item.id,first.generation))).rejects.toMatchObject({code:'CAPACITY_LEASE_LOST'});
  expect((await pool.query('SELECT count(*)::int n FROM agents_platform.capacity_holds WHERE request_id=$1',[item.id])).rows[0].n).toBe(1);
 });
 it('promotes another tenant while first authority is blocked and revocation wins before unlock',async()=>{
  const a=await fixture(),b=await fixture(),first=await queued(a.task.id),second=await queued(b.task.id);
  await pool.query("UPDATE agents_platform.capacity_requests SET created_at=now()-interval '10 seconds' WHERE id=$1",[first.id]);
  const blocker=await pool.connect();let sweep:Promise<number>|undefined;let done=false;
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM agents_platform.execution_grants WHERE id=$1 FOR UPDATE',[a.grant.id]);sweep=advanceCapacity(pool).finally(()=>{done=true;});
   await eventually(blocked);await eventually(async()=>(await pool.query('SELECT state FROM agents_platform.capacity_requests WHERE id=$1',[second.id])).rows[0].state==='granted');expect(done).toBe(false);
   await blocker.query('UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1',[a.grant.id]);await blocker.query('COMMIT');await sweep;
   expect((await pool.query('SELECT state,error_code FROM agents_platform.capacity_requests WHERE id=$1',[first.id])).rows[0]).toMatchObject({state:'rejected',error_code:'GRANT_REVOKED'});
   expect((await pool.query('SELECT id FROM agents_platform.operations WHERE task_id=$1',[a.task.id])).rowCount).toBe(0);
  }finally{await blocker.query('ROLLBACK');blocker.release();await sweep;}
 });
 it('drains blocked transactions before propagating another candidate error',async()=>{
  const a=await fixture(),b=await fixture(),first=await queued(a.task.id),bad=await queued(b.task.id);
  await pool.query("UPDATE agents_platform.capacity_requests SET created_at=now()-interval '10 seconds' WHERE id=$1",[first.id]);
  await pool.query(`CREATE SEQUENCE agents_platform.candidate_error_seen; CREATE FUNCTION agents_platform.inject_candidate_error() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${bad.id}' AND NEW.state='granted' THEN PERFORM nextval('agents_platform.candidate_error_seen');RAISE EXCEPTION 'Injected candidate failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER candidate_error BEFORE UPDATE ON agents_platform.capacity_requests FOR EACH ROW EXECUTE FUNCTION agents_platform.inject_candidate_error()`);
  const blocker=await pool.connect();let sweep:Promise<{error:unknown}|{error:null}>|undefined;let done=false;
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM agents_platform.execution_grants WHERE id=$1 FOR UPDATE',[a.grant.id]);
   sweep=advanceCapacity(pool).then(()=>({error:null}),error=>({error})).finally(()=>{done=true;});
   await eventually(blocked);await eventually(async()=>(await pool.query('SELECT is_called FROM agents_platform.candidate_error_seen')).rows[0].is_called);expect(done).toBe(false);
   await blocker.query('COMMIT');expect((await sweep).error).toMatchObject({message:'Injected candidate failure'});
   expect((await pool.query('SELECT state FROM agents_platform.capacity_requests WHERE id=$1',[first.id])).rows[0].state).toBe('granted');
   expect(await blocked()).toBe(false);
  }finally{await blocker.query('ROLLBACK');blocker.release();await sweep;}
 });
 it('gives a model queue its turn despite65older partially eligible local requests',async()=>{
  const f=await fixture(),local=providerKey('local'),model=providerKey('model'),product={key:`product:${randomUUID()}`,limit:200};
  const modelRequest=()=>({...request(f.task.id,model),buckets:[{key:model,limit:1},product]});
  const localRequest=()=>({...request(f.task.id,local),buckets:[{key:local,limit:2},product]}),held=[localRequest(),localRequest()];await hold(held[0]!);await hold(held[1]!);
  const modelHeld=modelRequest();await hold(modelHeld);const locals=[];
  for(let n=0;n<65;n++){const item=localRequest();locals.push(item);expect((await transaction(pool,db=>requestCapacity(db,item))).state).toBe('waiting');}
  const target=modelRequest();expect((await transaction(pool,db=>requestCapacity(db,target))).state).toBe('waiting');
  await transaction(pool,db=>releaseCapacity(db,held[0]!.id,'completed'));await transaction(pool,db=>releaseCapacity(db,modelHeld.id,'completed'));
  expect(await advanceCapacity(pool)).toBe(1);expect((await pool.query('SELECT state FROM agents_platform.capacity_requests WHERE id=$1',[target.id])).rows[0].state).toBe('granted');
  expect((await pool.query("SELECT count(*)::int n FROM agents_platform.capacity_requests WHERE id=ANY($1::text[]) AND state='waiting'",[locals.map(item=>item.id)])).rows[0].n).toBe(65);
  expect((await pool.query('SELECT capacity_class_cursor FROM agents_platform.capacity_tenants WHERE organization_id=$1',[f.task.organization_id])).rows[0].capacity_class_cursor).toBe(1);
 });
 it('remembers the next connected account across pools while accountA remains partially free',async()=>{
  const f=await fixture(),a=`provider:connected:${'a'.repeat(40)}`,b=`provider:connected:${'b'.repeat(40)}`,product={key:`product:${randomUUID()}`,limit:200};
  const nextB=()=>({...request(f.task.id,b),buckets:[{key:b,limit:1},product]});
  const nextA=()=>({...request(f.task.id,a),buckets:[{key:a,limit:2},product]}),held=[nextA(),nextA()];await hold(held[0]!);await hold(held[1]!);const bHeld=nextB();await hold(bHeld);
  const locals=[];for(let n=0;n<65;n++){const item=nextA();locals.push(item);expect((await transaction(pool,db=>requestCapacity(db,item))).state).toBe('waiting');}
  const target=nextB();expect((await transaction(pool,db=>requestCapacity(db,target))).state).toBe('waiting');await transaction(pool,db=>releaseCapacity(db,held[0]!.id,'completed'));await transaction(pool,db=>releaseCapacity(db,bHeld.id,'completed'));
  const observedClient=await pool.connect(),querySpy=vi.spyOn(observedClient,'query');observedClient.release();let selection:readonly unknown[]|undefined;
  try{expect(await advanceCapacity(pool)).toBe(1);selection=querySpy.mock.calls.find(args=>typeof args[0]==='string'&&args[0].includes('chosen AS MATERIALIZED'));}finally{querySpy.mockRestore();}
  expect((await pool.query('SELECT capacity_connected_cursor FROM agents_platform.capacity_tenants WHERE organization_id=$1',[f.task.organization_id])).rows[0].capacity_connected_cursor).toBe(a);
  await transaction(pool,db=>releaseCapacity(db,held[1]!.id,'completed'));
  const nextPool=new Pool({connectionString:pool.options.connectionString,max:2});try{expect(await advanceCapacity(nextPool)).toBe(1);}finally{await nextPool.end();}
  expect((await pool.query('SELECT state FROM agents_platform.capacity_requests WHERE id=$1',[target.id])).rows[0].state).toBe('granted');
  expect((await pool.query('SELECT capacity_connected_cursor FROM agents_platform.capacity_tenants WHERE organization_id=$1',[f.task.organization_id])).rows[0].capacity_connected_cursor).toBe(b);
  expect((await pool.query("SELECT count(*)::int n FROM agents_platform.capacity_requests WHERE id=ANY($1::text[]) AND state='granted'",[locals.map(item=>item.id)])).rows[0].n).toBe(1);
  const unrelated=await fixture(),otherKey=providerKey('connected');await hold(request(unrelated.task.id,otherKey));
  await pool.query("INSERT INTO agents_platform.capacity_requests(id,task_id,bucket_keys,workload,state,deadline_at) SELECT gen_random_uuid()::text,$1,$2,'interactive','waiting',now()+interval '1 minute' FROM generate_series(1,5000)",[unrelated.task.id,[otherKey]]);
  await pool.query('ANALYZE agents_platform.capacity_requests');expect(selection).toBeDefined();
  const plan=(await pool.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${selection![0]}`,selection![1] as unknown[])).rows[0]['QUERY PLAN'];
  const auditDirectory=resolve(__dirname,'../../../../.audit');await mkdir(auditDirectory,{recursive:true,mode:0o700});await writeFile(resolve(auditDirectory,'capacity-account-seek-plan.json'),JSON.stringify(plan,null,2),{mode:0o600});
  const nodes:Record<string,any>[]=[];const visit=(node:Record<string,any>)=>{nodes.push(node);for(const child of node.Plans??[])visit(child);};visit(plan[0].Plan);
  const seeks=nodes.filter(node=>node['Index Name']==='capacity_resource_queue'&&['organization_id','resource_class','resource_key'].every(field=>String(node['Index Cond']).includes(field)));
  expect(seeks.length).toBeGreaterThan(0);expect(seeks.some(node=>node['Actual Loops']>0)).toBe(true);
 });
 it('rotates four sustained queues through one scarce product slot with two replicas',async()=>{
  const f=await fixture(),product=`product:${randomUUID()}`,holder=request(f.task.id,product);await hold(holder);
  const requests:CapacityRequest[]=[];
  for(const kind of ['local','model','connected','generic'] as const)for(let n=0;n<(kind==='connected'?12:6);n++){
   const item={...request(f.task.id,product),buckets:[{key:product,limit:1},...(kind==='generic'?[]:[{key:providerKey(kind,kind==='connected'?`connected_${n%2}`:kind),limit:20}])]};requests.push(item);expect((await transaction(pool,db=>requestCapacity(db,item))).state).toBe('waiting');
  }
  await transaction(pool,db=>releaseCapacity(db,holder.id,'completed'));const other=new Pool({connectionString:pool.options.connectionString,max:2}),seen:{resource_class:number;resource_key:string}[]=[];
  try{for(let n=0;n<20;n++){
   const progress=await Promise.all([advanceCapacity(pool,{},1),advanceCapacity(other,{},1)]);
   const granted=(await pool.query("SELECT id,resource_class,resource_key FROM agents_platform.capacity_requests WHERE state='granted'")).rows;expect(granted).toHaveLength(1);expect(progress[0]!+progress[1]!).toBe(1);seen.push({resource_class:granted[0].resource_class,resource_key:granted[0].resource_key});
   await transaction(pool,db=>releaseCapacity(db,granted[0].id,'completed'));
   if(n===0){const newcomer={...request(f.task.id,product),buckets:[{key:product,limit:1},{key:providerKey('model','model'),limit:20}]};expect((await transaction(pool,db=>requestCapacity(db,newcomer))).state).toBe('waiting');}
  }}finally{await other.end();}
  const auditDirectory=resolve(__dirname,'../../../../.audit');await mkdir(auditDirectory,{recursive:true,mode:0o700});await writeFile(resolve(auditDirectory,'capacity-hierarchy-service-sequence.json'),JSON.stringify(seen,null,2),{mode:0o600});
  for(const kind of [0,1,2,3])expect(seen.filter(value=>value.resource_class===kind).length).toBeGreaterThanOrEqual(3);
  for(const account of ['connected_0','connected_1'])expect(seen.filter(value=>value.resource_key===providerKey('connected',account)).length).toBeGreaterThanOrEqual(2);
 });
 it('derives strict generated queue identity and rejects caller tenant or identity mutation',async()=>{
  const f=await fixture(),other=await fixture(),model=providerKey('model');
  const cases:[string[],number,string][]=[[[model],0,model],[[providerKey('connected')],1,''],[[providerKey('local')],2,''],[['custom'],3,'generic'],[[`provider:model:${'A'.repeat(40)}`],3,'generic'],[[`provider:unknown:${'a'.repeat(40)}`],3,'generic'],[[model,'provider:malformed'],3,'generic'],[[model,providerKey('local')],3,'generic'],[[model,model],3,'generic']];
  for(const [keys,kind,expected] of cases){const row=(await pool.query('SELECT agents_platform.capacity_resource_class($1::text[]) AS class,agents_platform.capacity_resource_key($1::text[]) AS key',[keys])).rows[0];expect(row).toEqual({class:kind,key:expected||keys[0]});}
  const item=request(f.task.id,model);await transaction(pool,db=>requestCapacity(db,item));const saved=(await pool.query('SELECT organization_id,resource_class,resource_key FROM agents_platform.capacity_requests WHERE id=$1',[item.id])).rows[0];expect(saved).toEqual({organization_id:f.task.organization_id,resource_class:0,resource_key:model});
  await expect(pool.query("INSERT INTO agents_platform.capacity_requests(id,task_id,organization_id,bucket_keys,workload,state,deadline_at) VALUES($1,$2,$3,$4,'interactive','waiting',now()+interval '1 minute')",[randomUUID(),f.task.id,other.task.organization_id,[model]])).rejects.toThrow('Capacity tenant mismatch');
  for(const [column,value] of [['task_id',other.task.id],['organization_id',other.task.organization_id],['bucket_keys',['different']],['workload','background']] as const)await expect(pool.query(`UPDATE agents_platform.capacity_requests SET ${column}=$2 WHERE id=$1`,[item.id,value])).rejects.toThrow('Capacity request identity is immutable');
  await expect(pool.query("UPDATE agents_platform.capacity_requests SET resource_key='generic' WHERE id=$1",[item.id])).rejects.toMatchObject({code:'428C9'});
 });
 it('retains workload aging inside one account queue',async()=>{
  const f=await fixture(),key=providerKey('connected'),held=request(f.task.id,key),background={...request(f.task.id,key),workload:'background' as const},interactive=request(f.task.id,key);await hold(held);
  await transaction(pool,db=>requestCapacity(db,background));await transaction(pool,db=>requestCapacity(db,interactive));await pool.query("UPDATE agents_platform.capacity_requests SET created_at=now()-interval '2 seconds' WHERE id=$1",[background.id]);
  await transaction(pool,db=>releaseCapacity(db,held.id,'completed'));expect(await advanceCapacity(pool,{},1)).toBe(1);expect((await pool.query('SELECT state FROM agents_platform.capacity_requests WHERE id=$1',[interactive.id])).rows[0].state).toBe('granted');
  await transaction(pool,db=>releaseCapacity(db,interactive.id,'completed'));await pool.query("UPDATE agents_platform.capacity_requests SET created_at=now()-interval '10 seconds' WHERE id=$1",[background.id]);
  const newer=request(f.task.id,key);expect((await transaction(pool,db=>requestCapacity(db,newer))).state).toBe('waiting');expect(await advanceCapacity(pool,{},1)).toBe(1);expect((await pool.query('SELECT state FROM agents_platform.capacity_requests WHERE id=$1',[background.id])).rows[0].state).toBe('granted');
 });
 it('does not bypass turns on waiting or expired replay and counts only committed native progress',async()=>{
  const f=await fixture(),key=providerKey('local'),held=request(f.task.id,key),waiting=request(f.task.id,key);expect(await advanceCapacity(pool)).toBe(0);await hold(held);
  const first=await transaction(pool,db=>requestCapacity(db,waiting));expect(first.state).toBe('waiting');expect(await advanceCapacity(pool)).toBe(0);
  await transaction(pool,db=>releaseCapacity(db,held.id,'completed'));expect((await transaction(pool,db=>requestCapacity(db,waiting))).state).toBe('waiting');expect(await advanceCapacity(pool)).toBe(1);
  const deadline=(await pool.query('SELECT deadline_at FROM agents_platform.capacity_requests WHERE id=$1',[waiting.id])).rows[0].deadline_at;
  await pool.query("UPDATE agents_platform.capacity_requests SET lease_until=now()-interval '1 second' WHERE id=$1",[waiting.id]);
  const expired=await transaction(pool,db=>requestCapacity(db,waiting));expect(expired).toMatchObject({state:'waiting',generation:2});expect((await pool.query('SELECT count(*)::int n FROM agents_platform.capacity_holds WHERE request_id=$1',[waiting.id])).rows[0].n).toBe(0);
  await expect(transaction(pool,db=>activateCapacity(db,waiting.id,1))).rejects.toMatchObject({code:'CAPACITY_LEASE_LOST'});
  expect(await advanceCapacity(pool)).toBe(1);expect(await advanceCapacity(pool)).toBe(0);expect((await pool.query('SELECT deadline_at FROM agents_platform.capacity_requests WHERE id=$1',[waiting.id])).rows[0].deadline_at).toEqual(deadline);
  const a=await fixture(),b=await fixture();await queued(a.task.id);await queued(b.task.id);expect(await advanceCapacity(pool)).toBe(2);
 });

 it('dispatches a root while a capacity-selection transaction retains its tenant turn',async()=>{
  const f=await fixture(),key=providerKey('local'),holder=request(f.task.id,key),waiting=request(f.task.id,key);await hold(holder);
  expect((await transaction(pool,db=>requestCapacity(db,waiting))).state).toBe('waiting');
  const selecting=await pool.connect();let dispatch:ReturnType<typeof claimDispatchBatch>|undefined;
  try{
   await selecting.query('BEGIN');expect(await selectCapacityCandidates(selecting,1)).toHaveLength(1);
   dispatch=claimDispatchBatch(pool,{batchSize:1});
   const independent=await Promise.race([dispatch.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),500))]);
   expect(independent).toBe(true);expect((await dispatch).rows.map(row=>row.task_id)).toContain(f.task.id);
  }finally{await selecting.query('ROLLBACK');selecting.release();await dispatch;}
 });
 it('promotes capacity while a dispatch transaction retains the same tenant row',async()=>{
  const f=await fixture(),waiting=await queued(f.task.id),dispatching=await pool.connect();
  try{
   await dispatching.query('BEGIN');await dispatching.query('SELECT organization_id FROM agents_platform.scheduling_tenants WHERE organization_id=$1 FOR UPDATE',[f.task.organization_id]);
   expect(await advanceCapacity(pool,{},1)).toBe(1);
   expect((await pool.query('SELECT state FROM agents_platform.capacity_requests WHERE id=$1',[waiting.id])).rows[0].state).toBe('granted');
  }finally{await dispatching.query('ROLLBACK');dispatching.release();}
 });

});
