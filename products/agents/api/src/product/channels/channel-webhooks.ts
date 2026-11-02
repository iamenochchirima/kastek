import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ChannelAdapterError, type MessagingChannelKind } from "../../contracts/channel-adapters";
import { PlatformError } from "../../contracts/contracts";
import { messagingChannelAdapter } from "../../adapters/channels/providers";
import type { ChannelStore } from "./channel-store";
import type { ChannelDelivery } from "./channel-delivery";
import { metaSetupProfileDigest, type MetaSetupProfile } from "./meta-setup";

export async function registerChannelWebhooks(app: FastifyInstance,options:{channels:ChannelStore;delivery:ChannelDelivery;profiles:readonly MetaSetupProfile[]}) {
  // Encapsulation keeps signed bytes intact without changing ordinary JSON application routes.
  await app.register(async webhooks=>{
    webhooks.removeContentTypeParser("application/json");
    webhooks.addContentTypeParser("application/json",{parseAs:"buffer",bodyLimit:128000},(_request,body,done)=>done(null,body));
    webhooks.get("/api/channel-webhooks/:kind/:mode",async(request,reply)=>{
      const {kind,mode}=z.object({kind:z.enum(["facebook","instagram","whatsapp"]),mode:z.enum(["meta","instagram_login","cloud_api"])}).parse(request.params);
      const profile=options.profiles.find(profile=>profile.kind===kind&&profile.mode===mode);
      if(!profile)throw new PlatformError("CHANNEL_WEBHOOK_UNAVAILABLE",404,"Channel webhook is unavailable");
      const query=z.record(z.string(),z.string()).parse(request.query);
      try {return reply.type("text/plain").send(messagingChannelAdapter(kind).verifyChallenge!(query,profile.webhookVerifyToken));}
      catch {throw new PlatformError("CHANNEL_WEBHOOK_DENIED",403,"Channel verification failed");}
    });
    webhooks.post("/api/channel-webhooks/:kind/:target",async(request,reply)=>{
      const {kind,target}=z.object({kind:z.enum(["facebook","instagram","whatsapp","telegram"]),target:z.string().min(1).max(64)}).parse(request.params);
      const adapter=messagingChannelAdapter(kind as MessagingChannelKind),raw=request.body;
      if(!Buffer.isBuffer(raw))throw new PlatformError("CHANNEL_WEBHOOK_INVALID",400,"Invalid webhook content");
      const telegram=kind==="telegram"?await options.channels.telegramWebhookSecret(z.uuid().parse(target)):null;
      const profile=kind!=="telegram"?options.profiles.find(profile=>profile.kind===kind&&profile.mode===target):null;
      if(!telegram&&!profile)throw new PlatformError("CHANNEL_WEBHOOK_UNAVAILABLE",404,"Channel webhook is unavailable");
      const headers=Object.fromEntries(Object.entries(request.headers).filter((entry):entry is [string,string]=>typeof entry[1]==="string"));
      try {adapter.verifyWebhook({rawBody:raw,headers,secrets:telegram?{webhookSecret:telegram.secret}:{appSecret:profile!.appSecret}});}
      catch {throw new PlatformError("CHANNEL_WEBHOOK_DENIED",403,"Channel verification failed");}
      let payload:unknown;try{payload=JSON.parse(raw.toString("utf8"));}catch{throw new PlatformError("CHANNEL_WEBHOOK_INVALID",400,"Invalid webhook content");}
      try {
        const events=adapter.normalize(payload,telegram?{assetId:telegram.assetId}:undefined);
        await options.delivery.persist(kind,events,profile?.mode,profile?metaSetupProfileDigest(profile):undefined);
        return reply.code(200).send({received:true});
      } catch(error) {
        if(error instanceof ChannelAdapterError)throw new PlatformError("CHANNEL_WEBHOOK_INVALID",400,"Unsupported webhook content");
        throw error;
      }
    });
  });
}
