import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {defaultBusinessConfiguration,executionGrantSchema,type AdmissionAuthority} from '../src/contracts/contracts';
import {PlatformStore} from '../src/product/agents/store';
import {setupPlatformSchema} from '../src/composition/setup';
import {transaction} from '../src/infrastructure/database';
import {requestCapacity,activateCapacity,releaseCapacity,advanceCapacity,type CapacityRequest} from '../src/execution/scheduling/capacity';

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)('work-conserving bounded native capacity sweeps',()=>{
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
 const request=(taskId:string,key:string):CapacityRequest=>({id:randomUUID(),taskId,workload:'interactive',buckets:[{key,limit:1}]});
 async function hold(input:CapacityRequest){const grant=await transaction(pool,db=>requestCapacity(db,input));expect(grant.state).toBe('granted');await transaction(pool,db=>activateCapacity(db,input.id,grant.generation));}
 async function queued(taskId:string){const key=randomUUID(),holder=request(taskId,key),waiting=request(taskId,key);await hold(holder);expect((await transaction(pool,db=>requestCapacity(db,waiting))).state).toBe('waiting');await transaction(pool,db=>releaseCapacity(db,holder.id,'completed'));return waiting;}
 async function eventually(check:()=>Promise<boolean>){for(let n=0;n<200;n++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Native capacity checkpoint timed out');}
 async function blocked(){return !!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT * FROM agents_platform.execution_grants%' LIMIT 1")).rowCount;}
 it('grants a free model bucket beyond64blocked local waiters and still rejects revoked blocked work',async()=>{
  const f=await fixture(),localKey=`local:${randomUUID()}`,modelKey=`model:${randomUUID()}`,localHolder=request(f.task.id,localKey),modelHolder=request(f.task.id,modelKey);
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
 it('reclaims an expired grant despite its full bucket and supports a one-connection pool',async()=>{
  const f=await fixture(),item=request(f.task.id,randomUUID()),first=await transaction(pool,db=>requestCapacity(db,item));
  await pool.query("UPDATE agents_platform.capacity_requests SET lease_until=now()-interval '1 second' WHERE id=$1",[item.id]);
  const single=new Pool({connectionString:pool.options.connectionString,max:1});try{await advanceCapacity(single,{},1);}finally{await single.end();}
  expect((await pool.query('SELECT state,generation FROM agents_platform.capacity_requests WHERE id=$1',[item.id])).rows[0]).toMatchObject({state:'granted',generation:2});
  await expect(transaction(pool,db=>activateCapacity(db,item.id,first.generation))).rejects.toMatchObject({code:'CAPACITY_LEASE_LOST'});
  expect((await pool.query('SELECT count(*)::int n FROM agents_platform.capacity_holds WHERE request_id=$1',[item.id])).rows[0].n).toBe(1);
 });
 it('promotes another tenant while first authority is blocked and revocation wins before unlock',async()=>{
  const a=await fixture(),b=await fixture(),first=await queued(a.task.id),second=await queued(b.task.id);
  await pool.query("UPDATE agents_platform.capacity_requests SET created_at=now()-interval '10 seconds' WHERE id=$1",[first.id]);
  const blocker=await pool.connect();let sweep:Promise<void>|undefined;let done=false;
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
});
