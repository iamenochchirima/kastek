import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import Fastify from 'fastify';
import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {createAdminAuthority,ADMIN_AUTHORITY_HEADER} from '@kasitek-labs/server-support/admin-authority';
import {setupPlatformSchema} from '../src/composition/setup';
import {PlatformStore} from '../src/product/agents/store';
import {defaultBusinessConfiguration} from '../src/contracts/contracts';
import {connectFixtureModel} from './model-fixture';
import {agentsAdminReport} from '../src/product/reporting/source';
import {registerAdminReportingRoutes} from '../src/product/reporting/routes';
import {queueNativeAnalytics,nativeAnalyticsSettings} from '../src/product/reporting/native-analytics';
import {makeObservation} from '../src/observability/observations';
import type {AdminReportQuery,AdminProductReport} from '@kasitek-labs/contracts';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AnalyticsIngestionClient,publishOutboxOnce} from '@kasitek-labs/server-support/analytics-producer';
const parent=process.env.AGENTS_TEST_DATABASE_URL;
const database=`agents_admin_reporting_${randomUUID().replaceAll('-','')}`;
const stamp=new Date(Date.now()-60000),end=new Date(Date.now()+60000);
const query:AdminReportQuery={start:new Date(stamp.getTime()-60000).toISOString(),end:end.toISOString(),timezone:'UTC',page:1,pageSize:50};
const value=(report:AdminProductReport,key:string)=>report.metrics.filter(item=>item.key===key).reduce((sum,item)=>sum+BigInt(item.value??'0'),0n).toString();
describe.skipIf(!parent)('current Agents reporting and durable Analytics adapter',()=>{
 let admin:Pool,pool:Pool,store:PlatformStore,standalone:any,growth:any,root:string,child:string,evalTask:string;
 beforeAll(async()=>{
  admin=new Pool({connectionString:parent});await admin.query(`CREATE DATABASE "${database}"`);
  const url=new URL(parent!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);store=new PlatformStore(pool);
  async function fixture(product='agents'){
   const account=await store.ensureAccount({issuer:'https://identity.example.test',subject:randomUUID(),email:'owner@example.test',displayName:'Fixture owner'});
   const organization=await store.createOrganization(account.id,'Reporting');const scope={accountId:account.id,organizationId:organization.id};await connectFixtureModel(pool,account.id,organization.id);
   const agent=await store.createAgent({...scope,name:'FAQ',configuration:defaultBusinessConfiguration()});const version=await store.createVersion({...scope,agentId:agent.id,expectedRevision:1});
   const grant=randomUUID(),conversation=randomUUID(),principal={kind:'human',issuer:'https://identity.example.test',subject:account.id};
   if(product!=='agents')await pool.query('INSERT INTO agents_platform.product_execution_tenants(product,tenant_id,organization_id,client_id,issuer) VALUES($1,$2,$3,\'growth\',\'https://issuer.example.test\')',[product,'verified-growth-org',organization.id]);
   await pool.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,max_input_bytes,max_output_tokens,expires_at) VALUES($1,$2,$3,$4,'fixture',$5,$6,'["model.reply"]',8192,1024,now()+interval '1 hour')`,[grant,product,organization.id,agent.id,principal,version.id]);
   await pool.query('INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal,created_at) VALUES($1,$2,$3,$4,$5)',[conversation,organization.id,agent.id,principal,stamp]);
   return {...scope,agentId:agent.id,versionId:version.id,grant,conversation,principal,product};
  }
  standalone=await fixture();growth=await fixture('growth');
  async function task(f:any,state:string,parentId?:string,trial?:string){
   const id=randomUUID();await pool.query(`INSERT INTO agents_platform.tasks(id,product,organization_id,resource_id,caller_client_id,principal,version_id,grant_id,conversation_id,request_key,request_digest,input,state,effective_composition,root_task_id,parent_task_id,depth,created_at,updated_at,evaluation_trial_id,turn_sequence)
    VALUES($1,$2,$3,$4,'fixture',$5,$6,$7,$8,$16,$9,'PRIVATE_REPORTING_INPUT',$10,(SELECT effective_composition FROM agents_platform.agent_versions WHERE id=$6),$11,$12,$13,$14,$14,$15,(SELECT coalesce(max(turn_sequence),0)+1 FROM agents_platform.tasks WHERE conversation_id=$8))`,[id,f.product,f.organizationId,f.agentId,f.principal,f.versionId,f.grant,f.conversation,'a'.repeat(64),state,parentId??id,parentId??null,parentId?1:0,stamp,trial??null,id]);
   return id;
  }
  root=await task(standalone,'completed');child=await task(standalone,'completed',root);await task(standalone,'running');await task(growth,'failed');
  const trial=randomUUID();await pool.query(`INSERT INTO agents_platform.evaluation_trials(id,trial_id,organization_id,account_id,agent_id,version_id,composition_digest,max_tokens,request_digest,expires_at,model_routes,model_routes_digest,root_token_limit) VALUES($1,'synthetic-report-exclusion',$2,$3,$4,$5,$6,10000,$6,now()+interval '1 hour','{}',$6,10000)`,[trial,standalone.organizationId,standalone.accountId,standalone.agentId,standalone.versionId,'a'.repeat(64)]);
  evalTask=await task(standalone,'failed',undefined,trial);
  await pool.query('INSERT INTO agents_platform.execution_roots(root_task_id,settled_at) VALUES($1,$2)',[root,new Date(stamp.getTime()+1000)]);
  await pool.query('INSERT INTO agents_platform.root_model_accounts(root_task_id,organization_id) VALUES($1,$2)',[root,standalone.organizationId]);
  await pool.query('INSERT INTO agents_platform.task_outbox(task_id,attempts,created_at) VALUES($1,3,$2)',[root,stamp]);
  for(const [id,taskId,input,output,cost] of [['model-root',root,100,20,1000],['model-child',child,50,10,500],['model-unknown',child,null,null,null]] as const){
   const usage=input===null?{observed:false}:{observed:true,inputTokens:input,outputTokens:output};
   await pool.query(`INSERT INTO agents_platform.operations(id,task_id,kind,name,request_digest,request,state,output,reserved_ms,attempt_id,started_at,completed_at) VALUES($1,$2,'model','primary',$3,'{}','completed',$4,1,$5,$6,$7)`,[id,taskId,'a'.repeat(64),{usage,privateProviderPayload:'PRIVATE_PROVIDER_PAYLOAD'},randomUUID(),stamp,new Date(stamp.getTime()+1000)]);
   await pool.query(`INSERT INTO agents_platform.model_cost_reservations(operation_id,organization_id,root_task_id,task_id,reserved_micros,state,outcome,actual_micros,settled_at) VALUES($1,$2,$3,$4,0,$5,'completed',$6,$7)`,[id,standalone.organizationId,root,taskId,cost===null?'unknown':'settled',cost,new Date(stamp.getTime()+1000)]);
  }
  for(const id of [root,child])await pool.query('INSERT INTO agents_platform.task_model_routes(task_id,organization_id,routes,snapshot_digest) VALUES($1,$2,$3,$4)',[id,standalone.organizationId,{primary:{binding:{providerId:'openrouter',modelId:'fixture-model'}}},'a'.repeat(64)]);
 },30000);
 afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);await admin.end();}});
 it('reconciles roots, children, usage, unknown costs, retry evidence and product identity',async()=>{
  const all=await agentsAdminReport(pool,query);
  expect(value(all,'runs')).toBe('3');expect(value(all,'child_tasks')).toBe('1');expect(value(all,'failed')).toBe('1');expect(value(all,'backlog')).toBe('1');
  expect(value(all,'tokens_input')).toBe('150');expect(value(all,'tokens_output')).toBe('30');expect(value(all,'model_cost')).toBe('1500');expect(value(all,'unknown_model_operations')).toBe('1');expect(value(all,'dispatch_retries')).toBe('2');
  expect(all.metrics.find(m=>m.key==='model_cost')?.availability).toBe('partial');
  expect(value(all,'organizations')).toBe('1');expect(value(all,'memberships')).toBe('1');expect(value(all,'agents')).toBe('1');
  expect(all.records.some(item=>item.id===evalTask)).toBe(false);expect(JSON.stringify(all)).not.toContain('PRIVATE_');
  const selected=await agentsAdminReport(pool,{...query,consumer:'growth',organizationId:'verified-growth-org'});expect(value(selected,'runs')).toBe('1');expect(selected.records[0]?.organizationId).toBe('verified-growth-org');
  const wrong=await agentsAdminReport(pool,{...query,consumer:'growth',organizationId:growth.organizationId});expect(value(wrong,'runs')).toBe('0');
 });
 it('authenticates the metadata-only HTTP source and rejects query tampering',async()=>{
  const app=Fastify();const secret='synthetic-reporting-service-secret-32bytes';registerAdminReportingRoutes(app,pool,secret);
  const path=`/api/admin/reporting?start=${encodeURIComponent(query.start)}&end=${encodeURIComponent(query.end)}&timezone=UTC`;
  const token=createAdminAuthority({secret,audience:'agents',actor:{id:'viewer-admin',role:'viewer'},method:'GET',path});
  expect((await app.inject({url:path})).statusCode).toBe(403);const res=await app.inject({url:path,headers:{[ADMIN_AUTHORITY_HEADER]:token}});expect(res.statusCode,res.body).toBe(200);expect(JSON.stringify(res.json())).not.toContain('PRIVATE_');
  expect((await app.inject({url:path+'&consumer=growth',headers:{[ADMIN_AUTHORITY_HEADER]:token}})).statusCode).toBe(403);await app.close();
 });
 it('materializes safe native root/model observations once and excludes evaluation tasks',async()=>{
  const f=standalone;
  async function event(taskId:string,key:string,kind:string,operationId:string|null=null){
   const identity={product:'agents' as const,organizationId:f.organizationId,agentId:f.agentId,versionId:f.versionId,programId:'fixture',programVersion:'1',runtimeRelease:'fixture',conversationId:f.conversation,rootTaskId:root,parentTaskId:taskId===child?root:null,taskId,operationId,attemptId:null};
   const observation=makeObservation({identity,eventKey:key,kind,occurredAt:stamp.toISOString()});
   await pool.query('INSERT INTO agents_platform.task_events(task_id,event_key,kind,observation) VALUES($1,$2,$3,$4)',[taskId,key,kind,observation]);
  }
  await event(root,'report:completed','completed');await event(child,'report:completed','completed');await event(evalTask,'report:eval','failed');
  await event(root,'report:model','model.completed','model-root');await event(child,'report:model','model.completed','model-child');await event(child,'report:model-replay','model.completed','model-child');await event(child,'report:unknown','model.completed','model-unknown');
  expect(await queueNativeAnalytics(pool,1)).toBe(1);expect(await queueNativeAnalytics(pool)).toBe(5);expect(await queueNativeAnalytics(pool)).toBe(0);
  const rows=(await pool.query('SELECT contract_name,envelope FROM analytics_outbox ORDER BY source_sequence')).rows;
  const metrics=rows.filter(row=>row.contract_name==='agent.native.execution.metric@1').map(row=>row.envelope.data);
  expect(metrics.filter(row=>row.metric_key==='agent.native.root_tasks.completed').length).toBe(1);
  expect(metrics.filter(row=>row.metric_key==='agent.native.model.input_tokens').reduce((sum,row)=>sum+row.numeric_value,0)).toBe(150);
  expect(metrics.filter(row=>row.metric_key==='agent.native.model.unknown_usage').length).toBe(1);
  expect(rows[0].contract_name).toBe('agent.scope.definition@1');expect(rows[0].envelope.scope_kind).toBe('agents_organization');expect(JSON.stringify(rows)).not.toContain('PRIVATE_');
 });
 it.skipIf(!process.env.ANALYTICS_SERVICE_DIST)('publishes native outbox records through HTTP and projects totals without replay inflation',async()=>{
  // This integration consumes the built service artifact, like the shared producer
  // fixture in Analytics. Production code never imports another service's source.
  const artifact=resolve(process.env.ANALYTICS_SERVICE_DIST!);
  const load=(name:string)=>import(pathToFileURL(resolve(artifact,`${name}.js`)).href);
  const [{run},{readConfig},{buildApp},{ProcessMetrics},{loadRegistry},{processOnce}]=await Promise.all(['migrations','config','app','metrics','registry','projections'].map(load));
  const analyticsDatabase=`agents_reporting_sink_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE DATABASE "${analyticsDatabase}"`);
  const url=new URL(parent!);url.pathname=`/${analyticsDatabase}`;
  const sink=new Pool({connectionString:url.href});
  let app:any;
  try {
   await run(sink);
   const token='synthetic-native-ingestion-key';
   const config=readConfig({ANALYTICS_DATABASE_URL:url.href,ANALYTICS_INGESTION_CREDENTIALS_JSON:JSON.stringify([{source_service:'agent-platform',producer_id:'agent-platform-customer-analytics',token}])});
   const registry=await loadRegistry();
   app=await buildApp({pool:sink,config,registry,metrics:new ProcessMetrics()},'analytics-api',{logger:false});
   await app.listen({host:'127.0.0.1',port:0});
   const endpoint=`http://127.0.0.1:${app.server.address().port}`;
   const client=new AnalyticsIngestionClient(endpoint,token,5000);
   const settings={endpoint,token,producer_id:'agent-platform-customer-analytics',publisher_id:'native-integration',batch_size:100,lease_duration_ms:30000,request_timeout_ms:5000};
   await publishOutboxOnce(pool,client,settings);
   expect((await pool.query("SELECT count(*)::int AS n FROM analytics_outbox WHERE delivery_status <> 'delivered'")).rows[0].n).toBe(0);
   const outbox=(await pool.query('SELECT * FROM analytics_outbox ORDER BY source_sequence')).rows;
   const replay=await client.sendBatch(settings.producer_id,outbox);
   expect(replay.duplicate_count).toBe(outbox.length);expect(replay.rejected_count).toBe(0);
   for(let count=0;count<100 && await processOnce(sink,registry,'native-fixture',30000);count++){}
   const totals=async()=>(await sink.query(`SELECT metric_key,sum(value_sum)::text AS value FROM analytics.analytics_projection_rollup WHERE interval='hour' GROUP BY metric_key ORDER BY metric_key`)).rows;
   const first=await totals();
   expect(first.find((row:any)=>row.metric_key==='agent.native.root_tasks.completed')?.value).toBe('1');
   expect(first.find((row:any)=>row.metric_key==='agent.native.model.input_tokens')?.value).toBe('150');
   expect(first.find((row:any)=>row.metric_key==='agent.native.model.output_tokens')?.value).toBe('30');
   expect(first.find((row:any)=>row.metric_key==='agent.native.model.unknown_usage')?.value).toBe('1');
   expect((await sink.query("SELECT count(*)::int AS n FROM analytics.reporting_scope WHERE scope_kind='agents_organization' AND owning_source_service='agent-platform'")).rows[0].n).toBe(1);
   await client.sendBatch(settings.producer_id,outbox);
   for(let count=0;count<100 && await processOnce(sink,registry,'native-fixture',30000);count++){}
   expect(await totals()).toEqual(first);
  } finally {
   await app?.close();await sink.end();await admin.query(`DROP DATABASE "${analyticsDatabase}" WITH (FORCE)`);
  }
 },30000);
});
it('requires explicit paired Analytics publisher configuration and safe endpoints',()=>{
 expect(nativeAnalyticsSettings({})).toBeUndefined();
 expect(()=>nativeAnalyticsSettings({AGENTS_ANALYTICS_INGESTION_URL:'https://analytics.example.test'})).toThrow();
 expect(()=>nativeAnalyticsSettings({NODE_ENV:'production',AGENTS_ANALYTICS_INGESTION_URL:'http://localhost:3000',AGENTS_ANALYTICS_INGESTION_TOKEN:'fixture'})).toThrow();
 expect(()=>nativeAnalyticsSettings({AGENTS_ANALYTICS_INGESTION_URL:'https://user:secret@analytics.example.test',AGENTS_ANALYTICS_INGESTION_TOKEN:'fixture'})).toThrow();
 expect(nativeAnalyticsSettings({NODE_ENV:'development',AGENTS_ANALYTICS_INGESTION_URL:'http://127.0.0.1:3000',AGENTS_ANALYTICS_INGESTION_TOKEN:'fixture'})?.producer_id).toBe('agent-platform-customer-analytics');
});
