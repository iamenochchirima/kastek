import type { ProductCapabilityInvocation, ProductReviewReference } from "@kasitek-labs/contracts";
import { z } from "zod";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { growthAgentDigest } from "../agents/security.js";
import { authorizeGrowthOperation } from "./policy.js";
import type { RequestContext } from "../identity/request-context.js";
import { assertReportingScope } from "../services/analytics-reporting.js";
import { authorizeGrowthAgentScope } from "../agents/scope.js";
import { getGrowthMediaTransfer } from "./media-transfers.js";

/** These references authorize an observed result. They are not business-content revisions. */
const referencePrefix = "growth-read-access:";
const scopePrefix = "growth-read-scope:";
const resourceKinds = ["connection", "social_account", "post", "post_variant", "post_media", "post_job", "post_job_account", "media", "media_preview", "media_transfer", "contact_membership", "contact", "customer", "customer_identity", "customer_contact", "customer_conversation", "customer_campaign", "customer_booking", "conversation", "conversation_social", "conversation_external", "conversation_whatsapp", "message", "message_attachment", "message_reaction", "message_reference", "message_reference_empty", "booking", "booking_service", "booking_customer", "booking_service_link", "campaign", "campaign_connection", "campaign_template", "template", "template_connection", "whatsapp_connection", "review", "review_effect", "legacy_review_effect", "batch", "batch_item", "batch_job", "batch_account", "analytics_scope"] as const;
type ResourceKind = typeof resourceKinds[number];
const resourceSchema = z.object({ kind: z.enum(resourceKinds), id: z.string().min(1).max(256), parent: z.string().min(1).max(256).optional() }).strict();
type Resource = z.infer<typeof resourceSchema>;
// Results are already limited to 2 MiB; one source row may create multiple
// relationship references. Keep this separate from the worker's scope limit.
const maxResultResources = 131_072;
const accessRecordSchema = z.object({ version: z.literal("1"), kind: z.literal("operation_read"), taskId: z.string().min(1).max(256),
  conversationId: z.string().min(1).max(256), operationId: z.string().min(1).max(256), bindingId: z.string().min(1).max(256),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/), operation: z.string().min(1).max(256), inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  resultDigest: z.string().regex(/^[a-f0-9]{64}$/), scopeReference:z.string().min(1).max(256), resources: z.array(resourceSchema).max(maxResultResources), expiresAt: z.number().int().positive().nullable() }).strict();
type AccessRecord = z.infer<typeof accessRecordSchema>;
const accessScopeSchema=z.object({version:z.literal("1"),kind:z.literal("operation_scope"),conversationId:z.string().min(1).max(256),
  bindingId:z.string().min(1).max(256),bindingDigest:z.string().regex(/^[a-f0-9]{64}$/),operation:z.string().min(1).max(256),
  resources:z.array(resourceSchema).max(maxResultResources),expiresAt:z.number().int().positive().nullable()}).strict();
type AccessScope=z.infer<typeof accessScopeSchema>;
export type GrowthReadDetails = { analyticsScope?: { id: string; root: string }; preflight?: unknown; batch?: unknown; inbox?: unknown; review?: unknown };
export type GrowthReadAccess = { version: "1"; reference: string; scopeReference:string; resultDigest: string };

const unavailable = () => new ApiError(409, "agent_read_access_unavailable", "The read result cannot be retained safely");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw unavailable(); return value; }
function identifier(value: unknown): string { if (typeof value !== "string" || !value || value.length > 256) throw unavailable(); return value; }
function optionalIdentifier(value: unknown): string | undefined { return value === null || value === undefined ? undefined : identifier(value); }

