import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {Pool} from 'pg';
import Fastify from 'fastify';
import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {createAdminAuthority,ADMIN_AUTHORITY_HEADER} from '@kasitek-labs/server-support/admin-authority';
import {setupPlatformSchema} from '../src/composition/setup';
import {PlatformStore} from '../src/product/agents/store';
import {defaultBusinessConfiguration,PlatformError} from '../src/contracts/contracts';
import {connectFixtureModel} from './model-fixture';
import {AgentsCustomerOperations} from '../src/product/customers/service';
import {registerAdminCustomerRoutes} from '../src/product/customers/routes';
const parent=process.env.AGENTS_TEST_DATABASE_URL;
const environment={NODE_ENV:'test',KASITEK_CUSTOMER_OPERATIONS:'1',KASITEK_CUSTOMER_ACTIONS:'task.cancel,ingress.retry'};
const secret='admin-customer-authority-'.repeat(3), actorId='fixture-operator';
const database=`agents_customer_ops_${randomUUID().replaceAll('-','')}`;
describe.skipIf(!parent)('Agents admin customer operations on an isolated database',()=>{
 let admin:Pool,pool:Pool,store:PlatformStore,service:AgentsCustomerOperations,f:any,other:any,root:string,child:string,connection:string,deployment:string,ingress:string;
 let app:ReturnType<typeof Fastify>;
 async function fixture(){
  const account=await store.ensureAccount({issuer:'https://customer.fixture.test',subject:randomUUID(),email:'fixture@example.test',displayName:'Fixture'});
  const organization=await store.createOrganization(account.id,'Customer fixture'),scope={accountId:account.id,organizationId:organization.id};
  await connectFixtureModel(pool,account.id,organization.id);
  const agent=await store.createAgent({...scope,name:'PRIVATE_NAME',configuration:defaultBusinessConfiguration()});
  const version=await store.createVersion({...scope,agentId:agent.id,expectedRevision:1});
  const grant=randomUUID(),conversation=randomUUID(),principal={kind:'human',issuer:'https://customer.fixture.test',subject:account.id};
  await pool.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,max_input_bytes,max_output_tokens,expires_at) VALUES($1,'agents',$2,$3,'fixture',$4,$5,'["model.reply"]',8192,1024,now()+interval '1 hour')`,[grant,organization.id,agent.id,principal,version.id]);
  await pool.query(`INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal) VALUES($1,$2,$3,$4)`,[conversation,organization.id,agent.id,principal]);
  return {...scope,agentId:agent.id,versionId:version.id,grant,conversation,principal};
 }
 async function task(parentId?:string,state='running'){
  const id=randomUUID();
  await pool.query(`INSERT INTO agents_platform.tasks(id,product,organization_id,resource_id,caller_client_id,principal,version_id,grant_id,conversation_id,request_key,request_digest,input,state,effective_composition,root_task_id,parent_task_id,depth,turn_sequence)
   VALUES($1,'agents',$2,$3,'fixture',$4,$5,$6,$7,$13,$8,'PRIVATE_PROMPT',$9,(SELECT effective_composition FROM agents_platform.agent_versions WHERE id=$5),$10,$11,$12,(SELECT coalesce(max(turn_sequence),0)+1 FROM agents_platform.tasks WHERE conversation_id=$7))`,[id,f.organizationId,f.agentId,f.principal,f.versionId,f.grant,f.conversation,'a'.repeat(64),state,parentId??id,parentId??null,parentId?1:0,id]);
  return id;
 }
 beforeAll(async()=>{
  admin=new Pool({connectionString:parent});await admin.query(`CREATE DATABASE "${database}"`);
  const url=new URL(parent!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);store=new PlatformStore(pool);service=new AgentsCustomerOperations(pool,environment);
  f=await fixture();other=await fixture();root=await task();child=await task(root);await task(root,'uncertain');
  connection=randomUUID();deployment=randomUUID();ingress=randomUUID();
  await pool.query(`INSERT INTO agents_platform.channel_connections(id,organization_id,created_by,kind,name,asset_id,mode,state,metadata) VALUES($1,$2,$3,'telegram','Fixture channel','fixture-bot','bot','active','{"private":"PRIVATE_SECRET"}')`,[connection,f.organizationId,f.accountId]);
  await pool.query(`INSERT INTO agents_platform.channel_deployments(id,organization_id,connection_id,agent_id,version_id,created_by) VALUES($1,$2,$3,$4,$5,$6)`,[deployment,f.organizationId,connection,f.agentId,f.versionId,f.accountId]);
  await pool.query(`INSERT INTO agents_platform.channel_ingress(id,organization_id,connection_id,deployment_id,event_id,digest,event,state) VALUES($1,$2,$3,$4,'fixture-event','fixture-digest','{"body":"PRIVATE_MESSAGE"}','quarantined')`,[ingress,f.organizationId,connection,deployment]);
  await pool.query(`INSERT INTO agents_platform.website_deployments(id,organization_id,agent_id,version_id,allowed_origins,published_by) VALUES($1,$2,$3,$4,'["https://fixture.example.test"]',$5)`,[deployment,f.organizationId,f.agentId,f.versionId,f.accountId]);
  app=Fastify();app.setErrorHandler((error,_,reply)=>reply.code(error.statusCode??500).send({error:error instanceof PlatformError?error.code:'ERROR'}));registerAdminCustomerRoutes(app,pool,secret,environment);await app.ready();
 },30000);
 afterAll(async()=>{await app?.close();await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}"`);await admin.end();}});
 const cancel=()=>({operationId:randomUUID(),action:'task.cancel' as const,label:'Request cancellation',targetId:root,expected:{state:'running',generation:'0'},reason:'Investigate stalled fixture'});
 const retry=()=>({operationId:randomUUID(),action:'ingress.retry' as const,label:'Retry ingress',targetId:connection,expected:{revision:'1'},selection:[ingress],reason:'Recover quarantined fixture'});
 function headers(path:string,method='GET',body?:unknown,role='operator'){
  return {[ADMIN_AUTHORITY_HEADER]:createAdminAuthority({secret,audience:'agents',actor:{id:actorId,role},method,path,body:body===undefined?'':JSON.stringify(body),capability:method==='GET'?'admin:read':'admin:operate'})};
 }
 it('requires exact signed scope, body, role and one-use transport authority',async()=>{
  const path=`/api/admin/customers/${f.organizationId}`;
  expect((await app.inject({url:path})).statusCode).toBe(403);
  await pool.query(`INSERT INTO agents_platform.admin_customer_nonces(nonce,expires_at) VALUES('expired-fixture',now()-interval '1 hour')`);
  const auth=headers(path);expect((await app.inject({url:path,headers:auth})).statusCode).toBe(200);expect((await app.inject({url:path,headers:auth})).statusCode).toBe(403);
  expect((await pool.query(`SELECT nonce FROM agents_platform.admin_customer_nonces WHERE nonce='expired-fixture'`)).rowCount).toBe(0);
  expect((await app.inject({url:path,headers:headers(path+'?limit=1')})).statusCode).toBe(403);
  const post=path+'/operations',body=cancel();
  expect((await app.inject({url:post,method:'POST',headers:{...headers(post,'POST',body),'content-type':'application/json'},payload:JSON.stringify(body,null,2)})).statusCode).toBe(403);
  const forged={...body,reason:'Changed reason'};
  expect((await app.inject({url:post,method:'POST',headers:headers(post,'POST',body),payload:forged})).statusCode).toBe(403);
  const readToken=headers(post,'GET',body,'viewer');expect((await app.inject({url:post,method:'POST',headers:readToken,payload:body})).statusCode).toBe(403);
 });
 it('projects safe bounded metadata with truthful quota/plan availability',async()=>{
  const overview=await service.overview(f.organizationId),serialized=JSON.stringify(overview);
  for(const forbidden of ['PRIVATE_PROMPT','PRIVATE_MESSAGE','PRIVATE_SECRET','principal','input','draft','credential'])expect(serialized).not.toContain(forbidden);
  expect(overview.sections.find(s=>s.id==='usage')?.status).toBe('unavailable');expect(overview.sections.find(s=>s.id==='plan')?.status).toBe('unsupported');
  const page=await service.section(f.organizationId,'tasks',1);expect(page.records).toHaveLength(1);expect(page.nextCursor).toBeTruthy();
  const next=await service.section(f.organizationId,'tasks',1,page.nextCursor);expect(next.records[0]!.id).not.toBe(page.records[0]!.id);
  await expect(service.section(f.organizationId,'tasks',1,'not-a-cursor')).rejects.toMatchObject({code:'INVALID_CURSOR'});
  expect((await service.section(other.organizationId,'tasks')).records).toEqual([]);
  const deployed=await service.section(f.organizationId,'deployments',1);const second=await service.section(f.organizationId,'deployments',1,deployed.nextCursor);
  expect(deployed.records[0]!.id).toBe('channel:'+deployment);expect(second.records[0]!.id).toBe('website:'+deployment);
 });
 it('previews without changing task state and rejects substituted customer targets',async()=>{
  expect((await service.preview(f.organizationId,cancel())).eligible).toBe(true);
  expect((await pool.query('SELECT state FROM agents_platform.tasks WHERE id=$1',[root])).rows[0].state).toBe('running');
  const rejected=await service.execute(other.organizationId,actorId,cancel());expect(rejected.status).toBe('rejected');expect(rejected.code).toBe('TARGET_NOT_FOUND');
 });
 it('atomically records one cancellation intent, preserves terminal children and idempotency',async()=>{
  const command=cancel();const [first,replay]=await Promise.all([service.execute(f.organizationId,actorId,command),service.execute(f.organizationId,actorId,command)]);
  expect(first.id).toBe(replay.id);expect(first.status).toBe('pending');
  expect((await pool.query('SELECT state FROM agents_platform.tasks WHERE id=$1',[child])).rows[0].state).toBe('cancel_requested');
  expect((await pool.query("SELECT count(*)::int AS n FROM agents_platform.tasks WHERE root_task_id=$1 AND state='uncertain'",[root])).rows[0].n).toBe(1);
  expect((await service.lookup(f.organizationId,first.id)).status).toBe('pending');
  await expect(service.execute(f.organizationId,'different-actor',command)).rejects.toMatchObject({code:'OPERATION_CONFLICT'});
  await expect(service.execute(f.organizationId,actorId,{...command,reason:'A changed reason'})).rejects.toMatchObject({code:'OPERATION_CONFLICT'});
  await pool.query("UPDATE agents_platform.tasks SET state='cancelled' WHERE root_task_id=$1 AND state='cancel_requested'",[root]);
  expect((await service.lookup(f.organizationId,first.id)).status).toBe('unknown');
 });
 it('selected ingress retry queues only once, checks active deployment and never resends outbound',async()=>{
  const command=retry();expect((await service.preview(f.organizationId,command)).eligible).toBe(true);
  const first=await service.execute(f.organizationId,actorId,command);expect(first.status).toBe('pending');
  await pool.query("UPDATE agents_platform.channel_ingress SET state='completed' WHERE id=$1",[ingress]);
  expect((await service.execute(f.organizationId,actorId,command)).id).toBe(first.id);
  expect((await service.lookup(f.organizationId,first.id)).status).toBe('confirmed');
  expect((await service.execute(f.organizationId,actorId,retry())).code).toBe('STALE_STATE');
  expect((await pool.query('SELECT count(*)::int AS n FROM agents_platform.channel_outbound')).rows[0].n).toBe(0);
 });
 it('rolls back receipt and intent together if event persistence fails',async()=>{
  const target=await task();
  await pool.query(`CREATE FUNCTION agents_platform.reject_admin_fixture_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture event failure'; END; $$`);
  await pool.query(`CREATE TRIGGER reject_admin_fixture_event BEFORE INSERT ON agents_platform.task_events FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_admin_fixture_event()`);
  const command={...cancel(),targetId:target};
  try{await expect(service.execute(f.organizationId,actorId,command)).rejects.toThrow('fixture event failure');}
  finally{await pool.query('DROP TRIGGER reject_admin_fixture_event ON agents_platform.task_events');}
  expect((await pool.query('SELECT state FROM agents_platform.tasks WHERE id=$1',[target])).rows[0].state).toBe('running');
  expect((await pool.query('SELECT id FROM agents_platform.admin_customer_operations WHERE id=$1',[command.operationId])).rowCount).toBe(0);
 });
 it('upgrades only a verified preceding schema and preserves existing customer state',async()=>{
  const directory=join(__dirname,'../schema'),files=(await readdir(directory)).filter(name=>/^\d+_[a-z_]+\.sql$/.test(name)).sort();
  const previous=(await Promise.all(files.slice(0,files.indexOf('069_admin_customers.sql')).map(name=>readFile(join(directory,name),'utf8')))).join('\n');
  const upgradeDatabase=`agents_upgrade_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE DATABASE "${upgradeDatabase}"`);
  const url=new URL(parent!);url.pathname=`/${upgradeDatabase}`;
  const upgradePool=new Pool({connectionString:url.href});
  try {
   await upgradePool.query(previous);
   await upgradePool.query("CREATE TABLE agents_platform.schema_version(version text PRIMARY KEY,checksum text NOT NULL)");
   await upgradePool.query("INSERT INTO agents_platform.schema_version VALUES('001_platform',$1)",[createHash('sha256').update(previous).digest('hex')]);
   const priorStore=new PlatformStore(upgradePool);
   const owner=await priorStore.ensureAccount({issuer:'https://upgrade.fixture.test',subject:randomUUID(),email:'upgrade@example.test',displayName:'Existing customer'});
   const organization=await priorStore.createOrganization(owner.id,'Existing organisation');
   await setupPlatformSchema(upgradePool);await setupPlatformSchema(upgradePool);
   expect((await upgradePool.query('SELECT name FROM agents_platform.organizations WHERE id=$1',[organization.id])).rows[0].name).toBe('Existing organisation');
   expect((await upgradePool.query('SELECT id FROM agents_platform.admin_customer_operations')).rowCount).toBe(0);
  } finally {
   await upgradePool.end();await admin.query(`DROP DATABASE "${upgradeDatabase}"`);
  }
 });
 it('hides evaluation channel fixtures and ignores malformed execution mappings',async()=>{
  const trial=randomUUID();
  await pool.query(`INSERT INTO agents_platform.evaluation_trials(id,trial_id,organization_id,account_id,agent_id,version_id,composition_digest,max_tokens,request_digest,expires_at,model_routes,model_routes_digest,root_token_limit) VALUES($1,'metadata-exclusion',$2,$3,$4,$5,$6,10000,$6,now()+interval '1 hour','{}',$6,10000)`,[trial,f.organizationId,f.accountId,f.agentId,f.versionId,'a'.repeat(64)]);
  await pool.query(`INSERT INTO agents_platform.evaluation_trial_messaging_channels(trial_id,organization_id,connection_id,deployment_id,kind,mode,asset_id,request_digest,fixture) VALUES($1,$2,$3,$4,'telegram','bot','fixture-bot',$5,'{}')`,[trial,f.organizationId,connection,deployment,'a'.repeat(64)]);
  await pool.query("UPDATE agents_platform.channel_ingress SET state='quarantined' WHERE id=$1",[ingress]);
  expect((await service.section(f.organizationId,'channels')).records).toEqual([]);
  expect((await service.section(f.organizationId,'ingress')).records).toEqual([]);
  expect((await service.section(f.organizationId,'deployments')).records.map(row=>row.id)).toEqual(['website:'+deployment]);
  expect((await service.execute(f.organizationId,actorId,retry())).code).toBe('STALE_STATE');
  await pool.query(`INSERT INTO agents_platform.product_execution_tenants(product,tenant_id,organization_id,client_id,issuer) VALUES('growth','invalid-issuer',$1,'growth','')`,[other.organizationId]);
  expect((await service.overview(other.organizationId)).relationships).toEqual([]);
  expect((await service.relationships('growth','invalid-issuer')).relationships).toEqual([]);
 });
 it('disabled actions preserve receipt access and revoked mapping cannot be operated',async()=>{
  await pool.query(`INSERT INTO agents_platform.product_execution_tenants(product,tenant_id,organization_id,client_id,issuer,revoked_at) VALUES('growth','fixture-growth',$1,'growth','https://fixture.test',now())`,[f.organizationId]);
  const overview=await service.overview(f.organizationId);expect(overview.relationships[0]!.state).toBe('revoked');
  const path='/api/admin/customer-links/growth/fixture-growth';const links=await app.inject({url:path,headers:headers(path)});expect(links.statusCode).toBe(200);expect(links.json().relationships[0].state).toBe('revoked');
  expect((await service.relationships('agency','fixture-growth')).relationships).toEqual([]);
  await expect(service.relationships('agents','fixture-growth')).rejects.toMatchObject({code:'INVALID_CUSTOMER'});
  expect((await service.execute(f.organizationId,actorId,retry())).code).toBe('MAPPING_REVOKED');
  const disabled=new AgentsCustomerOperations(pool,{...environment,KASITEK_CUSTOMER_ACTIONS:''});expect((await disabled.execute(f.organizationId,actorId,retry())).code).toBe('ACTION_DISABLED');
  await expect(service.execute(f.organizationId,actorId,{...retry(),action:'webhook.replay'})).rejects.toMatchObject({code:'ACTION_UNSUPPORTED'});
 });
});
