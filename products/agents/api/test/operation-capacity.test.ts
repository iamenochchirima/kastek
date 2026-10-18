import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {defaultBusinessConfiguration,executionGrantSchema,type AdmissionAuthority} from "../src/contracts/contracts";
import {PlatformStore} from "../src/product/agents/store";
import {setupPlatformSchema} from "../src/composition/setup";
import {beginOperation,finishOperation,settleTask} from '../src/execution/lifecycle/execution';
import {advanceCapacity} from "../src/execution/scheduling/capacity";
import {persistOperationReceipt} from "../src/execution/scheduling/receipt-persistence";
const dbUrl=process.env.AGENTS_TEST_DATABASE_URL;
(dbUrl?describe:describe.skip)("native operation capacity PostgreSQL",()=>{
 let admin:Pool,pool:Pool,store:PlatformStore;
 const dbname=`agents_operation_capacity_${randomUUID().replaceAll('-','')}`;
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
 it('bounds receipt retries and does not retry invariant failures',async()=>{
  let transient=0;await expect(persistOperationReceipt(async()=>{transient++;throw Object.assign(Error('Disconnected'),{code:'08006'});})).rejects.toMatchObject({code:'08006'});expect(transient).toBe(3);
  let invariant=0;await expect(persistOperationReceipt(async()=>{invariant++;throw Object.assign(Error('Invalid receipt'),{code:'23514'});})).rejects.toMatchObject({code:'23514'});expect(invariant).toBe(1);
 });
});