/** Build references from the unchunked product result, never from a JSON fragment. */
export function growthReadResources(operation: string, input: Record<string, unknown>, result: unknown, details: GrowthReadDetails = {}): { resources: Resource[]; expiresAt: number | null } {
  const value = object(result), resources: Resource[] = [], resourceKeys = new Set<string>();
  let expiresAt: number | null = null;
  const add = (kind: ResourceKind, id: unknown, parent?: unknown) => {
    const item: Resource = { kind, id: identifier(id), ...(parent === undefined || parent === null ? {} : { parent: identifier(parent) }) };
    const key = JSON.stringify([item.kind, item.id, item.parent ?? null]);
    if (!resourceKeys.has(key)) { resourceKeys.add(key); resources.push(item); }
    if (resources.length > maxResultResources) throw unavailable();
  };
  const list = (key: string, kind: ResourceKind) => { for (const row of array(value[key])) add(kind, object(row).id); };
  const addPost = (raw: unknown) => {
    const post = object(raw), postId = identifier(post.id); add("post", postId);
    if (post.primaryChannel !== null && post.primaryChannel !== undefined) add("social_account", object(post.primaryChannel).id);
    for (const item of array(post.variants)) { const variant = object(item); if (variant.post_id !== postId) throw unavailable(); add("post_variant", variant.id, postId); }
    for (const item of array(post.media)) { const media = object(item); if (media.post_id !== postId) throw unavailable(); add("post_media", media.id, postId); add("media", media.asset_id); }
    for (const item of array(post.publishJobs)) { const job = object(item); if (job.post_id !== postId) throw unavailable(); add("post_job", job.id, postId); if (optionalIdentifier(job.channel_connection_id)) {add("social_account", job.channel_connection_id);add("post_job_account",job.id,job.channel_connection_id);} }
  };
  const addBooking = (raw: unknown) => {
    const booking = object(raw), id = identifier(booking.id); add("booking", id);
    if (optionalIdentifier(booking.serviceId)) { add("booking_service", booking.serviceId); add("booking_service_link", id, booking.serviceId); }
    if (optionalIdentifier(booking.customerId)) { add("customer", booking.customerId); add("booking_customer", id, booking.customerId); }
  };
  const addCampaign = (raw: unknown) => {
    const campaign = object(raw), id = identifier(campaign.id); add("campaign", id);
    const connection = campaign.connectionId ?? campaign.connection_id, template = campaign.templateId ?? campaign.template_id;
    if (optionalIdentifier(connection)) { add("whatsapp_connection", connection); add("campaign_connection", id, connection); }
    if (optionalIdentifier(template)) { add("template", template); add("campaign_template", id, template); }
  };
  switch (operation) {
    case "workspace.read": if (object(value.workspace).id === undefined) throw unavailable(); break;
    case "connections.list": list("connections", "connection"); break;
    case "content.accounts.list": list("accounts", "social_account"); break;
    case "content.posts.list": for (const post of array(value.posts)) addPost(post); break;
    case "content.posts.get": if (object(value.post).id !== input.postId) throw unavailable(); addPost(value.post); break;
    case "content.posts.activity": {
      const postId = identifier(input.postId); if (value.postId !== postId) throw unavailable(); add("post", postId);
      for (const event of array(value.events)) { const row=object(event); if (row.source === "provider") { const match=typeof row.id === "string" ? /^job:([^:]+):/.exec(row.id) : null; if (!match) throw unavailable(); add("post_job",match[1],postId); } }
      break;
    }
    case "content.media.get": case "content.media.preview": {
      const assetId=identifier(input.assetId); if (object(value.asset).id !== assetId) throw unavailable(); add("media",assetId);
      if(operation==="content.media.preview") { add("media_preview",assetId);try { if(typeof value.previewUrl!=="string"||value.previewUrl.length>2048)throw unavailable();const expiry=Number(new URL(value.previewUrl).searchParams.get("expires"));
        if (!Number.isSafeInteger(expiry) || expiry * 1000 <= Date.now()) throw unavailable(); expiresAt=expiry*1000; } catch { throw unavailable(); } }
      break;
    }
    case "content.media.transfer.prepare": {
      add("media_transfer",value.transferId);
      const expiry=typeof value.expiresAt==="string"?Date.parse(value.expiresAt):NaN;
      if(!Number.isFinite(expiry)||expiry<=Date.now())throw unavailable();
      expiresAt=expiry;break;
    }
    case "operations.reviews.get": {const review=object(details.review);if(review.id!==input.reviewId||object(value.review).id!==review.id)throw unavailable();add("review",review.id,growthAgentDigest(review));break;}
    case "content.posts.publish_batch.preflight": {
      const plan=object(details.preflight),postId=identifier(input.postId);if(value.postId!==postId||object(plan.post).id!==postId)throw unavailable();
      addPost(plan.post);for(const target of array(plan.targets)){const row=object(target);add("post_job",row.jobId,postId);if(optionalIdentifier(row.channelConnectionId)){add("social_account",row.channelConnectionId);add("post_job_account",row.jobId,row.channelConnectionId);}}break;
    }
    case "content.posts.publish_batch.status": {
      const result=input.batchId?value:value.batch;
      if(result===null){add("post",input.postId);break;}
      const batch=object(result),detailsBatch=object(details.batch),batchId=identifier(batch.batchId),postId=identifier(batch.postId);
      if(detailsBatch.batchId!==batchId||detailsBatch.postId!==postId||input.batchId&&input.batchId!==batchId||input.postId&&!input.batchId&&input.postId!==postId)throw unavailable();
      add("post",postId);add("batch",batchId,postId);
      for(const target of array(detailsBatch.targets)){const row=object(target);add("batch_item",row.access_item_id,batchId);add("post_job",row.access_job_id,postId);add("batch_job",row.access_item_id,row.access_job_id);if(optionalIdentifier(row.access_channel_id)){add("social_account",row.access_channel_id);add("batch_account",row.access_item_id,row.access_channel_id);}}
      break;
    }
    case "content.posts.insights": if (value.postId !== input.postId) throw unavailable(); add("post",input.postId); break;
    case "content.insights.report": for(const post of array(value.posts))add("post",object(post).postId); break;
    case "contacts.list": for(const item of array(value.contacts)) {const row=object(item);add("contact_membership",row.id,row.contactId);add("contact",row.contactId);} break;
    case "customers.get": {
      const result=object(value.customer), customer=object(result.customer), id=identifier(input.customerId); if(customer.id!==id)throw unavailable();add("customer",id);
      for(const row of array(result.identities))add("customer_identity",object(row).id,id);
      for(const row of array(result.contacts))add("customer_contact",object(row).id,id);
      for(const row of array(result.conversations))add("customer_conversation",object(row).id,id);
      for(const row of array(result.campaigns))add("customer_campaign",object(row).id,id);
      for(const row of array(result.bookings)) {const booking=object(row);if(booking.customerId!==id)throw unavailable();add("customer_booking",booking.id,id);addBooking(booking);}
      break;
    }
    case "inbox.conversations.list": {
      const conversations=array(value.conversations),sources=array(details.inbox);
      if(sources.length!==conversations.length)throw unavailable();
      for(const item of conversations){const conversation=object(item),id=identifier(conversation.id),matching=sources.map(object).filter(source=>source.conversationId===id);
        if(matching.length!==1)throw unavailable();const source=matching[0]!;add("conversation",id);
        if(optionalIdentifier(source.messageId))add("message",source.messageId,id);
        if(source.connectionKind==="whatsapp"){add("whatsapp_connection",source.connectionId);add("conversation_whatsapp",id,source.connectionId);}
        else if(source.connectionKind==="social"){add("social_account",source.connectionId);add("connection",source.externalConnectionId);add("conversation_social",id,source.connectionId);add("conversation_external",id,source.externalConnectionId);}
        else if(source.connectionKind==="external"){add("connection",source.connectionId);add("conversation_external",id,source.connectionId);}else throw unavailable();
      }break;
    }
    case "inbox.messages.list": {
      const conversationId=identifier(input.conversationId);add("conversation",conversationId);
      for(const item of array(value.messages)){const message=object(item),id=identifier(message.id);
        if(message.conversationId!==conversationId||message.deletedAt!==null)throw unavailable();add("message",id,conversationId);
        for(const item of array(message.attachments))add("message_attachment",object(item).id,id);
        for(const item of array(message.reactions))add("message_reaction",object(item).id,id);
        if(message.reference!==null&&message.reference!==undefined){const reference=object(message.reference),target=optionalIdentifier(reference.messageId);
          if(target){add("message",target,conversationId);add("message_reference",id,target);}
          else {if(reference.previewText)throw unavailable();add("message_reference_empty",id);}}
      }break;
    }
    case "bookings.services.list": list("services","booking_service"); break;
    case "bookings.list": for(const row of array(value.bookings))addBooking(row);break;
    case "bookings.get": if(object(value.booking).id!==input.bookingId)throw unavailable();addBooking(value.booking);break;
    case "campaigns.list": for(const row of array(value.campaigns))addCampaign(row);break;
    case "campaigns.get": if(object(value.campaign).id!==input.campaignId)throw unavailable();addCampaign(value.campaign);break;
    case "templates.list": for(const item of array(value.templates)){const template=object(item);add("template",template.id);if(optionalIdentifier(template.connectionId)){add("whatsapp_connection",template.connectionId);add("template_connection",template.id,template.connectionId);}}break;
    case "analytics.read": if(!details.analyticsScope)throw unavailable();add("analytics_scope",details.analyticsScope.id,details.analyticsScope.root);break;
    default: throw unavailable();
  }
  resources.sort((a,b)=>{const left=`${a.kind}\0${a.id}\0${a.parent??""}`,right=`${b.kind}\0${b.id}\0${b.parent??""}`;return left<right?-1:left>right?1:0;});
  return {resources,expiresAt};
}

