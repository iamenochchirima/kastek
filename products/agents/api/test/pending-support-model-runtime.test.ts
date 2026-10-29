import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer,type ServerHttp2Session } from 'node:http2';
import { createEndpointHandler } from '@restatedev/restate-sdk';
import { createSupportStatusWorkflow,SUPPORT_STATUS_WORKFLOW } from '../src/execution/business/support-status-business';
import { dispatchTasksOnce } from '../src/execution/lifecycle/dispatcher';
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
import { ChannelStore } from '../src/product/channels/channel-store';
import { ChannelDelivery } from '../src/product/channels/channel-delivery';
import { ConnectionVault } from '../src/infrastructure/vault';
import { transaction } from '../src/infrastructure/database';

const enabled=process.env.AGENTS_TEST_DATABASE_URL && process.env.AGENTS_STATUS_MODEL_RUNTIME==='1';
(enabled?describe:describe.skip)('isolated pending-support status model',()=>{
 const database=`agents_handoff_model_${randomUUID().replaceAll('-','')}`,container=`agents-handoff-model-${randomUUID()}`;
 const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:60000}).trim();
 let admin:Pool,pool:Pool,server:ReturnType<typeof createServer>,started=false,ingress='',runtimeAdmin='',calls=0,statusReply:string|null='Your request is still waiting for a human response.';
 const sessions=new Set<ServerHttp2Session>();
 const eventually=async(check:()=>Promise<boolean>)=>{const deadline=Date.now()+30000;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,60));}throw Error('Model fixture timed out');};
 beforeAll(async()=>{
  admin=new Pool({connectionString:process.env.AGENTS_TEST_DATABASE_URL});await admin.query(`CREATE DATABASE "${database}"`);
  const url=new URL(process.env.AGENTS_TEST_DATABASE_URL!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href,max:15});await setupPlatformSchema(pool);
  const inbox=composeInbox(pool,{publicOrigin:'https://customer.test',followupAccessEnabled:true,supportStatusEnabled:true,assertServices:async()=>{}}), evidence=new EvidenceStore(pool);
  const workflow=createBusinessWorkflow(pool,{evidence,modelProvider:fixtureModelProviders(pool),settleHandoffReceipt:(taskId,candidate,failed)=>settleReceipt(pool,taskId,candidate?{text:candidate}:null,HANDOFF_RECEIPT,(db,input)=>inbox.publishPendingHandoffReceipt(db,input),failed),
    modelRuntime:{dispatch:input=>dispatchBoundModel(input,policy=>{const network=(async(url,init)=>{if(!policy.authorizeUrl(new URL(String(url))))throw Error('fixture destination denied');await policy.beforeDispatch?.();calls++;const body=JSON.parse(String(init?.body));const message=calls===1?{role:'assistant',content:null,tool_calls:[{index:0,id:'handoff-call',type:'function',function:{name:'support_request_handoff_v2',arguments:JSON.stringify({reason:'Human requested',brief:'Customer requested a person'})}}]}:{role:'assistant',content:calls===2?'I have passed your request to the support team.':JSON.stringify({reply:'Your request is still waiting for a human response.'})};const delta={id:'fixture',model:body.model,choices:[{index:0,delta:message,finish_reason:calls===1?'tool_calls':'stop'}],usage:{prompt_tokens:80,completion_tokens:20}};return new Response(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});}) as ModelFetch;network.markProgress=()=>{};return network;})}}, {release:HANDOFF_HARNESS_RELEASE,workflow:HANDOFF_WORKFLOW_NAME});
  const statusWorkflow=createSupportStatusWorkflow(pool,{evidence,modelProvider:fixtureModelProviders(pool),publishSupportStatus:taskId=>inbox.publishSupportStatus(taskId),modelRuntime:{dispatch:input=>dispatchBoundModel(input,policy=>{const network=(async(url,init)=>{if(!policy.authorizeUrl(new URL(String(url))))throw Error('fixture destination denied');await policy.beforeDispatch?.();calls++;const body=JSON.parse(String(init?.body));const delta={id:'fixture',model:body.model,choices:[{index:0,delta:{role:'assistant',content:JSON.stringify({reply:statusReply})},finish_reason:'stop'}],usage:{prompt_tokens:80,completion_tokens:20}};return new Response(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});}) as ModelFetch;network.markProgress=()=>{};return network;})}});
  server=createServer(createEndpointHandler({services:[workflow,statusWorkflow]}));server.on('session',session=>{sessions.add(session);session.once('close',()=>sessions.delete(session));});await new Promise<void>(resolve=>server.listen(0,'0.0.0.0',resolve));
  docker('run','-d','--name',container,'--cpus','1','--memory','768m','--add-host','host.docker.internal:host-gateway','-p','127.0.0.1::8080','-p','127.0.0.1::9070','docker.restate.dev/restatedev/restate:1.7.13');started=true;
  ingress=`http://${docker('port',container,'8080/tcp')}`;runtimeAdmin=`http://${docker('port',container,'9070/tcp')}`;await eventually(async()=>{try{return(await fetch(`${runtimeAdmin}/health`)).ok;}catch{return false;}});
  const reg=await fetch(`${runtimeAdmin}/deployments`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uri:`http://host.docker.internal:${(server.address() as {port:number}).port}`,force:false})});expect(reg.ok,await reg.text()).toBe(true);
 },90000);
 afterAll(async()=>{for(const session of sessions)session.destroy();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));if(started)docker('rm','-f',container);await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}},30000);
 it('admits one bounded status-only turn and publishes a fenced response',async()=>{
  const store=new PlatformStore(pool),account=await store.ensureAccount({issuer:'https://fixture.test',subject:randomUUID(),email:'fixture@example.test',displayName:'Fixture'}),org=await store.createOrganization(account.id,'Fixture');await connectFixtureModel(pool,account.id,org.id);
  const configuration=defaultBusinessConfiguration();configuration.program={id:'grounded-conversation',version:'1'};configuration.tools=['channel.request_handoff','support.request_handoff_v2'];
  const agent=await store.createAgent({accountId:account.id,organizationId:org.id,name:'Support',configuration}),version=await store.createVersion({accountId:account.id,organizationId:org.id,agentId:agent.id,expectedRevision:1});
  const deployment=await store.publishWebsite({accountId:account.id,organizationId:org.id,agentId:agent.id,versionId:version.id,allowedOrigins:['https://customer.test']});
  const sessionId=randomUUID();await pool.query('INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)',[sessionId,deployment.id,createHash('sha256').update(randomBytes(32)).digest('hex'),'https://customer.test']);
  const inbox=composeInbox(pool,{publicOrigin:'https://customer.test',followupAccessEnabled:true,supportStatusEnabled:true,assertServices:async()=>{}}),visitor={deploymentId:deployment.id,sessionId},conversation=await inbox.open(visitor),incoming=await inbox.ingress(visitor,conversation.id,{requestKey:randomUUID(),body:'Can I speak to a person?'}),taskId=incoming.message.task_id!;
  const invocation=await fetch(`${ingress}/restate/send/${HANDOFF_WORKFLOW_NAME}/${taskId}/run`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId})});expect(invocation.ok,await invocation.text()).toBe(true);
  await eventually(async()=>Boolean((await pool.query('SELECT 1 FROM agents_platform.pending_handoff_receipts WHERE task_id=$1 AND outcome IS NOT NULL',[taskId])).rowCount));
  const receipt=(await pool.query('SELECT outcome FROM agents_platform.pending_handoff_receipts WHERE task_id=$1',[taskId])).rows[0];expect(receipt.outcome).toBe('model');expect(calls).toBe(2);
  expect((await pool.query("SELECT state FROM agents_platform.customer_conversations WHERE id=$1",[conversation.id])).rows[0].state).toBe('handoff_pending');
  expect((await pool.query("SELECT count(*)::int count FROM agents_platform.customer_messages WHERE conversation_id=$1 AND request_key=$2",[conversation.id,`handoff-receipt:${taskId}`])).rows[0].count).toBe(1);
  const transcript=await inbox.readVisitor(visitor,conversation.id);expect(transcript.messages.at(-1)?.body).toBe('I have passed your request to the support team.');
  const operations=(await pool.query('SELECT name,state FROM agents_platform.operations WHERE task_id=$1 ORDER BY started_at',[taskId])).rows;expect(operations).toContainEqual({name:'model.handoff_feedback',state:'completed'});
  const accounting=(await pool.query('SELECT accounted_tokens FROM agents_platform.operations WHERE id=$1',[`handoff-feedback:${taskId}`])).rows[0];expect(Number(accounting.accounted_tokens)).toBeGreaterThan(0);
  await eventually(async()=>Boolean((await pool.query("SELECT 1 FROM agents_platform.tasks WHERE id=$1 AND state IN ('completed','incomplete','failed','cancelled','uncertain')",[taskId])).rowCount));
  const waiting=await inbox.ingress(visitor,conversation.id,{requestKey:randomUUID(),body:'Are you still waiting for a person?'});expect(waiting.message.task_id).toBeTruthy();const statusTask=waiting.message.task_id!;
  const dispatch=()=>dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:runtimeAdmin,
    runtimeRoutes:{[HANDOFF_HARNESS_RELEASE]:{ingressUrl:ingress,adminUrl:runtimeAdmin,workflowName:HANDOFF_WORKFLOW_NAME}},
    supportStatusRoute:{ingressUrl:ingress,adminUrl:runtimeAdmin,workflowName:SUPPORT_STATUS_WORKFLOW}});
  await dispatch();
  await eventually(async()=>Boolean((await pool.query('SELECT 1 FROM agents_platform.support_status_notices WHERE task_id=$1',[statusTask])).rowCount));
  const after=await inbox.readVisitor(visitor,conversation.id);expect(after.messages.at(-1)?.body).toBe('Your request is still waiting for a human response.');
  const status=(await pool.query("SELECT t.state,t.execution_purpose,t.model_calls,t.tool_calls,o.accounted_tokens FROM agents_platform.tasks t JOIN agents_platform.operations o ON o.task_id=t.id AND o.name='model.support_status' WHERE t.id=$1",[statusTask])).rows[0];expect(status).toMatchObject({execution_purpose:'support_status_v1',model_calls:1,tool_calls:0});expect(Number(status.accounted_tokens)).toBeGreaterThan(0);
  await eventually(async()=>Boolean((await pool.query("SELECT 1 FROM agents_platform.tasks WHERE id=$1 AND state='completed'",[statusTask])).rowCount));
  statusReply=null;
  for(const detail of ['My account number is 42','Here is another detail']) {
    const added=await inbox.ingress(visitor,conversation.id,{requestKey:randomUUID(),body:detail});expect(added.message.task_id).toBeTruthy();
    await dispatch();
    await eventually(async()=>Boolean((await pool.query("SELECT 1 FROM agents_platform.tasks WHERE id=$1 AND state='completed'",[added.message.task_id])).rowCount));
    expect((await pool.query('SELECT count(*)::int count FROM agents_platform.support_status_notices WHERE task_id=$1',[added.message.task_id])).rows[0].count).toBe(0);
  }
  const overLimit=await inbox.ingress(visitor,conversation.id,{requestKey:randomUUID(),body:'Another question'});expect(overLimit.message.task_id).toBeNull();
  const history=await inbox.readVisitor(visitor,conversation.id);expect(history.messages.some(message=>message.body==='Your request is still waiting for a human response.')).toBe(true);expect(history.messages.at(-1)?.body).toBe('Another question');
 },60000);
 it('delivers a status reply to the original messaging recipient',async()=>{
  statusReply='Your request is still waiting for a human response.';
  const store=new PlatformStore(pool),account=await store.ensureAccount({issuer:'https://fixture.test',subject:randomUUID(),email:'channel@example.test',displayName:'Fixture'}),org=await store.createOrganization(account.id,'Channel');await connectFixtureModel(pool,account.id,org.id);
  const configuration=defaultBusinessConfiguration();configuration.program={id:'grounded-conversation',version:'1'};configuration.tools=['channel.request_handoff'];
  const agent=await store.createAgent({accountId:account.id,organizationId:org.id,name:'Support',configuration}),version=await store.createVersion({accountId:account.id,organizationId:org.id,agentId:agent.id,expectedRevision:1});
  const channels=new ChannelStore(pool,new ConnectionVault('fixture',{fixture:randomBytes(32).toString('base64')}));const scope={accountId:account.id,organizationId:org.id},asset=String(Math.floor(Math.random()*1e9));
  const connection=await channels.create(scope,{kind:'telegram',mode:'bot',name:'Fixture',assetId:asset,state:'active',credentials:{botToken:`${asset}:fixture`}}),deployment=randomUUID();
  await pool.query('INSERT INTO agents_platform.channel_deployments(id,organization_id,connection_id,agent_id,version_id,created_by) VALUES($1,$2,$3,$4,$5,$6)',[deployment,org.id,connection.id,agent.id,version.id,account.id]);
  const inbox=composeInbox(pool,{publicOrigin:'https://customer.test',followupAccessEnabled:true,supportStatusEnabled:true,assertServices:async()=>{}});
  const first=await inbox.ingressChannel({deploymentId:deployment,externalConversationId:'1234',senderId:'1234',requestKey:randomUUID(),body:'A person please'}),original=first.message.task_id!;
  await transaction(pool,db=>inbox.requestHandoff(db,{customerConversationId:first.conversation.id,inputMessageId:first.message.id,ownershipGeneration:String(first.message.ownership_generation)},original));
  const waiting=await inbox.ingressChannel({deploymentId:deployment,externalConversationId:'1234',senderId:'1234',requestKey:randomUUID(),body:'Is someone available?'});expect(waiting.message.task_id).toBeTruthy();
  await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:runtimeAdmin,runtimeRoutes:{[HANDOFF_HARNESS_RELEASE]:{ingressUrl:ingress,adminUrl:runtimeAdmin,workflowName:HANDOFF_WORKFLOW_NAME},'product-capabilities-v11':{ingressUrl:ingress,adminUrl:runtimeAdmin,workflowName:'AgentsBusinessRunV21'}},supportStatusRoute:{ingressUrl:ingress,adminUrl:runtimeAdmin,workflowName:SUPPORT_STATUS_WORKFLOW}});
  await eventually(async()=>Boolean((await pool.query('SELECT 1 FROM agents_platform.support_status_notices WHERE task_id=$1',[waiting.message.task_id])).rowCount));
  const sent:string[]=[];const delivery=new ChannelDelivery(pool,channels,inbox,{assertPolicy:async()=>undefined,context:(_connection,credentials,beforeAttempt)=>({credential:credentials.botToken!,fetch:async(_input,init)=>{await beforeAttempt();sent.push(String(init?.body));return new Response(JSON.stringify({ok:true,result:{message_id:sent.length}}),{status:200,headers:{'content-type':'application/json'}});}})});
  await delivery.drain();await delivery.drain();
  expect(sent.some(value=>value.includes('Your request is still waiting for a human response.'))).toBe(true);
  expect(sent.every(value=>value.includes('1234'))).toBe(true);
 },60000);
});
