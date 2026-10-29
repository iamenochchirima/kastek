import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer,type ServerHttp2Session } from 'node:http2';
import { createEndpointHandler } from '@restatedev/restate-sdk';
import { Pool } from 'pg';
import { beforeAll,afterAll,describe,expect,it } from 'vitest';
import { setupPlatformSchema } from '../src/composition/setup';
import { defaultBusinessConfiguration } from '../src/contracts/contracts';
import { HANDOFF_HARNESS_RELEASE,HANDOFF_WORKFLOW_NAME } from '../src/contracts/execution';
import { PlatformStore } from '../src/product/agents/store';
import { composeInbox } from '../src/composition/inbox';
import { createBusinessWorkflow } from '../src/execution/business/business';
import { EvidenceStore } from '../src/execution/context/evidence';
import { dispatchBoundModel } from '../src/execution/models/dispatch';
import type { ModelFetch } from '../src/infrastructure/model-network';
import { HANDOFF_RECEIPT } from '../src/product/inbox/handoff-receipt';
import { settleReceipt } from '../src/product/inbox/handoff-pending-receipt';
import { connectFixtureModel,fixtureModelProviders } from './model-fixture';
import { dropClosedTestDatabase } from './support/database-cleanup';

const enabled=process.env.AGENTS_TEST_DATABASE_URL && process.env.AGENTS_HANDOFF_MODEL_RUNTIME==='1';
(enabled?describe:describe.skip)('isolated V22 controlled handoff model',()=>{
 const database=`agents_handoff_model_${randomUUID().replaceAll('-','')}`,container=`agents-handoff-model-${randomUUID()}`;
 const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:60000}).trim();
 let admin:Pool,pool:Pool,server:ReturnType<typeof createServer>,started=false,ingress='',runtimeAdmin='',calls=0;
 const sessions=new Set<ServerHttp2Session>();
 const eventually=async(check:()=>Promise<boolean>)=>{const deadline=Date.now()+30000;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,60));}throw Error('Model fixture timed out');};
 beforeAll(async()=>{
  admin=new Pool({connectionString:process.env.AGENTS_TEST_DATABASE_URL});await admin.query(`CREATE DATABASE "${database}"`);
  const url=new URL(process.env.AGENTS_TEST_DATABASE_URL!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href,max:15});await setupPlatformSchema(pool);
  const inbox=composeInbox(pool,{publicOrigin:'https://customer.test',followupAccessEnabled:true,assertServices:async()=>{}}), evidence=new EvidenceStore(pool);
  const workflow=createBusinessWorkflow(pool,{evidence,modelProvider:fixtureModelProviders(pool),settleHandoffReceipt:(taskId,candidate,failed)=>settleReceipt(pool,taskId,candidate?{text:candidate}:null,HANDOFF_RECEIPT,(db,input)=>inbox.publishPendingHandoffReceipt(db,input),failed),
    modelRuntime:{dispatch:input=>dispatchBoundModel(input,policy=>{const network=(async(url,init)=>{if(!policy.authorizeUrl(new URL(String(url))))throw Error('fixture destination denied');await policy.beforeDispatch?.();calls++;const body=JSON.parse(String(init?.body));const message=calls===1?{role:'assistant',content:null,tool_calls:[{index:0,id:'handoff-call',type:'function',function:{name:'support_request_handoff_v2',arguments:JSON.stringify({reason:'Human requested',brief:'Customer requested a person'})}}]}:{role:'assistant',content:'I have passed your request to the support team.'};const delta={id:'fixture',model:body.model,choices:[{index:0,delta:message,finish_reason:calls===1?'tool_calls':'stop'}],usage:{prompt_tokens:80,completion_tokens:20}};return new Response(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});}) as ModelFetch;network.markProgress=()=>{};return network;})}}, {release:HANDOFF_HARNESS_RELEASE,workflow:HANDOFF_WORKFLOW_NAME});
  server=createServer(createEndpointHandler({services:[workflow]}));server.on('session',session=>{sessions.add(session);session.once('close',()=>sessions.delete(session));});await new Promise<void>(resolve=>server.listen(0,'0.0.0.0',resolve));
  docker('run','-d','--name',container,'--cpus','1','--memory','768m','--add-host','host.docker.internal:host-gateway','-p','127.0.0.1::8080','-p','127.0.0.1::9070','docker.restate.dev/restatedev/restate:1.7.13');started=true;
  ingress=`http://${docker('port',container,'8080/tcp')}`;runtimeAdmin=`http://${docker('port',container,'9070/tcp')}`;await eventually(async()=>{try{return(await fetch(`${runtimeAdmin}/health`)).ok;}catch{return false;}});
  const reg=await fetch(`${runtimeAdmin}/deployments`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uri:`http://host.docker.internal:${(server.address() as {port:number}).port}`,force:false})});expect(reg.ok,await reg.text()).toBe(true);
 },90000);
 afterAll(async()=>{for(const session of sessions)session.destroy();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));if(started)docker('rm','-f',container);await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}},30000);
 it('commits the handoff before a separately authorized model response and publishes one receipt',async()=>{
  const store=new PlatformStore(pool),account=await store.ensureAccount({issuer:'https://fixture.test',subject:randomUUID(),email:'fixture@example.test',displayName:'Fixture'}),org=await store.createOrganization(account.id,'Fixture');await connectFixtureModel(pool,account.id,org.id);
  const configuration=defaultBusinessConfiguration();configuration.program={id:'grounded-conversation',version:'1'};configuration.tools=['channel.request_handoff','support.request_handoff_v2'];
  const agent=await store.createAgent({accountId:account.id,organizationId:org.id,name:'Support',configuration}),version=await store.createVersion({accountId:account.id,organizationId:org.id,agentId:agent.id,expectedRevision:1});
  const deployment=await store.publishWebsite({accountId:account.id,organizationId:org.id,agentId:agent.id,versionId:version.id,allowedOrigins:['https://customer.test']});
  const sessionId=randomUUID();await pool.query('INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)',[sessionId,deployment.id,createHash('sha256').update(randomBytes(32)).digest('hex'),'https://customer.test']);
  const inbox=composeInbox(pool,{publicOrigin:'https://customer.test',followupAccessEnabled:true,assertServices:async()=>{}}),visitor={deploymentId:deployment.id,sessionId},conversation=await inbox.open(visitor),incoming=await inbox.ingress(visitor,conversation.id,{requestKey:randomUUID(),body:'Can I speak to a person?'}),taskId=incoming.message.task_id!;
  const invocation=await fetch(`${ingress}/restate/send/${HANDOFF_WORKFLOW_NAME}/${taskId}/run`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId})});expect(invocation.ok,await invocation.text()).toBe(true);
  await eventually(async()=>Boolean((await pool.query('SELECT 1 FROM agents_platform.pending_handoff_receipts WHERE task_id=$1 AND outcome IS NOT NULL',[taskId])).rowCount));
  const receipt=(await pool.query('SELECT outcome FROM agents_platform.pending_handoff_receipts WHERE task_id=$1',[taskId])).rows[0];expect(receipt.outcome).toBe('model');expect(calls).toBe(2);
  expect((await pool.query("SELECT state FROM agents_platform.customer_conversations WHERE id=$1",[conversation.id])).rows[0].state).toBe('handoff_pending');
  expect((await pool.query("SELECT count(*)::int count FROM agents_platform.customer_messages WHERE conversation_id=$1 AND request_key=$2",[conversation.id,`handoff-receipt:${taskId}`])).rows[0].count).toBe(1);
  const transcript=await inbox.readVisitor(visitor,conversation.id);expect(transcript.messages.at(-1)?.body).toBe('I have passed your request to the support team.');
  const operations=(await pool.query('SELECT name,state FROM agents_platform.operations WHERE task_id=$1 ORDER BY started_at',[taskId])).rows;expect(operations).toContainEqual({name:'model.handoff_feedback',state:'completed'});
  const accounting=(await pool.query('SELECT accounted_tokens FROM agents_platform.operations WHERE id=$1',[`handoff-feedback:${taskId}`])).rows[0];expect(Number(accounting.accounted_tokens)).toBeGreaterThan(0);
 },60000);
});