function scopedReference(command: ProductCapabilityInvocation, record: AccessRecord): string {
  return referencePrefix+growthAgentDigest({ tenantId:command.authority.tenantId,actor:command.actor,taskId:record.taskId,operationId:record.operationId });
}
export async function issueGrowthReadAccess(core: CoreContext, command: ProductCapabilityInvocation, prepared: { resources: Resource[]; expiresAt: number | null }, result: unknown): Promise<GrowthReadAccess> {
  const scope=accessScopeSchema.parse({version:"1",kind:"operation_scope",conversationId:command.conversationId,bindingId:command.bindingId,
    bindingDigest:command.bindingDigest,operation:command.operation,resources:prepared.resources,expiresAt:prepared.expiresAt});
  const scopeReference=scopePrefix+growthAgentDigest({tenantId:command.authority.tenantId,actor:command.actor,scope});
  const record=accessRecordSchema.parse({ version:"1",kind:"operation_read",taskId:command.taskId,conversationId:command.conversationId,
    operationId:command.operationId,bindingId:command.bindingId,bindingDigest:command.bindingDigest,operation:command.operation,
    inputDigest:growthAgentDigest(command.input),resultDigest:growthAgentDigest(result),scopeReference,resources:prepared.resources,expiresAt:prepared.expiresAt });
  const reference=scopedReference(command,record);
  await core.pool.query(`INSERT INTO "GrowthAgentSourceHandle"(id,"orgId","actorId","actorIssuer",context)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,[reference,command.authority.tenantId,command.actor.subject,command.actor.issuer,record]);
  const saved=(await core.pool.query('SELECT context FROM "GrowthAgentSourceHandle" WHERE id=$1 AND "orgId"=$2 AND "actorId"=$3 AND "actorIssuer"=$4',
    [reference,command.authority.tenantId,command.actor.subject,command.actor.issuer])).rows[0];
  if(!saved||growthAgentDigest(saved.context)!==growthAgentDigest(record))throw new ApiError(409,"agent_read_access_changed","The read result changed; start a new read");
  await core.pool.query(`INSERT INTO "GrowthAgentSourceHandle"(id,"orgId","actorId","actorIssuer",context)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,[scopeReference,command.authority.tenantId,command.actor.subject,command.actor.issuer,scope]);
  return {version:"1",reference,scopeReference,resultDigest:record.resultDigest};
}

