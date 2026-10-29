import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { ChannelStore } from "../src/product/channels/channel-store";
import { InboxStore } from "../src/product/inbox/inbox-store";
import { ChannelDelivery } from "../src/product/channels/channel-delivery";
import { ConnectionVault } from "../src/infrastructure/vault";
import { channelWebhookEventSchema } from "../src/contracts/channel-adapters";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { SupportWaitingService } from "../src/product/inbox/support-waiting";
import { currentHandoff, systemMessageIds } from "../src/product/inbox/inbox-presentation";
import { composeInbox } from "../src/composition/inbox";
import { connectFixtureModel } from "./model-fixture";
import { transaction } from "../src/infrastructure/database";
import { settleReceipt } from "../src/product/inbox/handoff-pending-receipt";
import { HANDOFF_RECEIPT } from "../src/product/inbox/handoff-receipt";
const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("waiting notice delivery authority",()=>{
  const database=`agents_channel_delivery_${randomUUID().replaceAll("-","")}`;
  let admin:Pool,pool:Pool,platform:PlatformStore,channels:ChannelStore,inbox:InboxStore;
  beforeAll(async()=>{
    admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);
    platform=new PlatformStore(pool);channels=new ChannelStore(pool,new ConnectionVault("fixture",{fixture:randomBytes(32).toString("base64")}));
    inbox=new InboxStore(pool,{admit:async()=>{throw Error("Unexpected model admission");},readableOutput:async(_db,_id,body)=>body,cancelRoot:async()=>undefined});
  });
  afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  async function fixture(kind:"telegram"|"whatsapp"|"facebook"="telegram"){
    const account=await platform.ensureAccount({issuer:"https://channels.test",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
    const org=await platform.createOrganization(account.id,"Channels"),scope={accountId:account.id,organizationId:org.id};
    const {agent,snapshot}=await platform.createConfiguredAgent({...scope,name:"Support"});
    const assetId=String(Math.floor(Math.random()*1e9)),connection=await channels.create(scope,{kind,mode:kind==="telegram"?"bot":kind==="whatsapp"?"cloud_api":"meta",name:"Bot",assetId,state:"active",credentials:kind==="telegram"?{botToken:`${assetId}:fixture`}:{accessToken:"fixture_access_token"}});
    const deploymentId=randomUUID(),conversationId=randomUUID();
    await pool.query("INSERT INTO agents_platform.channel_deployments(id,organization_id,connection_id,agent_id,version_id,created_by) VALUES($1,$2,$3,$4,$5,$6)",[deploymentId,org.id,connection.id,agent.id,snapshot.id,account.id]);
    await pool.query(`INSERT INTO agents_platform.customer_conversations(id,organization_id,agent_id,version_id,channel_kind,channel_deployment_id,external_conversation_id,external_sender_id,state,assignee_account_id)
      VALUES($1,$2,$3,$4,$7,$5,$8,'1234','human_owned',$6)`,[conversationId,org.id,agent.id,snapshot.id,deploymentId,account.id,kind,kind==="facebook"?`${assetId}:1234`:"1234"]);
    return{scope,connection,deploymentId,conversationId,assetId,thread:kind==="facebook"?`${assetId}:1234`:"1234"};
  }
  function delivery(send:(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>){
    return new ChannelDelivery(pool,channels,inbox,{assertPolicy:async()=>undefined,context:(_c,credentials,beforeAttempt)=>({credential:credentials.botToken??credentials.accessToken,apiVersion:"v23.0",mode:"meta",
      fetch:async(input,init)=>{await beforeAttempt();return send(input,init);}})});
  }
  async function reply(f:Awaited<ReturnType<typeof fixture>>,body="Hello"){
    const conversation=(await inbox.readStaff(f.scope,f.conversationId)).conversation;
    await inbox.command(f.scope,f.conversationId,{commandId:randomUUID(),expectedRevision:conversation.revision,action:"reply",body});
  }
  async function attachmentEpisode() {
    const f=await fixture();
    await pool.query("UPDATE agents_platform.customer_conversations SET state='automation_active',assignee_account_id=NULL WHERE id=$1",[f.conversationId]);
    const incoming=await inbox.ingressChannel({deploymentId:f.deploymentId,externalConversationId:f.thread,senderId:"1234",requestKey:randomUUID(),body:"[Attachment received. Staff assistance required.]",requireHandoff:true});
    await pool.query(`INSERT INTO agents_platform.channel_message_facts(message_id,connection_id,external_conversation_id,provider_message_id,provider_occurred_at,attachments)
      VALUES($1,$2,$3,$4,now(),'[]')`,[incoming.message.id,f.connection.id,f.thread,randomUUID()]);
    let sends=0;const worker=delivery(async()=>{sends++;return Response.json({ok:true,result:{message_id:919+sends}});});
    await worker.drain(2);
    const waiting=new SupportWaitingService(pool,(db,notice)=>inbox.publishWaitingNotice(db,notice));
    const episode=(await pool.query("SELECT * FROM agents_platform.support_waiting WHERE conversation_id=$1",[f.conversationId])).rows[0];
    await waiting.advance(episode.task_id,new Date(new Date(episode.requested_at).getTime()+6*60_000));
    return {...f,worker,episode,sends:()=>sends};
  }
  it("publishes and delivers attachment waiting notices without the handoff model tool",async()=>{
    const f=await attachmentEpisode();
    const notice=(await pool.query("SELECT state FROM agents_platform.support_waiting_notices WHERE task_id=$1",[f.episode.task_id])).rows[0];
    expect(notice?.state).toBe("published");
    await f.worker.drain(2);expect(f.sends()).toBe(2);
  });
  it("suppresses queued attachment waiting notices when the agent is deleted",async()=>{
    const f=await attachmentEpisode();
    await pool.query("UPDATE agents_platform.agents SET deleted_at=now() WHERE id=(SELECT agent_id FROM agents_platform.customer_conversations WHERE id=$1)",[f.conversationId]);
    await f.worker.drain(2);expect(f.sends()).toBe(1);
    expect((await f.worker.readDeliveries(f.scope,f.conversationId)).at(-1).state).toBe("suppressed");
  });
  it("suppresses a queued model-origin notice if the deployed version loses handoff",async()=>{
    const f=await fixture();
    await connectFixtureModel(pool,f.scope.accountId,f.scope.organizationId);
    const configured=await platform.createConfiguredAgent({...f.scope,name:"Human support",offering:"faq"});
    await pool.query("UPDATE agents_platform.channel_deployments SET agent_id=$2,version_id=$3 WHERE id=$1",[f.deploymentId,configured.agent.id,configured.snapshot.id]);
    await pool.query("DELETE FROM agents_platform.customer_conversations WHERE id=$1",[f.conversationId]);
    const composed=composeInbox(pool,{publicOrigin:"https://customer.test",assertServices:async()=>{}});
    const incoming=await composed.ingressChannel({deploymentId:f.deploymentId,externalConversationId:f.thread,senderId:"1234",requestKey:randomUUID(),body:"A person please"});
    f.conversationId=incoming.conversation.id;
    const taskId=incoming.message.task_id!;
    await transaction(pool,db=>composed.requestHandoff(db,{customerConversationId:f.conversationId,ownershipGeneration:String(incoming.message.ownership_generation),inputMessageId:incoming.message.id},taskId));
    let sends=0;
    const worker=new ChannelDelivery(pool,channels,composed,{assertPolicy:async()=>undefined,context:(_c,credentials,beforeAttempt)=>({credential:credentials.botToken!,fetch:async()=>{await beforeAttempt();sends++;return Response.json({ok:true,result:{message_id:932+sends}});}})});
    await worker.drain(2);
    const waiting=new SupportWaitingService(pool,(db,notice)=>composed.publishWaitingNotice(db,notice));
    const episode=(await pool.query("SELECT * FROM agents_platform.support_waiting WHERE task_id=$1",[taskId])).rows[0];
    await waiting.advance(taskId,new Date(new Date(episode.requested_at).getTime()+6*60_000));
    expect((await pool.query("SELECT state FROM agents_platform.support_waiting_notices WHERE task_id=$1",[taskId])).rows[0]?.state).toBe("published");
    const replacement=randomUUID();
    await pool.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,tool_bindings,created_by,effective_composition)
      SELECT $2,organization_id,agent_id,number+1000,draft_revision+1000,execution_kind,jsonb_set(configuration,'{tools}','[]'::jsonb),tool_bindings,created_by,effective_composition FROM agents_platform.agent_versions WHERE id=$1`,[configured.snapshot.id,replacement]);
    await pool.query("UPDATE agents_platform.channel_deployments SET version_id=$2 WHERE id=$1",[f.deploymentId,replacement]);
    await worker.drain(2);expect(sends).toBe(1);
    expect((await worker.readDeliveries(f.scope,f.conversationId)).at(-1).state).toBe("suppressed");
  });
  it("reads the real episode age, first human reply and receipt-backed system authors",async()=>{
    const f=await attachmentEpisode();
    let timeline=await inbox.readStaff(f.scope,f.conversationId);
    const current=await currentHandoff(pool,f.conversationId,timeline.conversation.state,timeline.conversation.return_watermark);
    expect(current?.requestedAt).toBeInstanceOf(Date);expect(current?.firstHumanReplyAt).toBeNull();
    expect(timeline.handoff?.requestedAt).toBeInstanceOf(Date);expect(timeline.handoff?.firstHumanReplyAt).toBeNull();
    expect(timeline.messages.filter(message=>message.displayKind==="system")).toHaveLength(2);
    const ids=await systemMessageIds(pool,f.conversationId,timeline.messages.map(message=>message.id));
    expect(timeline.messages.filter(message=>ids.has(message.id)).map(message=>message.body)).toHaveLength(2);
    await inbox.command(f.scope,f.conversationId,{commandId:randomUUID(),expectedRevision:timeline.conversation.revision,action:"claim"});
    timeline=await inbox.readStaff(f.scope,f.conversationId);
    await inbox.command(f.scope,f.conversationId,{commandId:randomUUID(),expectedRevision:timeline.conversation.revision,action:"takeover"});
    timeline=await inbox.readStaff(f.scope,f.conversationId);
    await inbox.command(f.scope,f.conversationId,{commandId:randomUUID(),expectedRevision:timeline.conversation.revision,action:"reply",body:"A person replied"});
    timeline=await inbox.readStaff(f.scope,f.conversationId);
    expect((await currentHandoff(pool,f.conversationId,timeline.conversation.state,timeline.conversation.return_watermark))?.firstHumanReplyAt).toBeInstanceOf(Date);
    expect(timeline.handoff?.firstHumanReplyAt).toBeInstanceOf(Date);
  });
});
