import {dropClosedTestDatabase} from "./support/database-cleanup";
import {connectFixtureModel} from "./model-fixture";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {defaultBusinessConfiguration,executionGrantSchema,type AdmissionAuthority} from "../src/contracts/contracts";
import {PlatformStore} from "../src/product/agents/store";
import {setupPlatformSchema} from "../src/composition/setup";
import {beginOperation,finishOperation,settleTask} from '../src/execution/lifecycle/execution';
import {advanceCapacity,reclaimExpiredModelCapacity} from "../src/execution/scheduling/capacity";
import {persistOperationReceipt} from "../src/execution/scheduling/receipt-persistence";
const dbUrl=process.env.AGENTS_TEST_DATABASE_URL;
(dbUrl?describe:describe.skip)("native operation capacity PostgreSQL",()=>{
 let admin:Pool,pool:Pool,store:PlatformStore;
 const dbname=`agents_operation_capacity_${randomUUID().replaceAll('-','')}`;
 beforeAll(async()=>{admin=new Pool({connectionString:dbUrl});await admin.query(`CREATE DATABASE "${dbname}"`);const url=new URL(dbUrl!);url.pathname=`/${dbname}`;pool=new Pool({connectionString:url.href,max:8});await setupPlatformSchema(pool);store=new PlatformStore(pool);});
 afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,dbname);await admin.end();}});
 async function tasks(){
  const account=await store.ensureAccount({issuer:'http://localhost/test',subject:randomUUID(),email:'schedule@example.com',displayName:'Fixture'}),org=await store.createOrganization(account.id,'Scheduler fixture');
  await connectFixtureModel(pool,account.id,org.id);
  const config=defaultBusinessConfiguration();const agent=await store.createAgent({accountId:account.id,organizationId:org.id,name:'Fixture',configuration:config});
  const version=await store.createVersion({accountId:account.id,organizationId:org.id,agentId:agent.id,expectedRevision:1});
  const authority:AdmissionAuthority={product:'agents',organizationId:org.id,resourceId:agent.id,callerClientId:'agents-execution',principal:{kind:'human',issuer:account.issuer,subject:account.subject}};
  const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:['model.reply','knowledge.read'],maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:config.model.maxInputBytes,expiresAt:new Date(Date.now()+120000).toISOString(),revokedAt:null});await store.createGrant({accountId:account.id,grant});
  const results=await Promise.all([1,2].map(()=>store.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:'Hello'})));
  return results.map(r=>r.task);
 }
 it('commits a waiting operation without reserving usage and rechecks authority on the eventual grant',async()=>{
  const [a,b]=await tasks();
  const op=(id:string)=>({id,kind:'model' as const,name:'model.generate',request:{id},reservedTokens:100,reservedMs:1000});
  const one=op(`one:${randomUUID()}`),two=op(`two:${randomUUID()}`),three=op(`three:${randomUUID()}`);
  expect((await beginOperation(pool,a!.id,one)).waiting).not.toBe(true);
  expect((await beginOperation(pool,b!.id,two)).waiting).not.toBe(true);
  const waiting=await beginOperation(pool,a!.id,three);expect(waiting).toMatchObject({waiting:true,capacity:{state:'waiting'}});
  expect((await pool.query('SELECT id FROM agents_platform.operations WHERE id=$1',[three.id])).rowCount).toBe(0);
  expect((await pool.query('SELECT tokens_reserved FROM agents_platform.tasks WHERE id=$1',[a!.id])).rows[0].tokens_reserved).toBe(100);
  await finishOperation(pool,a!.id,one.id,'completed','confirmed',null,5);await advanceCapacity(pool);
  const admitted=await beginOperation(pool,a!.id,three);expect(admitted.waiting).not.toBe(true);
  await finishOperation(pool,a!.id,three.id,'completed','confirmed',null,5);await finishOperation(pool,b!.id,two.id,'completed','confirmed',null,5);
  const replay=await beginOperation(pool,a!.id,three);expect(replay).toMatchObject({replayed:true,operation:{state:'completed'}});
  expect((await pool.query('SELECT count(*)::int n FROM agents_platform.operation_usage WHERE operation_id=$1',[three.id])).rows[0].n).toBe(1);
  expect((await pool.query('SELECT count(*)::int n FROM agents_platform.capacity_holds WHERE request_id=$1',[three.id])).rows[0].n).toBe(0);
  await settleTask(pool,a!.id,{state:'completed'});await settleTask(pool,a!.id,{state:'completed'});
  expect((await pool.query('SELECT active_roots FROM agents_platform.tenant_admission WHERE organization_id=$1',[a!.organization_id])).rows[0].active_roots).toBe(1);
 });
 it('rechecks authority after acquiring the root lock rather than trusting the preliminary identity read',async()=>{
  const [task]=await tasks(),input={id:randomUUID(),kind:'model' as const,name:'model.generate',request:{},reservedTokens:100,reservedMs:1000};
  const blocker=await pool.connect();let pending:ReturnType<typeof beginOperation>|undefined;
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT root_task_id FROM agents_platform.execution_roots WHERE root_task_id=$1 FOR UPDATE',[task!.root_task_id]);
   pending=beginOperation(pool,task!.id,input);const outcome=pending.then(value=>({value}),error=>({error}));
   let waiting=false;
   for(let n=0;n<100;n++){
    const row=await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT * FROM agents_platform.execution_roots%' LIMIT 1");
    if(row.rowCount){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
   }
   expect(waiting).toBe(true);
   await pool.query('UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1',[task!.grant_id]);
   await blocker.query('COMMIT');expect(await outcome).toMatchObject({error:{code:'GRANT_REVOKED'}});
   expect((await pool.query('SELECT id FROM agents_platform.operations WHERE id=$1',[input.id])).rowCount).toBe(0);
   expect((await pool.query('SELECT tokens_reserved FROM agents_platform.tasks WHERE id=$1',[task!.id])).rows[0].tokens_reserved).toBe(0);
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>{});}
 });
 it('preserves missing-task errors for operation admission, receipt persistence and settlement',async()=>{
  const id=randomUUID(),operationId=randomUUID();
  await expect(beginOperation(pool,id,{id:operationId,kind:'model',name:'model.generate',request:{},reservedTokens:100,reservedMs:1000})).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
  await expect(finishOperation(pool,id,operationId,'completed',{},null,0)).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
  await expect(settleTask(pool,id,{state:'completed'})).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
 });
 it('revocation wins a queued operation without invoking or charging it',async()=>{
  const [a,b]=await tasks(),op=(id:string)=>({id,kind:'model' as const,name:'model.generate',request:{id},reservedTokens:100,reservedMs:1000});
  const first=op(randomUUID()),second=op(randomUUID()),queued=op(randomUUID());
  await beginOperation(pool,a!.id,first);await beginOperation(pool,b!.id,second);expect((await beginOperation(pool,a!.id,queued)).waiting).toBe(true);
  await pool.query('UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1',[a!.grant_id]);
  await finishOperation(pool,b!.id,second.id,'completed','done',null,5);await advanceCapacity(pool);
  await expect(beginOperation(pool,a!.id,queued)).rejects.toMatchObject({code:'GRANT_REVOKED'});
  expect((await pool.query('SELECT state,error_code FROM agents_platform.capacity_requests WHERE id=$1',[queued.id])).rows[0]).toMatchObject({state:'rejected',error_code:'GRANT_REVOKED'});
  expect((await pool.query('SELECT id FROM agents_platform.operations WHERE id=$1',[queued.id])).rowCount).toBe(0);
  await finishOperation(pool,a!.id,first.id,'uncertain',null,'OPERATION_OUTCOME_UNCERTAIN',100);
  expect((await pool.query('SELECT state FROM agents_platform.capacity_requests WHERE id=$1',[first.id])).rows[0].state).toBe('uncertain');
 });
 it('recovers a lost receipt acknowledgement from the actual committed record without charging twice',async()=>{
  const [task]=await tasks(),input={id:randomUUID(),kind:'model' as const,name:'model.generate',request:{},reservedTokens:100,reservedMs:1000};
  const admission=await beginOperation(pool,task!.id,input);if(admission.waiting)throw Error('Unexpected capacity wait');
  let writes=0;const value={answer:'Known provider response'};
  const receipt=await persistOperationReceipt(async()=>{writes++;const saved=await finishOperation(pool,task!.id,input.id,'completed',value,null,7,admission.operation.attempt_id);if(writes===1)throw Object.assign(Error('Lost COMMIT acknowledgement'),{code:'08006'});return saved;});
  expect(writes).toBe(2);expect(receipt).toMatchObject({state:'completed',output:value,accounted_tokens:7});
  expect((await pool.query('SELECT count(*)::int n FROM agents_platform.operation_usage WHERE operation_id=$1',[input.id])).rows[0].n).toBe(1);
  const conflict=await finishOperation(pool,task!.id,input.id,'completed',{answer:'Different'},null,99,admission.operation.attempt_id);
  expect(conflict).toMatchObject({state:'completed',output:value,accounted_tokens:7});
 });
 it('fences stale attempts and never upgrades an existing uncertain receipt',async()=>{
  const [task]=await tasks(),input={id:randomUUID(),kind:'tool' as const,name:'knowledge.search',request:{query:'hours'},reservedTokens:0,reservedMs:1000,retrySafe:true};
  const first=await beginOperation(pool,task!.id,input),second=await beginOperation(pool,task!.id,input);if(first.waiting||second.waiting)throw Error('Unexpected capacity wait');
  expect(first.operation.attempt_id).not.toBe(second.operation.attempt_id);
  expect(await finishOperation(pool,task!.id,input.id,'completed',{answer:'Stale'},null,0,first.operation.attempt_id)).toMatchObject({state:'started',attempt_id:second.operation.attempt_id});
  expect((await pool.query('SELECT count(*)::int n FROM agents_platform.operation_usage WHERE operation_id=$1',[input.id])).rows[0].n).toBe(0);
  await finishOperation(pool,task!.id,input.id,'uncertain',null,'PREVIOUS_OUTCOME_UNCERTAIN',0,second.operation.attempt_id);
  expect(await finishOperation(pool,task!.id,input.id,'completed',{answer:'Late'},null,0,second.operation.attempt_id)).toMatchObject({state:'uncertain',output:null,error_code:'PREVIOUS_OUTCOME_UNCERTAIN'});
 });
 it('fences stale interrupted effects while retaining completed receipts and status-only recovery',async()=>{
  const [task]=await tasks(),request={instructionHead:'0'};
  const inputs=['tool','delegation'].map(kind=>({id:randomUUID(),kind:kind as 'tool'|'delegation',name:kind==='tool'?'records.update':'agents.start',request,
   instructionHead:'0',reservedTokens:0,reservedMs:1000,retrySafe:true}));
  const completed={...inputs[0]!,id:randomUUID()},reconciled={...inputs[0]!,id:randomUUID(),retrySafe:false,reconcile:true};
  for(const input of [...inputs,completed,reconciled])await beginOperation(pool,task!.id,input);
  await finishOperation(pool,task!.id,completed.id,'completed',{receipt:'existing'},null,0);
  await pool.query("INSERT INTO agents_platform.orchestration_instructions(task_id,request_key,instruction) VALUES($1,$2,'Stop the old action')",[task!.id,randomUUID()]);
  for(const input of inputs){
   expect(await beginOperation(pool,task!.id,input)).toMatchObject({replayed:true,operation:{state:'uncertain',error_code:'OPERATION_OUTCOME_UNCERTAIN'}});
   expect((await pool.query("SELECT count(*)::int n FROM agents_platform.task_events WHERE task_id=$1 AND kind='operation.retried' AND payload->>'operationId'=$2",[task!.id,input.id])).rows[0].n).toBe(0);
  }
  expect(await beginOperation(pool,task!.id,completed)).toMatchObject({replayed:true,operation:{state:'completed',output:{receipt:'existing'}}});
  const recovery=await beginOperation(pool,task!.id,reconciled);
  expect(recovery).toMatchObject({replayed:false,recovering:true});
  await finishOperation(pool,task!.id,reconciled.id,'completed',{receipt:'status-only'},null,0);
  expect((await pool.query('SELECT tool_calls FROM agents_platform.execution_roots WHERE root_task_id=$1',[task!.id])).rows[0].tool_calls).toBe(4);
 });
 it('reclaims only proven expired generation slots once without changing conservative accounting',async()=>{
  const [a,b]=await tasks(),inputs=[{id:randomUUID(),kind:'model' as const,name:'model.generate',request:{},reservedTokens:100,reservedMs:1000},{id:randomUUID(),kind:'compaction' as const,name:'context.compact',request:{},reservedTokens:100,reservedMs:1000}];
  for(const [i,input]of inputs.entries()){
   const task=[a,b][i]!;await beginOperation(pool,task.id,input);
   await pool.query("INSERT INTO agents_platform.private_model_continuations(operation_id,organization_id,task_id,role,route_binding_digest,request_digest,state) VALUES($1,$2,$3,$4,$5,$5,'started')",[input.id,task.organization_id,task.id,i?'compaction':'primary','0'.repeat(64)]);
   await finishOperation(pool,task.id,input.id,'uncertain',null,'MODEL_CANCELLED',100);
  }
  const accounting=async()=>({tasks:(await pool.query("SELECT id,state,error_code,tokens_used,tokens_reserved,active_ms,active_reserved_ms,root_token_limit FROM agents_platform.tasks WHERE id=ANY($1::uuid[]) ORDER BY id",[[a!.id,b!.id]])).rows,
   roots:(await pool.query("SELECT * FROM agents_platform.execution_roots WHERE root_task_id=ANY($1::uuid[]) ORDER BY root_task_id",[[a!.id,b!.id]])).rows,
   operations:(await pool.query("SELECT * FROM agents_platform.operations WHERE id=ANY($1::text[]) ORDER BY id",[inputs.map(input=>input.id)])).rows,
   usage:(await pool.query("SELECT * FROM agents_platform.operation_usage WHERE operation_id=ANY($1::text[]) ORDER BY operation_id",[inputs.map(input=>input.id)])).rows,
   costs:(await pool.query("SELECT * FROM agents_platform.model_cost_reservations WHERE operation_id=ANY($1::text[]) ORDER BY operation_id",[inputs.map(input=>input.id)])).rows,
   accounts:(await pool.query("SELECT * FROM agents_platform.root_model_accounts WHERE root_task_id=ANY($1::uuid[]) ORDER BY root_task_id",[[a!.id,b!.id]])).rows});
  const before=await accounting();expect(await reclaimExpiredModelCapacity(pool)).toBe(0);
  await new Promise(resolve=>setTimeout(resolve,1100));
  const releases=await Promise.all([reclaimExpiredModelCapacity(pool),reclaimExpiredModelCapacity(pool)]);expect(releases.reduce((a,b)=>a+b,0)).toBe(2);
  expect(await reclaimExpiredModelCapacity(pool)).toBe(0);expect(await accounting()).toEqual(before);
  expect((await pool.query("SELECT count(*)::int n FROM agents_platform.capacity_holds WHERE request_id=ANY($1::text[])",[inputs.map(input=>input.id)])).rows[0].n).toBe(0);
  expect((await pool.query("SELECT count(*)::int n FROM agents_platform.task_events WHERE task_id=ANY($1::uuid[]) AND kind='resource.capacity_released'",[[a!.id,b!.id]])).rows[0].n).toBe(2);
 });
 it('retains uncertain business effects and generation without persisted bounded-path proof',async()=>{
  const [a,b]=await tasks(),inputs=[{id:randomUUID(),kind:'tool' as const,name:'external.business.write',request:{},reservedTokens:0,reservedMs:1000},{id:randomUUID(),kind:'model' as const,name:'model.generate',request:{},reservedTokens:100,reservedMs:1000}];
  for(const [i,input]of inputs.entries()){const task=[a,b][i]!;await beginOperation(pool,task.id,input);await finishOperation(pool,task.id,input.id,'uncertain',null,'UNCONFIRMED_EXTERNAL_OUTCOME',input.reservedTokens);}
  await new Promise(resolve=>setTimeout(resolve,1100));await advanceCapacity(pool);
  expect((await pool.query("SELECT state FROM agents_platform.capacity_requests WHERE id=ANY($1::text[])",[inputs.map(input=>input.id)])).rows).toEqual([{state:'uncertain'},{state:'uncertain'}]);
  expect((await pool.query("SELECT count(DISTINCT request_id)::int n FROM agents_platform.capacity_holds WHERE request_id=ANY($1::text[])",[inputs.map(input=>input.id)])).rows[0].n).toBe(2);
 });
 it('bounds receipt retries and does not retry invariant failures',async()=>{
  let transient=0;await expect(persistOperationReceipt(async()=>{transient++;throw Object.assign(Error('Disconnected'),{code:'08006'});})).rejects.toMatchObject({code:'08006'});expect(transient).toBe(3);
  let invariant=0;await expect(persistOperationReceipt(async()=>{invariant++;throw Object.assign(Error('Invalid receipt'),{code:'23514'});})).rejects.toMatchObject({code:'23514'});expect(invariant).toBe(1);
 });
});
