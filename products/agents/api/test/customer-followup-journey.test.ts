import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Pool } from "pg";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { buildPlatformApp } from "../src/composition/app";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { PlatformStore } from "../src/product/agents/store";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { ResendNotificationSender } from "../src/adapters/notifications/resend";
import { CustomerFollowupNotifications } from "../src/product/customer-followup/notifications";
import { executeTool } from "../src/capabilities/tools";
import { publishFollowupReadiness,followupConfigurationDigest } from "../src/product/customer-followup/readiness";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("joined follow-up API, controlled HTTP mailbox and verified return",()=>{
  let admin:Pool,pool:Pool,app:Awaited<ReturnType<typeof buildPlatformApp>>,mailbox:ReturnType<typeof createServer>,sender:ResendNotificationSender,store:PlatformStore;
  const database=`agents_followup_journey_${randomUUID().replaceAll("-","")}`,messages:Array<{to:string[];subject:string;text:string}>=[];
  const publicOrigin="https://agents-followup.fixture.test",websiteOrigin="https://labs.fixture.test";
  let registryAvailable=true,mailboxOrigin="";
  beforeAll(async()=>{
    admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);store=new PlatformStore(pool);
    mailbox=createServer(async(request,response)=>{
      if(request.method==="GET"&&request.url==="/services/AgentsCustomerFollowupV1"){response.writeHead(registryAvailable?200:503,{"content-type":"application/json"});response.end(JSON.stringify({name:"AgentsCustomerFollowupV1"}));return;}
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      if(request.method!=="POST"||request.url!=="/emails"||request.headers.authorization!=="Bearer fixture-followup-provider-key"||!request.headers["idempotency-key"]){response.writeHead(400);response.end();return;}
      messages.push(JSON.parse(Buffer.concat(chunks).toString()));response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({id:`mailbox-${messages.length}`}));
    });await new Promise<void>(resolve=>mailbox.listen(0,"127.0.0.1",resolve));
    mailboxOrigin=`http://127.0.0.1:${(mailbox.address() as {port:number}).port}`;
    sender=new ResendNotificationSender("fixture-followup-provider-key","support@fixture.test",{timeoutMs:3000,testBaseUrl:mailboxOrigin});
    vi.stubEnv("AGENTS_FOLLOWUP_RESEND_API_KEY","fixture-followup-provider-key");vi.stubEnv("AGENTS_FOLLOWUP_EMAIL_SENDER","support@fixture.test");
    app=await buildPlatformApp({pool,logging:false,testFollowupSender:sender,config:loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:url.href,AGENTS_PUBLIC_URL:publicOrigin,AGENTS_OIDC_ISSUER_URL:"https://identity-followup.fixture.test",AGENTS_OIDC_CLIENT_SECRET:"controlled-followup-fixture-secret",RESTATE_ADMIN_URL:mailboxOrigin})});
  });
  afterAll(async()=>{await app?.close();if(mailbox)await new Promise<void>(resolve=>mailbox.close(()=>resolve()));vi.unstubAllEnvs();await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  it("confirms an address, queues and sends one human reply notification, returns to the right chat, then revokes access",async()=>{
    const account=await store.ensureAccount({issuer:"https://identity-followup.fixture.test",subject:randomUUID(),email:"owner@fixture.test",displayName:"Owner"}),organization=await store.createOrganization(account.id,"Controlled follow-up journey"),scope={organizationId:organization.id,accountId:account.id};
    await connectFixtureModel(pool,account.id,organization.id);const configuration=defaultBusinessConfiguration();configuration.tools=["channel.request_handoff"];
    const agent=await store.createAgent({...scope,name:"Support",configuration}),version=await store.createVersion({...scope,agentId:agent.id,expectedRevision:1}),deployment=await store.publishWebsite({...scope,agentId:agent.id,versionId:version.id,allowedOrigins:[websiteOrigin]});
    const base=`/api/website/${deployment.id}`;
    expect((await app.inject({url:base,headers:{origin:websiteOrigin}})).json().followupEnabled).toBe(false);
    await publishFollowupReadiness(pool,{instanceId:randomUUID(),configurationDigest:followupConfigurationDigest({apiKey:"fixture-followup-provider-key",sender:"support@fixture.test",publicUrl:publicOrigin}),adminUrl:mailboxOrigin});
    expect((await app.inject({url:base,headers:{origin:websiteOrigin}})).json().followupEnabled).toBe(true);
    const session=await app.inject({method:"POST",url:`${base}/session`,headers:{origin:websiteOrigin},payload:{}});expect(session.statusCode).toBe(201);
    const originalHeaders={origin:websiteOrigin,authorization:`Bearer ${session.json().token}`},opened=await app.inject({method:"POST",url:`${base}/customer-conversations`,headers:originalHeaders,payload:{}}),conversation=opened.json().conversation;
    const chat=`${base}/customer-conversations/${conversation.id}`,followup=`${chat}/followup`;
    const incoming=await app.inject({method:"POST",url:`${chat}/messages`,headers:originalHeaders,payload:{requestKey:randomUUID(),body:"Please connect me to a person."}});expect(incoming.statusCode).toBe(201);
    const taskId=incoming.json().message.taskId ?? (await pool.query("SELECT task_id FROM agents_platform.customer_messages WHERE id=$1",[incoming.json().message.id])).rows[0].task_id;
    await executeTool(pool,taskId,`handoff:${taskId}`,"channel.request_handoff","{}");
    expect((await app.inject({url:`${chat}/messages`,headers:originalHeaders})).json().messages.at(-1).body).toContain("passed to the support team");
    const invalid=await app.inject({method:"POST",url:`${followup}/request`,headers:originalHeaders,payload:{email:"customer@fixture.test",confirmed:false}});expect(invalid.statusCode).toBe(400);expect(messages).toHaveLength(0);
    registryAvailable=false;
    expect((await app.inject({method:"POST",url:`${followup}/request`,headers:originalHeaders,payload:{email:"customer@fixture.test",confirmed:true}})).statusCode).toBe(503);expect(messages).toHaveLength(0);registryAvailable=true;
    const consent=await app.inject({method:"POST",url:`${followup}/request`,headers:originalHeaders,payload:{email:"customer@fixture.test",confirmed:true}});expect(consent.statusCode).toBe(200);expect(messages).toHaveLength(1);
    const verification=messages[0]!.text.match(/[A-Za-z0-9_-]{43}/)![0];expect(consent.body).not.toContain(verification);
    const verified=await app.inject({method:"POST",url:`${followup}/verify`,headers:originalHeaders,payload:{code:verification}});expect(verified.json()).toEqual({state:"verified"});
    const staffSession=await store.createSession({accountId:account.id,providerSessionId:randomUUID(),expiresAt:new Date(Date.now()+600000)}),staffHeaders={origin:publicOrigin,cookie:`__Host-agents_session=${staffSession.token}`},staff=`/api/organizations/${organization.id}/inbox/${conversation.id}`;
    async function command(action:string,body?:string){const read=await app.inject({url:staff,headers:staffHeaders});expect(read.statusCode).toBe(200);const result=await app.inject({method:"POST",url:`${staff}/commands`,headers:staffHeaders,payload:{commandId:randomUUID(),expectedRevision:read.json().conversation.revision,action,...body?{body}:{}}});expect(result.statusCode,result.body).toBe(200);}
    await command("claim");await command("takeover");await command("reply","Here is your human support response.");
    const notification=(await pool.query("SELECT id,state FROM agents_platform.customer_followup_notifications WHERE conversation_id=$1",[conversation.id])).rows[0];expect(notification.state).toBe("pending");
    const delivery=new CustomerFollowupNotifications(pool,(message,before)=>sender.send(message,before),publicOrigin);
    expect(await delivery.deliver(notification.id)).toBe("accepted");expect(await delivery.deliver(notification.id)).toBe("not_pending");expect(messages).toHaveLength(2);
    const record=(await pool.query("SELECT state,provider_id FROM agents_platform.customer_followup_notifications WHERE id=$1",[notification.id])).rows[0];expect(record).toEqual({state:"accepted",provider_id:"mailbox-2"});
    const link=new URL(messages[1]!.text.split("\n").at(-1)!);expect(link.pathname).toBe(`/support/return/${deployment.id}`);expect(link.search).toBe("");expect(link.hash).toHaveLength(44);
    const fresh=await app.inject({method:"POST",url:`${base}/session`,headers:{origin:publicOrigin},payload:{}});expect(fresh.statusCode).toBe(201);
    const returnedHeaders={origin:publicOrigin,authorization:`Bearer ${fresh.json().token}`};
    const exchange=await app.inject({method:"POST",url:`${base}/followup/return`,headers:returnedHeaders,payload:{secret:link.hash.slice(1)}});expect(exchange.statusCode,exchange.body).toBe(200);expect(exchange.json()).toEqual({conversationId:conversation.id});
    expect((await app.inject({method:"POST",url:`${base}/followup/return`,headers:returnedHeaders,payload:{secret:link.hash.slice(1)}})).statusCode).toBe(404);
    const returnedOpen=await app.inject({method:"POST",url:`${base}/customer-conversations`,headers:returnedHeaders,payload:{}});expect(returnedOpen.json().conversation.id).toBe(conversation.id);
    expect((await app.inject({url:`${chat}/messages`,headers:returnedHeaders})).json().messages.at(-1).body).toBe("Here is your human support response.");
    await command("return");
    const resumed=await app.inject({method:"POST",url:`${chat}/messages`,headers:returnedHeaders,payload:{requestKey:randomUUID(),body:"Continue with the assistant."}});expect(resumed.statusCode,resumed.body).toBe(201);
    expect((await pool.query("SELECT count(DISTINCT conversation_id)::int count FROM agents_platform.tasks WHERE organization_id=$1",[organization.id])).rows[0].count).toBe(1);
    registryAvailable=false;expect((await app.inject({url:base,headers:{origin:websiteOrigin}})).json()).toMatchObject({followupEnabled:false,followupPreferencesAvailable:true});
    expect((await app.inject({url:followup,headers:originalHeaders})).json()).toEqual({state:"verified"});
    const revoked=await app.inject({method:"POST",url:`${followup}/revoke`,headers:originalHeaders,payload:{}});expect(revoked.statusCode).toBe(200);
    expect((await app.inject({url:`${chat}/messages`,headers:returnedHeaders})).statusCode).toBe(403);
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.operations WHERE kind='model'")).rows[0].count).toBe(0);
  });
});
