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
const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("durable channel delivery",()=>{
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
  it("commits/deduplicates ingress before processing, persists human messages once and preserves native facts",async()=>{
    const f=await fixture(),worker=delivery(async()=>{throw Error("No outbound expected");});
    const event=channelWebhookEventSchema.parse({kind:"message",assetId:f.assetId,eventId:"update-1",externalConversationId:"1234",senderId:"1234",providerMessageId:"message-1",occurredAt:"2026-01-01T00:00:00.000Z",text:"Need help"});
    expect(await worker.persist("telegram",[event])).toBe(1);expect(await worker.persist("telegram",[event])).toBe(0);
    expect((await inbox.readStaff(f.scope,f.conversationId)).messages).toHaveLength(0);
    await expect(worker.persist("telegram",[{...event,text:"Conflicting identity"}])).rejects.toMatchObject({code:"CHANNEL_EVENT_CONFLICT"});
    await Promise.all([worker.drain(2),worker.drain(2)]);
    const history=await inbox.readStaff(f.scope,f.conversationId);expect(history.messages.map(m=>m.body)).toEqual(["Need help"]);
    expect(history.messages[0].channelFacts?.occurredAt?.toISOString()).toBe(event.occurredAt);
    expect((await pool.query("SELECT state FROM agents_platform.channel_ingress WHERE connection_id=$1",[f.connection.id])).rows[0].state).toBe("completed");
  });
  it("atomically claims segments across workers, distinguishes accepted receipts, and never repeats uncertain sends",async()=>{
    const f=await fixture();let calls=0;
    const worker=delivery(async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,15));return Response.json({ok:true,result:{message_id:900+calls}});});
    await reply(f,"x".repeat(4200));await Promise.all([worker.drain(3),worker.drain(3)]);await worker.drain(2);
    expect(calls).toBe(2);
    expect((await worker.readDeliveries(f.scope,f.conversationId)).map(row=>row.state)).toEqual(["accepted","accepted"]);
    const facts=await worker.readDeliveries(f.scope,f.conversationId);expect(facts.map(row=>row.segment)).toEqual([0,1]);
    const lost=delivery(async()=>{calls++;throw Error("simulated lost acknowledgement");});await reply(f,"Second message");await lost.drain(2);await lost.drain(2);
    expect(calls).toBe(3);expect((await lost.readDeliveries(f.scope,f.conversationId)).at(-1).state).toBe("unknown");
    const unknown=(await pool.query("SELECT * FROM agents_platform.channel_outbound WHERE conversation_id=$1 AND state='unknown'",[f.conversationId])).rows[0];
    await pool.query("UPDATE agents_platform.channel_outbound SET state='sending',lease_until=now()-interval '1 second' WHERE id=$1",[unknown.id]);
    await lost.drain(2);expect(calls).toBe(3);expect((await lost.readDeliveries(f.scope,f.conversationId)).at(-1).state).toBe("unknown");
  });
  it("suppresses pending staff sends after ownership changes or credential rotation and keeps receipt order monotonic",async()=>{
    const f=await fixture();let calls=0;const worker=delivery(async()=>{calls++;return Response.json({ok:true,result:{message_id:111}});});
    await reply(f);await inbox.command(f.scope,f.conversationId,{commandId:randomUUID(),expectedRevision:"2",action:"return"});await worker.drain(2);
    expect(calls).toBe(0);expect((await worker.readDeliveries(f.scope,f.conversationId))[0].state).toBe("suppressed");
    const fresh=await fixture();await reply(fresh);await worker.drain(2);expect(calls).toBe(1);
    const event=channelWebhookEventSchema.parse({kind:"receipt",assetId:fresh.assetId,eventId:"read",externalConversationId:"1234",senderId:"1234",providerMessageId:"111",occurredAt:null,status:"read"});
    await worker.receipt(fresh.connection.id,event);await worker.receipt(fresh.connection.id,{...event,eventId:"late-delivered",status:"delivered"});
    expect((await worker.readDeliveries(fresh.scope,fresh.conversationId))[0].state).toBe("read");
    const rotate=await fixture();await reply(rotate);await channels.update(rotate.scope,rotate.connection.id,{expectedRevision:1,credentials:{botToken:`${rotate.assetId}:rotated`}});
    await worker.drain(2);expect(calls).toBe(1);expect((await worker.readDeliveries(rotate.scope,rotate.conversationId))[0].state).toBe("suppressed");
  });
  it("fences revocation during policy reads before a physical send",async()=>{
    const f=await fixture();let checks=0,calls=0;
    const worker=new ChannelDelivery(pool,channels,inbox,{assertPolicy:async()=>{if(++checks===2)await channels.update(f.scope,f.connection.id,{expectedRevision:1,credentials:{botToken:`${f.assetId}:rotated`}});},
      context:(_row,credentials,beforeAttempt)=>({credential:credentials.botToken,fetch:async()=>{await beforeAttempt();calls++;return Response.json({ok:true,result:{message_id:99}});}})});
    await reply(f);await worker.drain(1);expect(calls).toBe(0);expect((await worker.readDeliveries(f.scope,f.conversationId))[0].state).toBe("suppressed");
  });
  it("suppresses failed segment tails, permits a new reply and preserves a failure against older receipts",async()=>{
    const f=await fixture();let calls=0;const worker=delivery(async()=>{calls++;return calls===1?Response.json({ok:false,error_code:403},{status:403}):Response.json({ok:true,result:{message_id:100+calls}});});
    await reply(f,"x".repeat(4200));await worker.drain(2);
    expect((await worker.readDeliveries(f.scope,f.conversationId)).map(row=>row.state)).toEqual(["failed","suppressed"]);
    await reply(f,"A new reply");await worker.drain(1);expect(calls).toBe(2);
    const event=channelWebhookEventSchema.parse({kind:"receipt",assetId:f.assetId,eventId:"failed",externalConversationId:"1234",senderId:"1234",providerMessageId:"102",occurredAt:null,status:"failed"});
    await worker.receipt(f.connection.id,event);await worker.receipt(f.connection.id,{...event,eventId:"late-sent",status:"sent"});
    expect((await worker.readDeliveries(f.scope,f.conversationId)).at(-1).state).toBe("failed");
  });
  it("preserves the full provider retry cooldown for the connection",async()=>{
    const f=await fixture("whatsapp");let calls=0;const worker=delivery(async()=>{calls++;return Response.json({error:{code:80007}},{status:429,headers:{"retry-after":"99999"}});});
    await reply(f);await worker.drain(2);expect(calls).toBe(1);
    const quota=(await pool.query("SELECT extract(epoch FROM next_send_at-now())::float8 seconds FROM agents_platform.channel_send_limits WHERE connection_id=$1",[f.connection.id])).rows[0];
    expect(quota.seconds).toBeGreaterThan(99990);expect((await worker.readDeliveries(f.scope,f.conversationId))[0].state).toBe("pending");
  });
  it("uses native echo timestamps for watermark receipts and reconciles an echo arriving after the receipt",async()=>{
    const f=await fixture("facebook"),worker=delivery(async()=>Response.json({message_id:"native-55"}));
    await reply(f);await worker.drain(1);
    const watermark=Date.now(),event=channelWebhookEventSchema.parse({kind:"receipt",assetId:f.assetId,eventId:"read-watermark",externalConversationId:f.thread,senderId:"1234",providerMessageId:null,occurredAt:null,status:"read",receiptWatermark:String(watermark)});
    await worker.receipt(f.connection.id,event);expect((await worker.readDeliveries(f.scope,f.conversationId))[0].state).toBe("accepted");
    await worker.persist("facebook",[channelWebhookEventSchema.parse({kind:"message",assetId:f.assetId,eventId:"echo-55",externalConversationId:f.thread,senderId:f.assetId,providerMessageId:"native-55",occurredAt:new Date(watermark-100).toISOString(),text:"Hello",echo:true})]);
    await worker.drain(1);expect((await worker.readDeliveries(f.scope,f.conversationId))[0].state).toBe("read");
  });
});