/** A status scope identifies an exact saved review. It does not authorize its private body. */
async function effectReviewIdentity(core:CoreContext,context:RequestContext,command:ProductCapabilityInvocation,id:string,legacy:boolean) {
  const query=legacy
    ? `SELECT id,"taskId","conversationId","operationId","payloadDigest","actorId" FROM "GrowthAgentReview" WHERE id=$1 AND "orgId"=$2 AND "actorId"=$3 AND state='saved' AND "supersededBy" IS NULL`
    : `SELECT id,operation,"taskId","conversationId","operationId","payloadDigest","userId","principalId","principalKind" FROM "GrowthOperationReview" WHERE id=$1 AND "orgId"=$2 AND "userId"=$3 AND "principalId"=$4 AND "principalKind"=$5 AND state='succeeded'`;
  const values=legacy?[id,command.authority.tenantId,command.actor.subject]:[id,command.authority.tenantId,context.userId,context.principal.id,context.principal.kind];
  const row=(await core.pool.query(query,values)).rows[0];
  if(!row||row.taskId!==command.taskId||row.conversationId!==command.conversationId||!legacy&&row.operation!==command.operation)throw unavailable();
  return row;
}
export async function issueGrowthEffectAccess(core:CoreContext,context:RequestContext,command:ProductCapabilityInvocation,review:ProductReviewReference,result:unknown,legacy=false):Promise<GrowthReadAccess> {
  if(review.product!=="growth"||review.taskId!==command.taskId||review.operationId!==command.operationId||review.state!=="saved")throw unavailable();
  const identity=await effectReviewIdentity(core,context,command,review.id,legacy);
  if(identity.operationId!==review.operationId||identity.payloadDigest!==review.payloadDigest)throw unavailable();
  return issueGrowthReadAccess(core,command,{resources:[{kind:legacy?"legacy_review_effect":"review_effect",id:review.id,parent:growthAgentDigest(identity)}],expiresAt:null},result);
}

