import { z } from "zod";
import type { PoolClient } from "pg";
import type { ActionScope } from "../../contracts/connections";
import { channelAttachmentSchema, type ChannelAttachment, type ChannelSendRequest } from "../../contracts/channel-adapters";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { requireActionMember } from "../../infrastructure/action-authority";
import { transaction } from "../../infrastructure/database";
import type { ChannelStore } from "./channel-store";
import { channelRecipient } from "./channel-recipient";
const fail = (code = "CHANNEL_MEDIA_AUTHORITY_CHANGED", status = 409) => new PlatformError(code,status,"This attachment cannot be sent");
export const channelMediaAuthorizationSchema = z.strictObject({ sourceMessageId:z.uuid(),index:z.number().int().min(0).max(15),sourceDigest:z.string().regex(/^[a-f0-9]{64}$/),
  connectionRevision:z.number().int().positive(),credentialRevision:z.number().int().positive(),ownershipGeneration:z.string().regex(/^[1-9][0-9]*$/),actorAccountId:z.uuid(),payloadDigest:z.string().regex(/^[a-f0-9]{64}$/) });
export type ChannelMediaAuthorization = z.infer<typeof channelMediaAuthorizationSchema>;
export interface PreparedChannelMedia { body:string; requestText:string; attachment:ChannelAttachment; authorization:ChannelMediaAuthorization }
export class ChannelMediaReplies {
  constructor(private readonly channels:ChannelStore,private readonly options:{mediaHostSuffixes:readonly string[]}) {
    z.array(z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/)).parse(options.mediaHostSuffixes);
  }
  private async source(db:PoolClient,scope:ActionScope,input:{conversationId:string;sourceMessageId:string;index:number;expectedRevision?:string}) {
    await requireActionMember(db,scope);
    const row=(await db.query(`SELECT c.id conversation_id,c.revision conversation_revision,c.ownership_generation,c.assignee_account_id,c.state conversation_state,
      c.external_sender_id,c.external_conversation_id,n.*,f.attachments,f.provider_message_id
      FROM agents_platform.customer_conversations c JOIN agents_platform.customer_messages m ON m.conversation_id=c.id
      JOIN agents_platform.channel_message_facts f ON f.message_id=m.id
      JOIN agents_platform.channel_deployments d ON d.id=c.channel_deployment_id AND d.organization_id=c.organization_id
      JOIN agents_platform.channel_connections n ON n.id=d.connection_id AND n.organization_id=c.organization_id AND n.id=f.connection_id
      WHERE c.organization_id=$1 AND c.id=$2 AND m.id=$3 AND m.author_kind='visitor' AND n.kind=c.channel_kind
        AND f.external_conversation_id=c.external_conversation_id AND n.state='active' AND d.state='active'
      FOR SHARE OF c,m,f,d,n`,[scope.organizationId,input.conversationId,input.sourceMessageId])).rows[0];
    if(!row)throw fail("CHANNEL_MEDIA_SOURCE_UNAVAILABLE",404);
    if(row.conversation_state!=="human_owned"||row.assignee_account_id!==scope.accountId)throw fail("ACCESS_DENIED",403);
    if(input.expectedRevision!==undefined&&String(row.conversation_revision)!==input.expectedRevision)throw fail("INBOX_CONFLICT");
    const parsed=channelAttachmentSchema.safeParse(Array.isArray(row.attachments)?row.attachments[input.index]:undefined);
    if(!parsed.success)throw fail("CHANNEL_MEDIA_SOURCE_UNAVAILABLE",404);
    const definition=this.channels.catalogue.find(item=>item.kind===row.kind);
    if(!definition?.capabilities.outboundAttachments.includes(parsed.data.kind))throw fail("CHANNEL_MEDIA_TYPE_UNSUPPORTED",400);
    const sourceDigest=requestDigest({sourceMessageId:input.sourceMessageId,index:input.index,attachment:parsed.data,connectionId:row.id,externalConversationId:row.external_conversation_id,providerMessageId:row.provider_message_id});
    return {row,attachment:parsed.data,sourceDigest};
  }
  private reference(kind:string,source:ChannelAttachment):ChannelAttachment {
    const {url:_,providerMediaId:__,...metadata}=source;
    if(kind==="telegram"||kind==="whatsapp") {
      if(!source.providerMediaId)throw fail("CHANNEL_MEDIA_REFERENCE_UNSUPPORTED",400);
      return {...metadata,providerMediaId:source.providerMediaId};
    }
    if(kind!=="facebook"&&kind!=="instagram")throw fail("CHANNEL_MEDIA_TYPE_UNSUPPORTED",400);
    let url:URL;try{url=new URL(source.url!);}catch{throw fail("CHANNEL_MEDIA_URL_DENIED",400);}
    if(url.protocol!=="https:"||url.username||url.password||url.hash||url.port&&url.port!=="443"||
      !this.options.mediaHostSuffixes.some(suffix=>url.hostname===suffix||url.hostname.endsWith(`.${suffix}`)))throw fail("CHANNEL_MEDIA_URL_DENIED",400);
    return {...metadata,url:url.href};
  }
  private content(kind:string,attachment:ChannelAttachment,caption:string) {
    if(caption&&(kind==="facebook"||kind==="instagram"||kind==="whatsapp"&&attachment.kind==="audio"))throw fail("CHANNEL_MEDIA_CAPTION_UNSUPPORTED",400);
    return {body:caption||`${attachment.kind.charAt(0).toUpperCase()+attachment.kind.slice(1)} attachment${attachment.fileName?`: ${attachment.fileName.replace(/[\u0000-\u001f\u007f]/g," ")}`:""}`,requestText:caption};
  }
  async prepare(scope:ActionScope,raw:unknown):Promise<PreparedChannelMedia> {
    const input=z.strictObject({conversationId:z.uuid(),expectedRevision:z.string().regex(/^[1-9][0-9]*$/),sourceMessageId:z.uuid(),index:z.number().int().min(0).max(15),caption:z.string().trim().refine(value=>[...value].length<=1024).default("")}).parse(raw);
    return transaction(this.channels.pool,async db=>{
      const source=await this.source(db,scope,input),attachment=this.reference(source.row.kind,source.attachment),content=this.content(source.row.kind,attachment,input.caption);
      return {...content,attachment,authorization:{sourceMessageId:input.sourceMessageId,index:input.index,sourceDigest:source.sourceDigest,
        connectionRevision:source.row.revision,credentialRevision:source.row.credential_revision,ownershipGeneration:String(source.row.ownership_generation),actorAccountId:scope.accountId,
        payloadDigest:requestDigest({...content,attachment})}};
    });
  }
  async assertDispatch(input:{organizationId:string;connectionId:string;conversationId:string;ownershipGeneration:string;actorAccountId:string;messageBody:string;request:ChannelSendRequest&{mediaAuthorization?:unknown}}):Promise<void> {
    const authorization=channelMediaAuthorizationSchema.parse(input.request.mediaAuthorization);
    if(authorization.actorAccountId!==input.actorAccountId||authorization.ownershipGeneration!==input.ownershipGeneration||input.request.template||input.request.attachments?.length!==1)throw fail();
    await transaction(this.channels.pool,async db=>{
      const source=await this.source(db,{organizationId:input.organizationId,accountId:input.actorAccountId},{conversationId:input.conversationId,sourceMessageId:authorization.sourceMessageId,index:authorization.index});
      const attachment=this.reference(source.row.kind,source.attachment),content=this.content(source.row.kind,attachment,input.request.text);
      if(source.row.id!==input.connectionId||source.row.revision!==authorization.connectionRevision||source.row.credential_revision!==authorization.credentialRevision||
        String(source.row.ownership_generation)!==authorization.ownershipGeneration||channelRecipient(source.row.kind,source.row.asset_id,source.row.external_conversation_id)!==input.request.recipientId||source.row.asset_id!==input.request.assetId||
        source.sourceDigest!==authorization.sourceDigest||requestDigest(attachment)!==requestDigest(input.request.attachments![0])||content.body!==input.messageBody||
        requestDigest({...content,attachment})!==authorization.payloadDigest)throw fail();
    });
  }
}
