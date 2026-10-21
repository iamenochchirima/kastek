import type { FastifyInstance,FastifyRequest } from "fastify";
import { z } from "zod";
import type { InboxScope,InboxStore } from "../inbox/inbox-store";
import { inboxConversation } from "../inbox/inbox-routes";
import type { ChannelDelivery } from "./channel-delivery";
import type { ChannelAttachments } from "./channel-attachments";
import type { WhatsappTemplates } from "./whatsapp-templates";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import type { ChannelMediaReplies } from "./channel-media-replies";

export function registerChannelSupportRoutes(app:FastifyInstance,options:{inbox:InboxStore;delivery:ChannelDelivery;attachments:ChannelAttachments;
  templates:WhatsappTemplates;media:ChannelMediaReplies;resolveScope(request:FastifyRequest):Promise<InboxScope>}) {
  const base="/api/organizations/:organizationId/inbox/:conversationId";
  const id=(request:FastifyRequest)=>z.uuid().parse((request.params as Record<string,string>).conversationId);
  app.get(`${base}/messages/:messageId/attachments/:index`,async(request,reply)=>{
    const params=z.object({messageId:z.uuid(),index:z.coerce.number().int().min(0).max(15)}).parse(request.params);
    const attachment=await options.attachments.download(await options.resolveScope(request),{conversationId:id(request),...params});
    return reply.header("cache-control","private, no-store").header("x-content-type-options","nosniff")
      .header("content-disposition",`attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`).type(attachment.contentType).send(attachment.body);
  });
  app.get(`${base}/whatsapp/templates`,async request=>{
    const scope=await options.resolveScope(request),{conversation}=await options.inbox.readStaff(scope,id(request),"0",1);
    const connectionId=(conversation as typeof conversation & {connection_id:string}).connection_id;
    if(conversation.channel_kind!=="whatsapp"||!connectionId)throw new PlatformError("CHANNEL_TEMPLATE_UNSUPPORTED",409,"This conversation does not use WhatsApp");
    return options.templates.list(scope,{connectionId,...z.object({cursor:z.string().min(1).max(2048).optional()}).parse(request.query)});
  });
  app.get(`${base}/whatsapp/consent`,async request=>options.templates.consent(await options.resolveScope(request),id(request)));
  app.post(`${base}/whatsapp/consent`,async request=>options.templates.recordConsent(await options.resolveScope(request),{...z.record(z.string(),z.unknown()).parse(request.body),conversationId:id(request)}));
  app.post(`${base}/whatsapp/template-reply`,async request=>{
    const scope=await options.resolveScope(request),conversationId=id(request);
    const input=z.strictObject({commandId:z.uuid(),expectedRevision:z.string().regex(/^[1-9][0-9]{0,17}$/),templateId:z.string().min(1).max(512),
      parameters:z.strictObject({header:z.array(z.string()).max(32).default([]),body:z.array(z.string()).max(32).default([])})}).parse(request.body);
    await options.inbox.readStaff(scope,conversationId,"0",1);
    const digest=requestDigest({templateReply:input});
    const existing=(await options.inbox.pool.query("SELECT * FROM agents_platform.customer_commands WHERE conversation_id=$1 AND command_id=$2",[conversationId,input.commandId])).rows[0];
    if(existing){
      if(existing.actor_account_id!==scope.accountId||existing.action!=="reply"||existing.request_digest!==digest)throw new PlatformError("INBOX_CONFLICT",409,"This reply identifier was used for another request");
      return {conversation:inboxConversation(existing.result)};
    }
    const prepared=await options.templates.prepare(scope,{conversationId,expectedRevision:input.expectedRevision,templateId:input.templateId,parameters:input.parameters});
    const conversation=await options.inbox.command(scope,conversationId,{commandId:input.commandId,expectedRevision:input.expectedRevision,action:"reply",body:prepared.preview},
      {template:prepared.template,templateAuthorization:prepared.authorization},digest);
    return {conversation:inboxConversation(conversation)};
  });
  app.post(`${base}/deliveries/:deliveryId/continue`,async request=>{
    const deliveryId=z.uuid().parse((request.params as Record<string,string>).deliveryId),input=z.strictObject({expectedRevision:z.string().regex(/^[1-9][0-9]{0,17}$/),decision:z.literal("continue_without_resending")}).parse(request.body);
    return options.delivery.continueAfterUnknown(await options.resolveScope(request),id(request),deliveryId,input.expectedRevision);
  });
  app.post(`${base}/media-reply`,async request=>{
    const scope=await options.resolveScope(request),conversationId=id(request);
    const input=z.strictObject({commandId:z.uuid(),expectedRevision:z.string().regex(/^[1-9][0-9]{0,17}$/),sourceMessageId:z.uuid(),index:z.number().int().min(0).max(15),caption:z.string().max(4096).optional()}).parse(request.body);
    await options.inbox.readStaff(scope,conversationId,"0",1);
    const digest=requestDigest({mediaReply:input}),existing=(await options.inbox.pool.query("SELECT * FROM agents_platform.customer_commands WHERE conversation_id=$1 AND command_id=$2",[conversationId,input.commandId])).rows[0];
    if(existing){if(existing.actor_account_id!==scope.accountId||existing.action!=="reply"||existing.request_digest!==digest)throw new PlatformError("INBOX_CONFLICT",409,"This reply identifier was used for another request");return {conversation:inboxConversation(existing.result)};}
    const prepared=await options.media.prepare(scope,{conversationId,expectedRevision:input.expectedRevision,sourceMessageId:input.sourceMessageId,index:input.index,...(input.caption===undefined?{}:{caption:input.caption})});
    const conversation=await options.inbox.command(scope,conversationId,{commandId:input.commandId,expectedRevision:input.expectedRevision,action:"reply",body:prepared.body},
      {attachment:prepared.attachment,requestText:prepared.requestText,mediaAuthorization:prepared.authorization},digest);
    return {conversation:inboxConversation(conversation)};
  });
}
