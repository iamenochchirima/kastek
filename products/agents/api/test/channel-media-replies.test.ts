import {randomBytes,randomUUID} from "node:crypto";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {setupPlatformSchema} from "../src/composition/setup";
import {PlatformStore} from "../src/product/agents/store";
import {ChannelStore} from "../src/product/channels/channel-store";
import {ChannelMediaReplies} from "../src/product/channels/channel-media-replies";
import {ConnectionVault} from "../src/infrastructure/vault";
import {dropClosedTestDatabase} from "./support/database-cleanup";
import type {ChannelAttachment} from "../src/contracts/channel-adapters";
const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("canonical received media reply authority",()=>{
  const database=`agents_media_reply_${randomUUID().replaceAll("-","")}`;let admin:Pool,pool:Pool,platform:PlatformStore,channels:ChannelStore,service:ChannelMediaReplies;
  beforeAll(async()=>{admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);platform=new PlatformStore(pool);channels=new ChannelStore(pool,new ConnectionVault("fixture",{fixture:randomBytes(32).toString("base64")}));service=new ChannelMediaReplies(channels,{mediaHostSuffixes:["fbcdn.net","cdninstagram.com"]});});
  afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  async function fixture(kind:"telegram"|"whatsapp"|"facebook"|"instagram"="telegram",attachment:ChannelAttachment={kind:"image",providerMediaId:"native-file"}){
    const account=await platform.ensureAccount({issuer:"https://media.fixture.test",subject:randomUUID(),email:"owner@media.test",displayName:"Owner"}),organization=await platform.createOrganization(account.id,"Media replies"),scope={accountId:account.id,organizationId:organization.id};
    const agent=await platform.createConfiguredAgent({...scope,name:"Support",offering:"faq"}),assetId=String(BigInt(`0x${randomUUID().replaceAll("-","").slice(0,12)}`));
    const connection=await channels.create(scope,{kind,mode:kind==="telegram"?"bot":kind==="whatsapp"?"cloud_api":"meta",assetId,name:"Support channel",state:"active",credentials:kind==="telegram"?{botToken:`${assetId}:private`}:{accessToken:"private"}});
    const deployment=await channels.bind(scope,connection.id,{expectedRevision:1,agentId:agent.agent.id}),conversationId=randomUUID(),sourceMessageId=randomUUID();
    await pool.query(`INSERT INTO agents_platform.customer_conversations(id,organization_id,agent_id,version_id,channel_kind,channel_deployment_id,external_conversation_id,external_sender_id,state,assignee_account_id)
      VALUES($1,$2,$3,$4,$5,$6,$8,'recipient','human_owned',$7)`,[conversationId,scope.organizationId,agent.agent.id,deployment.versionId,kind,deployment.id,scope.accountId,["facebook","instagram"].includes(kind)?`${assetId}:recipient`:"customer-thread"]);
    await pool.query("INSERT INTO agents_platform.customer_messages(id,conversation_id,sequence,author_kind,body,request_key,request_digest,ownership_generation) VALUES($1,$2,1,'visitor','Received attachment','fixture','fixture',1)",[sourceMessageId,conversationId]);
    await pool.query("INSERT INTO agents_platform.channel_message_facts(message_id,connection_id,external_conversation_id,provider_message_id,attachments) VALUES($1,$2,$4,'provider-message',$3)",[sourceMessageId,connection.id,JSON.stringify([attachment]),["facebook","instagram"].includes(kind)?`${assetId}:recipient`:"customer-thread"]);
    return{scope,connection,assetId,conversationId,sourceMessageId,index:0,expectedRevision:"1"};
  }
  async function prepared(item:Awaited<ReturnType<typeof fixture>>,caption=""){
    const output=await service.prepare(item.scope,{conversationId:item.conversationId,expectedRevision:item.expectedRevision,sourceMessageId:item.sourceMessageId,index:0,caption});
    const dispatch={organizationId:item.scope.organizationId,connectionId:item.connection.id,conversationId:item.conversationId,ownershipGeneration:"1",actorAccountId:item.scope.accountId,messageBody:output.body,request:{assetId:item.assetId,recipientId:["facebook","instagram"].includes(item.connection.kind)?"recipient":"customer-thread",text:output.requestText,attachments:[output.attachment],mediaAuthorization:output.authorization}};
    return{output,dispatch};
  }
  it("prepares native Telegram/WhatsApp references without provider I/O and binds exact caption",async()=>{
    for(const kind of ["telegram","whatsapp"] as const){const item=await fixture(kind),{output,dispatch}=await prepared(item,"Reviewed caption");expect(output.body).toBe("Reviewed caption");expect(output.requestText).toBe("Reviewed caption");expect(output.attachment).toEqual({kind:"image",providerMediaId:"native-file"});await service.assertDispatch(dispatch);await expect(service.assertDispatch({...dispatch,request:{...dispatch.request,text:"Changed"}})).rejects.toMatchObject({code:"CHANNEL_MEDIA_AUTHORITY_CHANGED"});}
  });
  it("uses only allowlisted Meta URLs, preserves canonical labels and rejects unsupported captions/types",async()=>{
    for(const kind of ["facebook","instagram"] as const){const item=await fixture(kind,{kind:"image",url:"https://media.fbcdn.net/verified-image?signature=private"}),{output,dispatch}=await prepared(item);expect(output.body).toBe("Image attachment");expect(output.requestText).toBe("");await service.assertDispatch(dispatch);await expect(prepared(item,"Caption")).rejects.toMatchObject({code:"CHANNEL_MEDIA_CAPTION_UNSUPPORTED"});}
    const document=await fixture("instagram",{kind:"document",url:"https://cdninstagram.com/file"});await expect(prepared(document)).rejects.toMatchObject({code:"CHANNEL_MEDIA_TYPE_UNSUPPORTED"});
    const audio=await fixture("whatsapp",{kind:"audio",providerMediaId:"voice"});await expect(prepared(audio,"Caption")).rejects.toMatchObject({code:"CHANNEL_MEDIA_CAPTION_UNSUPPORTED"});
  });
  it("rejects arbitrary URLs, missing native IDs and different conversations or tenants",async()=>{
    for(const url of ["https://127.0.0.1/private","https://fbcdn.net.evil.example/file","https://user:pass@fbcdn.net/file"]){const item=await fixture("facebook",{kind:"image",url});await expect(prepared(item)).rejects.toMatchObject({code:"CHANNEL_MEDIA_URL_DENIED"});}
    const item=await fixture("telegram",{kind:"image",url:"https://fbcdn.net/file"}),other=await fixture();await expect(prepared(item)).rejects.toMatchObject({code:"CHANNEL_MEDIA_REFERENCE_UNSUPPORTED"});
    await expect(service.prepare(other.scope,{conversationId:item.conversationId,expectedRevision:"1",sourceMessageId:item.sourceMessageId,index:0})).rejects.toMatchObject({code:"CHANNEL_MEDIA_SOURCE_UNAVAILABLE"});
    await expect(service.prepare(item.scope,{conversationId:item.conversationId,expectedRevision:"1",sourceMessageId:other.sourceMessageId,index:0})).rejects.toMatchObject({code:"CHANNEL_MEDIA_SOURCE_UNAVAILABLE"});
  });
  it("fences stale revisions, source substitution, recipient edits, rotation and current assignment",async()=>{
    const item=await fixture(),{dispatch}=await prepared(item);
    await expect(service.prepare(item.scope,{conversationId:item.conversationId,expectedRevision:"2",sourceMessageId:item.sourceMessageId,index:0})).rejects.toMatchObject({code:"INBOX_CONFLICT"});
    await expect(service.assertDispatch({...dispatch,request:{...dispatch.request,recipientId:"other"}})).rejects.toMatchObject({code:"CHANNEL_MEDIA_AUTHORITY_CHANGED"});
    await pool.query("UPDATE agents_platform.channel_message_facts SET attachments=$2 WHERE message_id=$1",[item.sourceMessageId,JSON.stringify([{kind:"image",providerMediaId:"substituted"}])]);await expect(service.assertDispatch(dispatch)).rejects.toMatchObject({code:"CHANNEL_MEDIA_AUTHORITY_CHANGED"});
    await pool.query("UPDATE agents_platform.channel_message_facts SET attachments=$2 WHERE message_id=$1",[item.sourceMessageId,JSON.stringify([{kind:"image",providerMediaId:"native-file"}])]);
    await channels.update(item.scope,item.connection.id,{expectedRevision:1,credentials:{botToken:`${item.assetId}:rotated`}});await expect(service.assertDispatch(dispatch)).rejects.toMatchObject({code:"CHANNEL_MEDIA_AUTHORITY_CHANGED"});
    const next=await prepared(item),teammate=await platform.ensureAccount({issuer:"https://media.fixture.test",subject:randomUUID(),email:"teammate@media.test",displayName:"Teammate"});
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[item.scope.organizationId,teammate.id]);
    await pool.query("UPDATE agents_platform.customer_conversations SET assignee_account_id=$2,ownership_generation=ownership_generation+1 WHERE id=$1",[item.conversationId,teammate.id]);await expect(service.assertDispatch(next.dispatch)).rejects.toMatchObject({code:"ACCESS_DENIED"});
  });
  it("rejects revoked memberships at dispatch and inactive bindings before preparation",async()=>{
    const item=await fixture(),{dispatch}=await prepared(item);await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[item.scope.organizationId,item.scope.accountId]);await expect(service.assertDispatch(dispatch)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    const other=await fixture();await channels.disconnect(other.scope,other.connection.id,1);await expect(prepared(other)).rejects.toMatchObject({code:"CHANNEL_MEDIA_SOURCE_UNAVAILABLE"});
  });
});
