import {connectFixtureModel} from "./model-fixture";
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {defaultBusinessConfiguration,executionGrantSchema,type AdmissionAuthority} from '../src/contracts/contracts';
import {PlatformStore} from '../src/product/agents/store';
import {setupPlatformSchema} from '../src/composition/setup';
import {beginOperation,finishOperation} from '../src/execution/lifecycle/execution';
import {advanceCapacity} from '../src/execution/scheduling/capacity';

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)('independent local operation capacity with PostgreSQL',()=>{
 let admin:Pool,pool:Pool,store:PlatformStore;
 const database=`agents_local_capacity_${randomUUID().replaceAll('-','')}`,originalPolicy=process.env.AGENTS_SCHEDULING_POLICY_JSON;
 const policy={productActive:8,tenantActive:8,modelActive:4,toolActive:4,providerActive:8,localProviderActive:1,interactiveActive:8};
 beforeAll(async()=>{
  process.env.AGENTS_SCHEDULING_POLICY_JSON=JSON.stringify(policy);
  admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;
  pool=new Pool({connectionString:url.href,max:4});await setupPlatformSchema(pool);store=new PlatformStore(pool);
 });
 afterAll(async()=>{if(originalPolicy===undefined)delete process.env.AGENTS_SCHEDULING_POLICY_JSON;else process.env.AGENTS_SCHEDULING_POLICY_JSON=originalPolicy;await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`);await admin.end();}});
 it('queues local work before its operation clock, permits models, and fences promotion and policy disagreement',async()=>{
  const account=await store.ensureAccount({issuer:'http://localhost/local-capacity',subject:randomUUID(),email:'fixture@example.test',displayName:'Fixture'}),org=await store.createOrganization(account.id,'Local capacity');
  await connectFixtureModel(pool,account.id,org.id);
  const config=defaultBusinessConfiguration(),agent=await store.createAgent({accountId:account.id,organizationId:org.id,name:'Fixture',configuration:config}),version=await store.createVersion({accountId:account.id,organizationId:org.id,agentId:agent.id,expectedRevision:1});
  const authority:AdmissionAuthority={product:'agents',organizationId:org.id,resourceId:agent.id,callerClientId:'agents-execution',principal:{kind:'human',issuer:account.issuer,subject:account.subject}};
  const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:['model.reply','knowledge.read'],maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,expiresAt:new Date(Date.now()+120000).toISOString(),revokedAt:null});await store.createGrant({accountId:account.id,grant});
  const a=(await store.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:'First'})).task,b=(await store.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:'Second'})).task;
  const local=(name='report.prepare')=>({id:randomUUID(),kind:'tool' as const,name,request:{fixture:'admission only; no report effect'},reservedTokens:0,reservedMs:60000}),first=local(),second=local();
  expect((await beginOperation(pool,a.id,first)).waiting).not.toBe(true);
  const queued=await beginOperation(pool,b.id,second);expect(queued).toMatchObject({waiting:true,capacity:{state:'waiting',generation:1}});
  if(!queued.waiting)throw Error('Expected owned local queue');
  expect((await pool.query('SELECT id FROM agents_platform.operations WHERE id=$1',[second.id])).rowCount).toBe(0);
  expect((await pool.query('SELECT active_reserved_ms,tokens_reserved FROM agents_platform.tasks WHERE id=$1',[b.id])).rows[0]).toEqual({active_reserved_ms:0,tokens_reserved:0});
  const model={id:randomUUID(),kind:'model' as const,name:'model.generate',request:{fixture:'admission only'},reservedTokens:100,reservedMs:1000};
  expect((await beginOperation(pool,b.id,model)).waiting).not.toBe(true);await finishOperation(pool,b.id,model.id,'completed','Fixture response',null,2);
  await finishOperation(pool,a.id,first.id,'completed',{fixture:true},null,0);await advanceCapacity(pool);
  const promoted=(await pool.query('SELECT state,generation,deadline_at FROM agents_platform.capacity_requests WHERE id=$1',[second.id])).rows[0];expect(promoted).toMatchObject({state:'granted',generation:1});expect(promoted.deadline_at.toISOString()).toBe(queued.capacity.deadline);
  const before=(await pool.query('SELECT clock_timestamp() AS instant')).rows[0].instant;
  const active=await beginOperation(pool,b.id,second);if(active.waiting)throw Error('Expected promoted local operation');
  expect(active.operation.reserved_ms).toBe(60000);expect(active.operation.started_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
  await finishOperation(pool,b.id,second.id,'completed',{fixture:true},null,0);
  process.env.AGENTS_SCHEDULING_POLICY_JSON=JSON.stringify({...policy,localProviderActive:2});
  const inconsistent=local();await expect(beginOperation(pool,b.id,inconsistent)).rejects.toMatchObject({code:'CAPACITY_POLICY_CONFLICT'});
  expect((await pool.query('SELECT id FROM agents_platform.operations WHERE id=$1',[inconsistent.id])).rowCount).toBe(0);
  process.env.AGENTS_SCHEDULING_POLICY_JSON=JSON.stringify(policy);
  const held=local(),revoked=local();await beginOperation(pool,a.id,held);expect((await beginOperation(pool,b.id,revoked)).waiting).toBe(true);
  await pool.query('UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1',[grant.id]);await finishOperation(pool,a.id,held.id,'completed',{fixture:true},null,0);await advanceCapacity(pool);
  expect((await pool.query('SELECT state,error_code FROM agents_platform.capacity_requests WHERE id=$1',[revoked.id])).rows[0]).toMatchObject({state:'rejected',error_code:'GRANT_REVOKED'});
  await expect(beginOperation(pool,b.id,revoked)).rejects.toMatchObject({code:'GRANT_REVOKED'});expect((await pool.query('SELECT id FROM agents_platform.operations WHERE id=$1',[revoked.id])).rowCount).toBe(0);

 });
});
