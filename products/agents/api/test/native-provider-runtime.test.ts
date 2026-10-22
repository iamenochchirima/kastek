import {createHash,randomBytes,randomUUID} from "node:crypto";
import {createServer,type Server} from "node:http";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {setupPlatformSchema} from "../src/composition/setup";
import {PlatformStore} from "../src/product/agents/store";
import {ProviderServices} from "../src/product/connections/provider-services";
import type {ProviderOAuthPort} from "../src/product/connections/provider-oauth";
import {ConnectionStore} from "../src/product/connections/connections";
import {ConnectionVault} from "../src/infrastructure/vault";
import {ConnectedExecutor} from "../src/capabilities/connected-tools/connected-executor";
import {ToolReviewStore} from "../src/capabilities/reviews/tool-reviews";
import {EvidenceStore} from "../src/execution/context/evidence";
import {defaultBusinessConfiguration,type ExecutionGrant} from "../src/contracts/contracts";
import {capabilityBindingSchema} from "../src/contracts/capability-catalog";
import {beginOperation} from "../src/execution/lifecycle/execution";
import {dropClosedTestDatabase} from "./support/database-cleanup";
import {connectFixtureModel} from "./model-fixture";
import {customerConfiguration} from "../src/product/offerings/offerings";
import {composeInbox} from "../src/composition/inbox";
import {ChannelStore} from "../src/product/channels/channel-store";
import {ChannelDelivery} from "../src/product/channels/channel-delivery";
import {ChannelToolReviews,channelToolReviewButtons} from "../src/product/channels/channel-tool-reviews";
import type {ChannelWebhookEvent} from "../src/contracts/channel-adapters";
import {exportProviderEffects} from "../src/product/evaluation/history-provider-effects";
import {transaction} from "../src/infrastructure/database";

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("managed provider through published agent admission and durable reviews",()=>{
 let admin:Pool,pool:Pool,platform:PlatformStore,providers:ProviderServices,executor:ConnectedExecutor,reviews:ToolReviewStore,server:Server,origin:string;
 let reads=0,writes=0,mode="ok",contact:any,headers:string[]=[],beforeCreateResult:(()=>Promise<void>)|undefined,messagingSequence=100000;
 const database=`agents_native_runtime_${randomUUID().replaceAll("-","")}`,vault=new ConnectionVault("v1",{v1:randomBytes(32).toString("base64")});
 const token="fixture-native-provider-secret",objects=new Map<string,Uint8Array>();
 const storage={async put(key:string,value:Uint8Array){objects.set(key,Buffer.from(value));},async get(key:string){const value=objects.get(key);if(!value)throw Error("Missing fixture receipt");return value;},async delete(key:string){objects.delete(key);}};
 const oauth:ProviderOAuthPort={configurationDigest:"b".repeat(64),async begin(){const state=randomBytes(32).toString("hex");return{state,nonce:randomBytes(32).toString("hex"),verifier:randomBytes(32).toString("hex"),authorizationUrl:`https://app.hubspot.com/oauth/authorize?state=${state}`};},async complete(){return{accessToken:token,refreshToken:"fixture-refresh",expiresAt:new Date(Date.now()+3600000).toISOString(),scopes:["oauth","crm.objects.contacts.read","crm.objects.contacts.write"],subject:"fixture-hub-id",email:"operator@example.test"};},async refresh(){throw Error("Unexpired fixture credentials must not refresh");}};
 beforeAll(async()=>{
  admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);platform=new PlatformStore(pool);
  server=createServer(async(req,res)=>{headers.push(req.headers.authorization??"");let text="";for await(const chunk of req)text+=chunk;const body=JSON.parse(text);res.setHeader("content-type","application/json");
   if(req.url!.endsWith("/search")){reads++;res.end(JSON.stringify({total:contact?1:0,results:contact?[contact]:[]}));return;}
   writes++;contact={id:"123",properties:body.properties};await beforeCreateResult?.();if(mode==="lost"){contact=undefined;req.socket.destroy();return;}res.statusCode=201;res.end(JSON.stringify(contact));
  });await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  providers=new ProviderServices(pool,vault,{appUrl:"http://localhost:3100",environment:{},tests:{hubspot:{oauth,testApiBaseUrl:origin}}});reviews=new ToolReviewStore(pool);
  const fallback=new ConnectionStore(pool,vault,[]);
  executor=new ConnectedExecutor(pool,providers.credentials(fallback),storage,new EvidenceStore(pool,storage),{genericReview:reviews.port(),ensureCredentialFresh:providers.ensureFresh.bind(providers),testNativeProviderBaseUrl:origin});
 },20000);
 afterAll(async()=>{server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 async function fixture(){
  reads=0;writes=0;mode="ok";contact=undefined;headers=[];beforeCreateResult=undefined;
  const account=await platform.ensureAccount({issuer:"http://localhost/native-runtime",subject:randomUUID(),email:"operator@example.test",displayName:"Operator"}),organization=await platform.createOrganization(account.id,"Provider runtime"),scope={organizationId:organization.id,accountId:account.id},store=providers.store("hubspot");
  await connectFixtureModel(pool,scope.accountId,scope.organizationId);
  let connection=await store.create(scope,{name:"HubSpot",operations:["contacts.search","contacts.create"]});const auth=await store.authorize(scope,connection.id),state=new URL(auth.authorizationUrl).searchParams.get("state")!;
  await store.complete(account.id,`?state=${state}&code=fixture-code`);connection=await store.get(scope,connection.id);
  connection=await store.selectOperations(scope,connection.id,{generation:connection.generation,operationIds:["contacts.search","contacts.create"]});
  const bindings=(await pool.query("SELECT binding FROM agents_platform.capability_bindings WHERE id=ANY($1::uuid[]) ORDER BY binding#>>'{definition,providerOperation}'",[connection.bindingIds])).rows.map(row=>capabilityBindingSchema.parse(row.binding));
  const configuration={...defaultBusinessConfiguration(),connectedToolBindingIds:bindings.map(binding=>binding.id)},agent=await platform.createAgent({...scope,name:"Staff assistant",configuration}),version=await platform.createVersion({...scope,agentId:agent.id,expectedRevision:1});
  const authority={product:"agents" as const,organizationId:scope.organizationId,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}};
  const grant:ExecutionGrant={...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","connected.read","connected.execute"],sourceRevisionIds:[],connectedToolBindingIds:bindings.map(binding=>binding.id),maxInputBytes:configuration.model.maxInputBytes,maxOutputTokens:configuration.model.maxOutputTokens,maxContextTokens:configuration.context.maxInputTokens,rootTokenLimit:32000,expiresAt:new Date(Date.now()+300000).toISOString(),revokedAt:null};
  await platform.createGrant({accountId:scope.accountId,grant});const {task}=await platform.admitTask({authority,versionId:version.id,grantId:grant.id,requestKey:randomUUID(),input:"Use the connected customer records"});
  return{scope,connection,store,bindings,task,grant};
 }
 async function operation(f:Awaited<ReturnType<typeof fixture>>,name:string,args:Record<string,unknown>,approved=false){
  const binding=f.bindings.find(item=>item.definition.providerOperation===name)!,operationId=`tool:${f.task.id}:${randomUUID()}`;
  if(approved){const review=await reviews.prepare(f.task.id,operationId,binding,args);await reviews.decide(f.scope,review.id,{decision:"approve",requestDigest:review.requestDigest});}
  await beginOperation(pool,f.task.id,{id:operationId,kind:"tool",name:binding.alias,request:args,reservedTokens:0,reservedMs:30000,retrySafe:false});return{binding,operationId,args};
 }
 it("runs the saved agent's selected search through the shared credential resolver and persists a private receipt",async()=>{
  const f=await fixture();contact={id:"123",properties:{email:"customer@example.test",firstname:"Customer",privateNotes:"never expose"}};const op=await operation(f,"contacts.search",{email:"customer@example.test"});
  const result=await executor.execute(f.task.id,op.operationId,op.binding,op.args);expect(result.status).toBe("ok");expect(result.content).toContain("customer@example.test");expect(result.content).not.toContain("privateNotes");expect(result.content).not.toContain(token);expect(headers).toEqual([`Bearer ${token}`]);expect(reads).toBe(1);expect(writes).toBe(0);
  expect((await pool.query("SELECT state,result FROM agents_platform.connected_reads WHERE operation_id=$1",[op.operationId])).rows[0]).toMatchObject({state:"completed",result:{status:"ok"}});
  expect(await executor.execute(f.task.id,op.operationId,op.binding,op.args)).toEqual(result);expect(reads).toBe(1);
 },20000);
 it("requires exact approval, sends one create, stores its receipt and replays without provider access",async()=>{
  const f=await fixture(),args={email:"customer@example.test",firstName:"Customer"},unapproved=await operation(f,"contacts.create",args);
  await expect(executor.execute(f.task.id,unapproved.operationId,unapproved.binding,args)).rejects.toMatchObject({code:"TOOL_REVIEW_REQUIRED"});expect(reads+writes).toBe(0);
  const op=await operation(f,"contacts.create",args,true);
  await expect(executor.execute(f.task.id,op.operationId,op.binding,{...args,email:"different@example.test"})).rejects.toMatchObject({code:"TOOL_REVIEW_REQUIRED"});expect(reads+writes).toBe(0);
  const result=await executor.execute(f.task.id,op.operationId,op.binding,args);expect(result.status).toBe("ok");expect(JSON.parse(result.content)).toMatchObject({state:"confirmed",contactId:"123",created:true});expect(reads).toBe(1);expect(writes).toBe(1);
  expect((await pool.query("SELECT state FROM agents_platform.tool_invocation_reviews WHERE operation_id=$1",[op.operationId])).rows[0].state).toBe("completed");
  expect(await executor.execute(f.task.id,op.operationId,op.binding,args)).toEqual(result);expect(writes).toBe(1);expect(reads).toBe(1);
 },20000);
 it("blocks revoked connection authority and removed account membership before any physical send",async()=>{
  const f=await fixture(),op=await operation(f,"contacts.search",{email:"customer@example.test"});await f.store.disconnect(f.scope,f.connection.id,{generation:f.connection.generation});
  await expect(executor.execute(f.task.id,op.operationId,op.binding,op.args)).rejects.toThrow();expect(reads+writes).toBe(0);
  const other=await fixture(),pending=await operation(other,"contacts.search",{email:"customer@example.test"});await pool.query("DELETE FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2",[other.scope.organizationId,other.scope.accountId]);
  await expect(executor.execute(other.task.id,pending.operationId,pending.binding,pending.args)).rejects.toThrow();expect(reads+writes).toBe(0);
 },20000);
 it("does not replay an unknown create outcome as another provider write",async()=>{
  const f=await fixture(),op=await operation(f,"contacts.create",{email:"customer@example.test"},true);mode="lost";
  await expect(executor.execute(f.task.id,op.operationId,op.binding,op.args)).rejects.toMatchObject({code:"CONNECTED_OPERATION_UNCERTAIN"});expect(writes).toBe(1);const before=reads;
  expect((await pool.query("SELECT state FROM agents_platform.tool_invocation_reviews WHERE operation_id=$1",[op.operationId])).rows[0].state).toBe("uncertain");
  await expect(executor.execute(f.task.id,op.operationId,op.binding,op.args)).rejects.toMatchObject({code:"CONNECTED_OPERATION_UNCERTAIN"});expect(writes).toBe(1);expect(reads).toBe(before);
 },20000);
 it("invalidates published bindings when the owner changes allowed provider operations",async()=>{
  const f=await fixture(),op=await operation(f,"contacts.create",{email:"customer@example.test"},true);
  await f.store.selectOperations(f.scope,f.connection.id,{generation:f.connection.generation,operationIds:["contacts.search"]});
  await expect(executor.execute(f.task.id,op.operationId,op.binding,op.args)).rejects.toThrow();expect(reads+writes).toBe(0);
 },20000);
 it("confirms an existing exact contact without claiming a provider write",async()=>{
  const f=await fixture(),op=await operation(f,"contacts.create",{email:"customer@example.test",firstName:"Customer"},true);contact={id:"123",properties:{email:"customer@example.test",firstname:"Customer"}};
  const result=await executor.execute(f.task.id,op.operationId,op.binding,op.args);expect(result.status).toBe("ok");expect(JSON.parse(result.content)).toMatchObject({state:"confirmed",created:false});expect(reads).toBe(1);expect(writes).toBe(0);
  expect((await pool.query("SELECT state FROM agents_platform.tool_invocation_reviews WHERE operation_id=$1",[op.operationId])).rows[0].state).toBe("completed");
 },20000);
 async function customerFixture(){
  const f=await fixture(),shared=await f.store.sharing(f.scope,f.connection.id,{generation:f.connection.generation,sharing:"organization_service"});
  const allBindings=(await pool.query("SELECT binding FROM agents_platform.capability_bindings WHERE id=ANY($1::uuid[])",[shared.bindingIds])).rows.map(row=>capabilityBindingSchema.parse(row.binding));
  const bindings=allBindings.filter(binding=>binding.definition.providerOperation==="contacts.create");expect(bindings).toHaveLength(1);
  const configuration={...customerConfiguration("customer-service"),connectedToolBindingIds:bindings.map(binding=>binding.id)};
  const agent=await platform.createConfiguredAgent({...f.scope,name:"Contact intake",offering:"customer-service",configuration});
  const origin="https://customer.fixture.test",deployment=await platform.publishWebsite({...f.scope,agentId:agent.agent.id,versionId:agent.snapshot.id,allowedOrigins:[origin]}),sessionId=randomUUID();
  await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)",[sessionId,deployment.id,createHash("sha256").update(randomBytes(32)).digest("hex"),origin]);
  const principal={kind:"visitor" as const,deploymentId:deployment.id,sessionId},visitor={deploymentId:deployment.id,sessionId},inbox=composeInbox(pool,{publicOrigin:"http://localhost:3100",assertServices:async()=>{}}),conversation=await inbox.open(visitor);
  const incoming=await inbox.ingress(visitor,conversation.id,{requestKey:randomUUID(),body:"Please save my contact details"});expect(incoming.message.task_id).toBeTruthy();
  return{...f,connection:shared,bindings,allBindings,principal,inbox,conversation,task:{...f.task,id:incoming.message.task_id!}};
 }
 it("requires the same customer's exact confirmation and exposes only a contact-intake acknowledgement",async()=>{
  const f=await customerFixture(),op=await operation(f,"contacts.create",{email:"customer@example.test",firstName:"Customer"});
  await expect(executor.execute(f.task.id,op.operationId,op.binding,op.args)).rejects.toMatchObject({code:"TOOL_REVIEW_REQUIRED"});expect(reads+writes).toBe(0);
  const prepared=await reviews.prepare(f.task.id,op.operationId,op.binding,op.args),publicReviews=await reviews.listForPrincipal(f.task.id,f.principal);
  expect(publicReviews).toHaveLength(1);expect(publicReviews[0]).toMatchObject({arguments:op.args,operationName:"Save contact details"});expect(JSON.stringify(publicReviews)).not.toContain("connectionId");
  await expect(reviews.decideForPrincipal(f.task.id,{...f.principal,sessionId:randomUUID()},prepared.id,{decision:"approve",requestDigest:prepared.requestDigest})).rejects.toThrow();
  await reviews.decideForPrincipal(f.task.id,f.principal,prepared.id,{decision:"approve",requestDigest:prepared.requestDigest});
  const result=await executor.execute(f.task.id,op.operationId,op.binding,op.args);expect(result.status).toBe("ok");expect(JSON.parse(result.content)).toEqual({state:"received"});expect(result.content).not.toContain("contactId");expect(result.content).not.toContain("123");expect(writes).toBe(1);
  const exported=await transaction(pool,db=>exportProviderEffects(db,{id:f.task.id,organization_id:f.scope.organizationId} as Parameters<typeof exportProviderEffects>[1],new Set([f.task.id]),{objects:storage}));
  expect(exported.omissions).toEqual([]);expect(exported.records).toHaveLength(1);expect(exported.records[0]).toMatchObject({providerId:"hubspot",providerOperation:"contacts.create",state:"completed",receipt:{state:"confirmed",contactId:"123",created:true}});expect(JSON.stringify(exported)).not.toContain(token);
  contact={id:"999",properties:{email:"existing@example.test",firstname:"Private-existing-name",lastname:"Private-existing-surname"}};
  const existing=await operation(f,"contacts.create",{email:"existing@example.test"}),existingReview=await reviews.prepare(f.task.id,existing.operationId,existing.binding,existing.args);
  await reviews.decideForPrincipal(f.task.id,f.principal,existingReview.id,{decision:"approve",requestDigest:existingReview.requestDigest});
  const existingResult=await executor.execute(f.task.id,existing.operationId,existing.binding,existing.args);
  expect(existingResult.status).toBe("ok");expect(JSON.parse(existingResult.content)).toEqual({state:"received"});expect(existingResult.content).not.toContain("999");expect(existingResult.content).not.toContain("Private-existing");expect(writes).toBe(1);
 },20000);
 it("refuses to publish staff contact lookup into a customer deployment",async()=>{
  const f=await customerFixture(),search=f.allBindings.find(binding=>binding.definition.providerOperation==="contacts.search")!;
  await expect((async()=>{
   const configured=await platform.createConfiguredAgent({...f.scope,name:"Forbidden lookup",offering:"customer-service",configuration:{...customerConfiguration("customer-service"),connectedToolBindingIds:[search.id]}});
   return platform.publishWebsite({...f.scope,agentId:configured.agent.id,versionId:configured.snapshot.id,allowedOrigins:["https://customer.fixture.test"]});
  })()).rejects.toThrow();expect(reads+writes).toBe(0);
 },20000);
 it("fences an already confirmed customer request when service sharing is withdrawn",async()=>{
  const f=await customerFixture(),op=await operation(f,"contacts.create",{email:"customer@example.test"});
  const prepared=await reviews.prepare(f.task.id,op.operationId,op.binding,op.args);
  await reviews.decideForPrincipal(f.task.id,f.principal,prepared.id,{decision:"approve",requestDigest:prepared.requestDigest});
  await f.store.sharing(f.scope,f.connection.id,{generation:f.connection.generation,sharing:"private"});
  await expect(executor.execute(f.task.id,op.operationId,op.binding,op.args)).rejects.toThrow();expect(reads+writes).toBe(0);
 },20000);
 it("moves an uncertain customer CRM operation into Inbox handoff",async()=>{
  const f=await customerFixture(),op=await operation(f,"contacts.create",{email:"customer@example.test"}),review=await reviews.prepare(f.task.id,op.operationId,op.binding,op.args);
  await reviews.decideForPrincipal(f.task.id,f.principal,review.id,{decision:"approve",requestDigest:review.requestDigest});mode="lost";
  await expect(executor.execute(f.task.id,op.operationId,op.binding,op.args)).rejects.toMatchObject({code:"CONNECTED_OPERATION_UNCERTAIN"});expect(writes).toBe(1);
  expect((await f.inbox.readStaff(f.scope,f.conversation.id)).conversation.state).toBe("handoff_pending");
 },20000);
 it("preserves human takeover when ownership changes during an uncertain CRM send",async()=>{
  const f=await customerFixture(),op=await operation(f,"contacts.create",{email:"customer@example.test"}),review=await reviews.prepare(f.task.id,op.operationId,op.binding,op.args);
  await reviews.decideForPrincipal(f.task.id,f.principal,review.id,{decision:"approve",requestDigest:review.requestDigest});mode="lost";
  beforeCreateResult=async()=>{for(const action of ["claim","takeover"] as const){const current=await f.inbox.readStaff(f.scope,f.conversation.id);await f.inbox.command(f.scope,f.conversation.id,{commandId:randomUUID(),expectedRevision:current.conversation.revision,action});}};
  await expect(executor.execute(f.task.id,op.operationId,op.binding,op.args)).rejects.toMatchObject({code:"CONNECTED_OPERATION_UNCERTAIN"});expect(writes).toBe(1);
  expect((await f.inbox.readStaff(f.scope,f.conversation.id)).conversation.state).toBe("human_owned");
 },20000);
 async function messagingFixture(){
  const f=await fixture(),shared=await f.store.sharing(f.scope,f.connection.id,{generation:f.connection.generation,sharing:"organization_service"});
  const bindings=(await pool.query("SELECT binding FROM agents_platform.capability_bindings WHERE id=ANY($1::uuid[])",[shared.bindingIds])).rows.map(row=>capabilityBindingSchema.parse(row.binding)).filter(binding=>binding.definition.providerOperation==="contacts.create");
  const configured=await platform.createConfiguredAgent({...f.scope,name:"Messaging intake",offering:"customer-service",configuration:{...customerConfiguration("customer-service"),connectedToolBindingIds:bindings.map(binding=>binding.id)}});
  const assetId=String(messagingSequence++),channels=new ChannelStore(pool,vault),channel=await channels.create(f.scope,{kind:"telegram",mode:"bot",name:"Contact intake",assetId,state:"active",credentials:{botToken:`${assetId}:fixture`}}),deployment=await channels.bind(f.scope,channel.id,{expectedRevision:1,agentId:configured.agent.id});
  const inbox=composeInbox(pool,{publicOrigin:"http://localhost:3100",assertServices:async()=>{}}),received=await inbox.ingressChannel({deploymentId:deployment.id,externalConversationId:"456",senderId:"456",requestKey:randomUUID(),body:"Save my contact details"}),principal={kind:"channel_customer" as const,deploymentId:deployment.id,participantId:received.conversation.id};
  const sent:any[]=[],handler=new ChannelToolReviews(pool,reviews),delivery=new ChannelDelivery(pool,channels,inbox,{
   context(_connection,credentials,beforeAttempt){return{credential:credentials.botToken!,fetch:async(_url,init)=>{await beforeAttempt();sent.push(JSON.parse(String(init?.body)));return Response.json({ok:true,result:{message_id:55}});}};},
   assertPolicy:async()=>{},handleInteraction:(...args)=>handler.handle(...args),acknowledgeInteraction:async()=>{},
  });
  return{...f,connection:shared,bindings,principal,inbox,conversation:received.conversation,task:{...f.task,id:received.message.task_id!},channels,channel,deployment,delivery,sent};
 }
 function callback(f:Awaited<ReturnType<typeof messagingFixture>>,reviewId:string,patch:Partial<ChannelWebhookEvent>={}):ChannelWebhookEvent{return{kind:"interaction",assetId:f.channel.assetId,eventId:randomUUID(),externalConversationId:"456",senderId:"456",occurredAt:new Date().toISOString(),providerMessageId:"55",attachments:[],echo:false,callbackQueryId:randomUUID(),interaction:channelToolReviewButtons(reviewId)[0]!.payload,...patch};}
 it("delivers one native exact prompt through the outbox and accepts only the matching verified customer callback",async()=>{
  const f=await messagingFixture(),op=await operation(f,"contacts.create",{email:"customer@example.test",firstName:"Customer"}),review=await reviews.prepare(f.task.id,op.operationId,op.binding,op.args);
  await reviews.prepare(f.task.id,op.operationId,op.binding,op.args);await f.delivery.drain();expect(f.sent).toHaveLength(1);expect(f.sent[0].text).toContain("Email: customer@example.test");expect(f.sent[0].reply_markup.inline_keyboard[0][0].callback_data).toBe(channelToolReviewButtons(review.id)[0]!.payload);
  expect((await f.inbox.readStaff(f.scope,f.conversation.id)).messages.at(-1)?.body).toContain("Save these contact details?");
  await f.delivery.persist("telegram",[callback(f,review.id,{senderId:"999"})]);await f.delivery.drain();expect((await reviews.listForPrincipal(f.task.id,f.principal))[0]!.state).toBe("pending");expect(reads+writes).toBe(0);
  const accepted=callback(f,review.id);await f.delivery.persist("telegram",[accepted]);await f.delivery.drain();expect((await reviews.listForPrincipal(f.task.id,f.principal))[0]!.state).toBe("approved");
  const result=await executor.execute(f.task.id,op.operationId,op.binding,op.args);expect(JSON.parse(result.content)).toEqual({state:"received"});expect(writes).toBe(1);
  expect(await f.delivery.persist("telegram",[accepted])).toBe(0);expect((await pool.query("SELECT count(*)::int n FROM agents_platform.tasks WHERE organization_id=$1",[f.scope.organizationId])).rows[0].n).toBe(2);
 },20000);
 it("rejects expired callbacks and suppresses pending prompts after human takeover",async()=>{
  const f=await messagingFixture(),op=await operation(f,"contacts.create",{email:"customer@example.test"}),review=await reviews.prepare(f.task.id,op.operationId,op.binding,op.args);
  for(const action of ["claim","takeover"] as const){const current=await f.inbox.readStaff(f.scope,f.conversation.id);await f.inbox.command(f.scope,f.conversation.id,{commandId:randomUUID(),expectedRevision:current.conversation.revision,action});}
  await f.delivery.drain();expect(f.sent).toHaveLength(0);await f.delivery.persist("telegram",[callback(f,review.id)]);await f.delivery.drain();expect(writes).toBe(0);
  expect((await pool.query("SELECT state FROM agents_platform.tool_invocation_reviews WHERE id=$1",[review.id])).rows[0].state).toBe("pending");
  const other=await messagingFixture(),pending=await operation(other,"contacts.create",{email:"customer@example.test"}),expired=await reviews.prepare(other.task.id,pending.operationId,pending.binding,pending.args);await other.delivery.drain();
  await pool.query("UPDATE agents_platform.tool_invocation_reviews SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);await other.delivery.persist("telegram",[callback(other,expired.id)]);await other.delivery.drain();
  expect((await pool.query("SELECT state FROM agents_platform.tool_invocation_reviews WHERE id=$1",[expired.id])).rows[0].state).not.toBe("approved");expect(writes).toBe(0);
 },20000);
});