// Each query is product-owned and uses current tenant/resource membership, not the old result body.
const resourceQueries: Partial<Record<ResourceKind,string>> = {
  connection:'SELECT id FROM "ExternalConnection" WHERE id=$1 AND "orgId"=$2',
  social_account:'SELECT id FROM "SocialChannelConnection" WHERE id=$1 AND "orgId"=$2',
  post:'SELECT id FROM "SocialPost" WHERE id=$1 AND "orgId"=$2',
  post_variant:'SELECT v.id FROM "SocialPostVariant" v JOIN "SocialPost" p ON p.id=v."postId" WHERE v.id=$1 AND p."orgId"=$2 AND v."postId"=$3',
  post_media:'SELECT m.id FROM "SocialPostMedia" m JOIN "SocialPost" p ON p.id=m."postId" WHERE m.id=$1 AND p."orgId"=$2 AND m."postId"=$3',
  post_job:'SELECT j.id FROM "SocialPublishJob" j JOIN "SocialPost" p ON p.id=j."postId" WHERE j.id=$1 AND p."orgId"=$2 AND j."postId"=$3',
  post_job_account:'SELECT j.id FROM "SocialPublishJob" j JOIN "SocialPost" p ON p.id=j."postId" WHERE j.id=$1 AND p."orgId"=$2 AND j."channelConnectionId"=$3',
  media:'SELECT id FROM "ContentMediaAsset" WHERE id=$1 AND "orgId"=$2',
  media_preview:'SELECT id FROM "ContentMediaAsset" WHERE id=$1 AND "orgId"=$2 AND "processingStatus"=\'READY\' AND "scanStatus"=\'CLEAN\'',
  contact_membership:'SELECT id FROM "WhatsappContactListMembership" WHERE id=$1 AND "orgId"=$2 AND "contactId"=$3',
  contact:'SELECT id FROM "WhatsappContact" WHERE id=$1 AND "orgId"=$2',
  customer:'SELECT id FROM "Customer" WHERE id=$1 AND "orgId"=$2',
  customer_identity:'SELECT id FROM "CustomerIdentity" WHERE id=$1 AND "orgId"=$2 AND "customerId"=$3',
  customer_contact:'SELECT id FROM "WhatsappContact" WHERE id=$1 AND "orgId"=$2 AND "customerId"=$3',
  customer_conversation:'SELECT id FROM "Conversation" WHERE id=$1 AND "orgId"=$2 AND "customerId"=$3',
  customer_booking:'SELECT id FROM "Booking" WHERE id=$1 AND "orgId"=$2 AND "customerId"=$3',
  customer_campaign:'SELECT c.id FROM "WhatsappCampaign" c WHERE c.id=$1 AND c."orgId"=$2 AND EXISTS (SELECT 1 FROM "WhatsappCampaignRecipient" r JOIN "WhatsappContact" x ON x.id=r."contactId" AND x."orgId"=c."orgId" WHERE r."campaignId"=c.id AND x."customerId"=$3)',
  conversation:'SELECT id FROM "Conversation" WHERE id=$1 AND "orgId"=$2',
  conversation_social:'SELECT id FROM "Conversation" WHERE id=$1 AND "orgId"=$2 AND split_part("customerIdentifier",\':\',2)=$3 AND channel IN (\'facebook\',\'instagram\')',
  conversation_external:'SELECT id FROM "Conversation" WHERE id=$1 AND "orgId"=$2 AND "externalConnectionId"=$3',
  conversation_whatsapp:'SELECT id FROM "Conversation" WHERE id=$1 AND "orgId"=$2 AND "customerIdentifier" LIKE (\'wa:\'||$3||\':%\') AND channel=\'whatsapp\'',
  message:'SELECT m.id FROM "Message" m JOIN "Conversation" c ON c.id=m."conversationId" WHERE m.id=$1 AND c."orgId"=$2 AND m."conversationId"=$3 AND m."deletedAt" IS NULL',
  message_attachment:'SELECT a.id FROM "MessageAttachment" a JOIN "Message" m ON m.id=a."messageId" JOIN "Conversation" c ON c.id=m."conversationId" WHERE a.id=$1 AND c."orgId"=$2 AND a."messageId"=$3 AND m."deletedAt" IS NULL',
  message_reaction:'SELECT r.id FROM "MessageReaction" r JOIN "Message" m ON m.id=r."messageId" JOIN "Conversation" c ON c.id=m."conversationId" WHERE r.id=$1 AND c."orgId"=$2 AND r."messageId"=$3 AND r.active AND m."deletedAt" IS NULL',
  message_reference:'SELECT r."messageId" AS id FROM "MessageReference" r JOIN "Message" m ON m.id=r."messageId" JOIN "Conversation" c ON c.id=m."conversationId" WHERE r."messageId"=$1 AND c."orgId"=$2 AND r."referencedMessageId"=$3 AND m."deletedAt" IS NULL',
  message_reference_empty:'SELECT r."messageId" AS id FROM "MessageReference" r JOIN "Message" m ON m.id=r."messageId" JOIN "Conversation" c ON c.id=m."conversationId" WHERE r."messageId"=$1 AND c."orgId"=$2 AND r."referencedMessageId" IS NULL AND m."deletedAt" IS NULL',
  booking:'SELECT id FROM "Booking" WHERE id=$1 AND "orgId"=$2',
  booking_service:'SELECT id FROM "BookingService" WHERE id=$1 AND "orgId"=$2',
  booking_customer:'SELECT id FROM "Booking" WHERE id=$1 AND "orgId"=$2 AND "customerId"=$3',
  booking_service_link:'SELECT id FROM "Booking" WHERE id=$1 AND "orgId"=$2 AND "serviceId"=$3',
  campaign:'SELECT id FROM "WhatsappCampaign" WHERE id=$1 AND "orgId"=$2',
  campaign_connection:'SELECT id FROM "WhatsappCampaign" WHERE id=$1 AND "orgId"=$2 AND "connectionId"=$3',
  campaign_template:'SELECT id FROM "WhatsappCampaign" WHERE id=$1 AND "orgId"=$2 AND "templateId"=$3',
  template:'SELECT id FROM "WhatsappTemplate" WHERE id=$1 AND "orgId"=$2',
  template_connection:'SELECT id FROM "WhatsappTemplate" WHERE id=$1 AND "orgId"=$2 AND "connectionId"=$3',
  whatsapp_connection:'SELECT id FROM "WhatsappConnection" WHERE id=$1 AND "orgId"=$2',
  batch:'SELECT id FROM "SocialPublishBatch" WHERE id=$1 AND "orgId"=$2 AND "postId"=$3',
  batch_item:'SELECT i.id FROM "SocialPublishBatchItem" i JOIN "SocialPublishBatch" b ON b.id=i."batchId" WHERE i.id=$1 AND b."orgId"=$2 AND i."batchId"=$3',
  batch_job:'SELECT i.id FROM "SocialPublishBatchItem" i JOIN "SocialPublishBatch" b ON b.id=i."batchId" WHERE i.id=$1 AND b."orgId"=$2 AND i."jobId"=$3',
  batch_account:'SELECT i.id FROM "SocialPublishBatchItem" i JOIN "SocialPublishBatch" b ON b.id=i."batchId" WHERE i.id=$1 AND b."orgId"=$2 AND i."channelConnectionId"=$3',
};

