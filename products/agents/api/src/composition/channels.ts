import type { Pool } from "pg";
import { z } from "zod";
import { ChannelStore } from "../product/channels/channel-store";
import { ChannelDelivery } from "../product/channels/channel-delivery";
import { MetaChannelSetup, MetaSetupSessions, metaSetupProfileSchema, metaSetupProfileDigest } from "../product/channels/meta-setup";
import { TelegramSetupService } from "../product/channels/telegram-setup";
import type { InboxStore } from "../product/inbox/inbox-store";
import { createBoundedFetch } from "../infrastructure/connected-network";
import { connectionVaultFromEnvironment } from "../infrastructure/vault";
import { PlatformError } from "../contracts/contracts";
import { ChannelAttachments } from "../product/channels/channel-attachments";
import { WhatsappTemplates } from "../product/channels/whatsapp-templates";
import { EvaluationChannelFixtures } from "../product/evaluation/channel-fixtures";
import { assertChannelReplyPolicy } from "../product/channels/channel-policy";
import { ChannelMediaReplies } from "../product/channels/channel-media-replies";

/** Installed setup services are the only callers; destinations and credentials remain server controlled. */
export const channelSetupFetch: typeof fetch = async (input, init={}) => {
  const url = new URL(String(input)), bearer = new Headers(init.headers).get("authorization");
  return createBoundedFetch({authorizeUrl: destination => ["graph.facebook.com","graph.instagram.com","api.instagram.com","api.telegram.org"].includes(destination.hostname)
      && destination.origin===url.origin,
    headers:bearer?{authorization:bearer}:{},deadlineAt:Date.now()+15000,maxAttempts:1,maxRequests:1,
    maxRequestBytes:32768,maxResponseBytes:1048576,returnProviderErrorResponses:true,returnAuthenticationResponses:true})(input,{...init,redirect:"error"});
};
export function composeChannels(pool: Pool,inbox: InboxStore,publicUrl: string,signal?: AbortSignal) {
  const vault=connectionVaultFromEnvironment(),channels=new ChannelStore(pool,vault);
  let profiles: z.infer<typeof metaSetupProfileSchema>[]=[];
  if(process.env.AGENTS_META_CHANNEL_PROFILES) {
    try {profiles=z.array(metaSetupProfileSchema).max(4).parse(JSON.parse(process.env.AGENTS_META_CHANNEL_PROFILES));}
    catch {throw new PlatformError("CHANNEL_SETUP_CONFIGURATION_INVALID",503,"Channel setup configuration is invalid");}
    if(profiles.some(profile=>profile.redirectUri!==`${new URL(publicUrl).origin}/app/connections`)) throw new PlatformError("CHANNEL_CALLBACK_INVALID",503,"Channel callback does not match the application");
  }
  const webhookOrigin=process.env.AGENTS_CHANNEL_WEBHOOK_ORIGIN;
  const telegram = vault&&webhookOrigin ? new TelegramSetupService(channels,{fetch:channelSetupFetch,
    callbackUrl:id=>`${new URL(webhookOrigin).origin}/api/channel-webhooks/telegram/${id}`}) : undefined;
  const meta=vault&&profiles.length ? new MetaChannelSetup(channels,new MetaSetupSessions(pool,vault,600),profiles,channelSetupFetch) : undefined;
  const templates=new WhatsappTemplates(channels,channelSetupFetch);
  const mediaHostSuffixes=["fbsbx.com","fbcdn.net","cdninstagram.com","whatsapp.net"];
  const attachmentFetch:typeof fetch=async(input,init={})=>{
    const url=new URL(String(input)),bearer=new Headers(init.headers).get("authorization");
    return createBoundedFetch({authorizeUrl:destination=>destination.origin===url.origin&&(["graph.facebook.com","graph.instagram.com","api.telegram.org","lookaside.fbsbx.com"].includes(destination.hostname)||mediaHostSuffixes.some(suffix=>destination.hostname===suffix||destination.hostname.endsWith(`.${suffix}`))),
      headers:bearer?{authorization:bearer}:{},maxRequestBytes:32768,maxResponseBytes:2097152,deadlineAt:Date.now()+15000,maxAttempts:1,maxRequests:1,
      returnProviderErrorResponses:true,returnAuthenticationResponses:true,signal})(input,{...init,redirect:"error"});
  };
  const attachments=new ChannelAttachments(channels,{fetch:attachmentFetch,maximumBytes:2097152,mediaHostSuffixes});
  const media=new ChannelMediaReplies(channels,{mediaHostSuffixes});
  let fixtures:EvaluationChannelFixtures|undefined;
  const delivery=new ChannelDelivery(pool,channels,inbox,{
    async acknowledgeInteraction(connectionId,event) {
      if(!event.callbackQueryId)return;
      const binding=await channels.resolveDeployment("telegram",event.assetId);
      if(!binding||binding.connection.id!==connectionId)throw new PlatformError("CHANNEL_AUTHORITY_CHANGED",403,"Channel authority changed");
      if(binding.connection.metadata.evaluationFixture||binding.connection.metadata.evaluationTrialId)
        throw new PlatformError("EVALUATION_CHANNEL_CALLBACK_UNSUPPORTED",403,"Interactive callbacks are unavailable in this fixture");
      const credentials=await channels.resolveCredential({organizationId:binding.connection.organizationId,connectionId,
        expectedRevision:binding.connection.revision,credentialRevision:binding.connection.credentialRevision});
      if(!/^\d+:[A-Za-z0-9_-]{1,256}$/.test(credentials.botToken??""))throw new PlatformError("CHANNEL_CREDENTIAL_UNAVAILABLE",503,"Channel credential is unavailable");
      const response=await channelSetupFetch(`https://api.telegram.org/bot${credentials.botToken}/answerCallbackQuery`,{
        method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({callback_query_id:event.callbackQueryId,text:"This action is unavailable. Send a message for help.",show_alert:false})});
      if(!response.ok)throw new PlatformError("CHANNEL_CALLBACK_UNAVAILABLE",502,"Channel callback acknowledgement is unavailable");
    },
    context(connection,credentials,beforeAttempt) {
      const fixture=fixtures?.fixtureProviderContext(connection,beforeAttempt);
      if(fixture)return fixture;
      if(connection.metadata.evaluationFixture)throw new PlatformError("EVALUATION_CHANNEL_SCOPE_DENIED",403,"Isolated channel transport is unavailable");
      const credential=connection.kind==="telegram"?credentials.botToken:credentials.accessToken;
      const profile=profiles.find(profile=>profile.kind===connection.kind&&profile.mode===connection.mode);
      if(!credential||connection.kind!=="telegram"&&!profile)throw new PlatformError("CHANNEL_PROVIDER_UNAVAILABLE",503,"Channel provider is unavailable");
      const host=connection.kind==="telegram"?"api.telegram.org":connection.mode==="instagram_login"?"graph.instagram.com":"graph.facebook.com";
      const fetch=createBoundedFetch({authorizeUrl:url=>url.hostname===host && (connection.kind!=="telegram"||url.pathname.startsWith(`/bot${credential}/`)),
        headers:connection.kind==="telegram"?{}:{authorization:`Bearer ${credential}`},deadlineAt:Date.now()+15000,maxAttempts:1,maxRequests:1,
        maxRequestBytes:32768,maxResponseBytes:1048576,returnProviderErrorResponses:true,returnAuthenticationResponses:true,beforeAttempt,signal});
      return {credential,fetch,signal,mode:connection.mode,apiVersion:profile?.apiVersion,
        pageId:typeof connection.metadata.pageId==="string"?connection.metadata.pageId:undefined};
    },
    async assertPolicy(connection,message,request) {
      if(signal?.aborted)throw new PlatformError("CHANNEL_CANCELLED",409,"Channel worker is stopping");
      if(await fixtures?.assertFixturePolicy(connection,message,request))return;
      if(connection.metadata.evaluationFixture)throw new PlatformError("EVALUATION_CHANNEL_SCOPE_DENIED",403,"Isolated channel transport is unavailable");
      if(connection.metadata.expiresAt&&Date.parse(connection.metadata.expiresAt)<=Date.now())throw new PlatformError("CHANNEL_RECONNECT_REQUIRED",409,"Reconnect this channel");
      if(request.attachments?.length)await media.assertDispatch({organizationId:connection.organization_id,connectionId:connection.id,
        conversationId:message.conversation_id,ownershipGeneration:String(message.ownership_generation),actorAccountId:message.author_account_id,
        messageBody:message.body,request});
      if(connection.kind==="telegram")return;
      const profile=profiles.find(profile=>profile.kind===connection.kind&&profile.mode===connection.mode);
      if(!profile)throw new PlatformError("CHANNEL_PROVIDER_UNAVAILABLE",503,"Channel provider is unavailable");
      if(connection.metadata.setupProfileDigest!==metaSetupProfileDigest(profile))throw new PlatformError("CHANNEL_RECONNECT_REQUIRED",409,"Reconnect this channel after its provider configuration changed");
      if(request.template){await templates.assertDispatch({organizationId:connection.organization_id,connectionId:connection.id,
        conversationId:message.conversation_id,ownershipGeneration:String(message.ownership_generation),messageBody:message.body,request});return;}
      const latest=(await pool.query(`SELECT max(f.provider_occurred_at) occurred_at FROM agents_platform.customer_messages m
        JOIN agents_platform.channel_message_facts f ON f.message_id=m.id WHERE m.conversation_id=$1 AND m.author_kind='visitor'`,[message.conversation_id])).rows[0]?.occurred_at;
      // Standard service replies only. No HUMAN_AGENT or ad/opt-in exception is inferred from a staff takeover.
      assertChannelReplyPolicy({kind:connection.kind,mode:connection.mode,now:Date.now(),latestCustomerAt:latest?.getTime()??null,
        author:message.author_kind,assignedHuman:message.author_kind==="human",relatedInquiryConfirmed:false,
        humanAgentApproved:false,humanAgentTransportEnabled:false});
    },
  });
  if(vault)fixtures=new EvaluationChannelFixtures(pool,vault,delivery,inbox);
  return {channels,telegram,meta,profiles,delivery,templates,attachments,media,fixtures,vaultAvailable:Boolean(vault),webhookOrigin};
}