export async function assertGrowthReadAccess(core:CoreContext,context:RequestContext,command:ProductCapabilityInvocation):Promise<{authorized:true;revision?:string;scopeReference?:string}> {
  const input=object(command.input),source=object(input.source), reference=identifier(source.id);
  if(!reference.startsWith(referencePrefix)&&!reference.startsWith(scopePrefix))throw unavailable();
  const row=(await core.pool.query('SELECT context FROM "GrowthAgentSourceHandle" WHERE id=$1 AND "orgId"=$2 AND "actorId"=$3 AND "actorIssuer"=$4',
    [reference,command.authority.tenantId,command.actor.subject,command.actor.issuer])).rows[0];
  let scope:AccessScope,revision:string|undefined;
  if(reference.startsWith(referencePrefix)){
    revision=identifier(source.revision);const operationId=identifier(source.operationId),parsed=accessRecordSchema.safeParse(row?.context);if(!parsed.success)throw unavailable();const record=parsed.data;
    if(scopedReference(command,record)!==reference||record.taskId!==command.taskId||record.operationId!==operationId||record.resultDigest!==revision)throw unavailable();
    scope=accessScopeSchema.parse({version:"1",kind:"operation_scope",conversationId:record.conversationId,bindingId:record.bindingId,bindingDigest:record.bindingDigest,
      operation:record.operation,resources:record.resources,expiresAt:record.expiresAt});
    if(record.scopeReference!==scopePrefix+growthAgentDigest({tenantId:command.authority.tenantId,actor:command.actor,scope}))throw unavailable();
  } else {const parsed=accessScopeSchema.safeParse(row?.context);if(!parsed.success)throw unavailable();scope=parsed.data;
    if(scopePrefix+growthAgentDigest({tenantId:command.authority.tenantId,actor:command.actor,scope})!==reference)throw unavailable();}
  if(scope.conversationId!==command.conversationId||scope.operation!==command.operation||scope.bindingId!==command.bindingId||scope.bindingDigest!==command.bindingDigest||
    scope.expiresAt!==null&&scope.expiresAt<=Date.now())throw unavailable();
  if(scope.operation==="draft.prepare")await authorizeGrowthAgentScope(core,{tenantId:command.authority.tenantId,actor:command.actor},"content");
  else await authorizeGrowthOperation(core,context,scope.operation,{discovery:true});
  const groups=new Map<ResourceKind,Resource[]>();
  for(const resource of scope.resources){
    if(resource.kind==="analytics_scope") {if(!resource.parent)throw unavailable();await assertReportingScope(core,command.actor.subject,command.authority.tenantId,{id:resource.id,root:resource.parent});continue;}
    if(resource.kind==="media_transfer") {
      const transfer=await getGrowthMediaTransfer(core,context,resource.id);
      if(!["PENDING","UPLOADING","READY"].includes(transfer.state))throw unavailable();
      continue;
    }
    if(resource.kind==="review_effect"||resource.kind==="legacy_review_effect") {
      const identity=await effectReviewIdentity(core,context,command,resource.id,resource.kind==="legacy_review_effect");
      if(growthAgentDigest(identity)!==resource.parent)throw unavailable();
      continue;
    }
    if(resource.kind==="review") {
      const review=(await core.pool.query(`SELECT id,operation,"taskId","conversationId","operationId","payloadDigest","userId","principalId","principalKind"
        FROM "GrowthOperationReview" WHERE id=$1 AND "orgId"=$2 AND "userId"=$3 AND "principalId"=$4 AND "principalKind"=$5`,
      [resource.id,command.authority.tenantId,context.userId,context.principal.id,context.principal.kind])).rows[0];
      if(!review||growthAgentDigest(review)!==resource.parent)throw unavailable();await authorizeGrowthOperation(core,context,review.operation,{discovery:true});continue;
    }
    if(!resourceQueries[resource.kind])throw unavailable();
    const group=groups.get(resource.kind)??[];group.push(resource);groups.set(resource.kind,group);
  }
  await Promise.all([...groups].map(async([kind,resources])=>{
    const sql=resourceQueries[kind]!.replace(/\$[123]/g,token=>({"$1":"requested.id","$2":"$3","$3":"requested.parent"})[token]!);
    const result=await core.pool.query(`SELECT count(*)::int AS count FROM unnest($1::text[],$2::text[]) requested(id,parent) WHERE EXISTS(${sql})`,
      [resources.map(resource=>resource.id),resources.map(resource=>resource.parent??null),command.authority.tenantId]);
    if(result.rows[0]?.count!==resources.length)throw unavailable();
  }));
  return {authorized:true,...(revision?{revision}:{scopeReference:reference})};
}
