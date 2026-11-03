import type { CoreContext } from "../context.js";
import type { RequestContext } from "../identity/request-context.js";
import type { ReportQueryInput } from "@kasitek-labs/contracts";
import { ApiError } from "../error.js";
import { transaction } from "../db.js";
import { SerdeFloat } from "@kasitek-labs/server-support/json";
import { validateGrowthOperationInput, getGrowthOperation } from "./catalog.js";
import { authorizeGrowthOperation } from "./policy.js";
import type { GrowthOperationInput } from "./types.js";
import * as content from "../capabilities/content-adapter.js";
import * as batches from "../capabilities/content-batch.js";
import { updatePublishedFacebookPost } from "../capabilities/content-published-edit.js";
import * as webhooks from "../services/public-webhooks.js";
import * as posts from "../services/social/posts.js";
import * as library from "../services/social/media-library.js";
import * as contentTemplates from "../services/social/content-templates.js";
import * as media from "../services/social/media.js";
import * as socialChannels from "../services/social/channels.js";
import * as connections from "../services/connections.js";
import * as contacts from "../services/whatsapp/contacts.js";
import * as campaigns from "../services/whatsapp/campaigns.js";
import * as templates from "../services/whatsapp/templates.js";
import * as bookings from "../services/bookings.js";
import * as customers from "../services/customers.js";
import * as inbox from "../services/inbox/index.js";
import { createWhatsappInboxPorts } from "../services/whatsapp/inbox.js";
import { getOrg } from "../services/orgs.js";
import { reportForOrganization } from "../services/analytics-reporting.js";
import { parseOptionalDatetime } from "../services/social/common.js";
import { delegatedSocialAuthority } from "./delegation.js";
import { stampSocialPublicationAccounts, lockReviewedSocialAccounts } from "../services/social/account-admission.js";
import { prepareGrowthMediaTransfer, finalizeGrowthMediaTransfer, type PrepareGrowthMediaTransferInput } from "./media-transfers.js";

const text = (input: GrowthOperationInput, key: string) => input[key] as string;
const object = (input: GrowthOperationInput, key: string) => input[key] as Record<string, unknown>;
const missing = (label: string): never => { throw new ApiError(404, "not_found", `${label} not found`); };
const user = (context: RequestContext): string => context.userId ?? context.principal.subjectUserId ?? (() => { throw new ApiError(403, "operation_actor_denied", "A delegated workspace user is required"); })();
function page<T>(rows: T[], input: GrowthOperationInput, key: string): Record<string, unknown> {
  const limit = Number(input.limit ?? 50), cursor = Number(input.cursor ?? 0);
  return { [key]: rows.slice(cursor, cursor + limit), pagination: { limit, cursor, nextCursor: rows.length > cursor + limit ? cursor + limit : null } };
}
function insightFilters(input: GrowthOperationInput) {
  return { platform: typeof input.platform === "string" ? input.platform : null, metricKeys: input.metricKeys as string[] ?? null,
    publishedFrom: typeof input.publishedFrom === "string" ? parseOptionalDatetime(input.publishedFrom) : null,
    publishedTo: typeof input.publishedTo === "string" ? parseOptionalDatetime(input.publishedTo) : null };
}

/** Remove credential-shaped metadata even when an older provider record contains it. */
export function sanitizeGrowthOperationResult(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof SerdeFloat) return value.value;
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitizeGrowthOperationResult);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:(?:access[_-]?token|refresh[_-]?token)(?:[_-]?encrypted)?|token|secret[_-]?key|api[_-]?secret|client[_-]?secret|api[_-]?key|password|cookie|authorization|dpopPrivateKey|privateKey|signingKey)$/i.test(key))
    .map(([key, item]) => [key, sanitizeGrowthOperationResult(item)]));
}

/** A receipt replay bypasses dispatch, so successful draft events are emitted once per execution. */
async function draftEvent(core:CoreContext,context:RequestContext,post:unknown,created:boolean):Promise<void> {
  const value=post as Record<string,unknown>,row=(value.row??value) as Record<string,unknown>;
  try {
    await webhooks.enqueueDomainEvent(core.pool,context.organizationId,created?webhooks.CONTENT_POST_CREATED_EVENT:webhooks.CONTENT_POST_UPDATED_EVENT,{
      postId:row.id,status:row.status,title:row.title??null,updatedAt:row.updatedAt??row.updated_at,
    });
  } catch(error) {
    console.warn(JSON.stringify({event:"queue.item.failed",operation:created?"content.created.enqueue":"content.updated.enqueue",correlation_id:context.correlationId,error_type:error instanceof Error?error.name:"unknown"}));
  }
}

async function changeJob(core: CoreContext, context: RequestContext, jobId: string, action: "cancel" | "retry", options: GrowthOperationExecutionOptions) {
  const job = (await core.pool.query('SELECT "postId" FROM "SocialPublishJob" WHERE id=$1 AND "orgId"=$2', [jobId, context.organizationId])).rows[0];
  if (!job) throw new ApiError(404, "not_found", "Publishing job not found");
  const { changePublishJobState } = await import("../services/social/publishing.js");
  await changePublishJobState(core.pool, context.organizationId, jobId, action, { ...options,
    ...(action === "retry" ? { delegation: delegatedSocialAuthority(context, "content.jobs.retry"), actorUserId: user(context) } : {}) });
  return { jobId, status: action === "retry" ? "QUEUED" : "CANCELED", post: await posts.getSocialPost(core.pool, context.organizationId, job.postId) };
}

async function reschedule(core: CoreContext, context: RequestContext, postId: string, scheduledFor: string, options: GrowthOperationExecutionOptions) {
  const when = parseOptionalDatetime(scheduledFor);
  if (!when || when.getTime() <= Date.now()) throw new ApiError(400, "bad_request", "Scheduled time must be in the future");
  await transaction(core.pool, async tx => {
    const post = await posts.lockSocialPost(tx, context.organizationId, postId, options);
    await lockReviewedSocialAccounts(tx, context.organizationId, options.expectedAccounts);
    if (post.status !== "SCHEDULED") throw new ApiError(409, "operation_state_conflict", "Only a scheduled post can be rescheduled");
    const jobs = (await tx.query('SELECT status::text,"externalPostId",metadata FROM "SocialPublishJob" WHERE "postId"=$1 AND "orgId"=$2 FOR UPDATE', [postId, context.organizationId])).rows;
    if (!jobs.length || jobs.some(job => job.status !== "QUEUED" || job.externalPostId !== null || job.metadata?._kasitek_outcome === "UNKNOWN"))
      throw new ApiError(409, "operation_state_conflict", "Publication has already started or needs reconciliation");
    await tx.query('UPDATE "SocialPost" SET "scheduledFor"=$3,"updatedAt"=NOW() WHERE id=$1 AND "orgId"=$2', [postId, context.organizationId, when.toISOString()]);
    await tx.query('UPDATE "SocialPublishJob" SET "scheduledFor"=$3,"updatedAt"=NOW(),"userId"=$4,metadata=COALESCE(metadata,\'{}\'::jsonb)||jsonb_build_object(\'_kasitek_delegation\',$5::jsonb) WHERE "postId"=$1 AND "orgId"=$2 AND status=\'QUEUED\'::"SocialPublishJobStatus"', [postId, context.organizationId, when.toISOString(), user(context), JSON.stringify(delegatedSocialAuthority(context, "content.posts.reschedule"))]);
    await stampSocialPublicationAccounts(tx, context.organizationId, postId);
  });
  return { post: await posts.getSocialPost(core.pool, context.organizationId, postId), status: "SCHEDULED" };
}

export interface GrowthOperationExecutionOptions {
  previewBinding?: { taskId?: string; conversationId?: string; operationId?: string };
  /** Trusted value from a persisted review, never a model-supplied input field. */
  expectedSnapshotHash?: string;
  expectedPostRevision?: string;
  expectedAccounts?: Record<string, string>;
  expectedResourceRevisions?: Record<string, string>;
}

/**
 * Trusted handler boundary. Transports must first consume the required exact review.
 * No transport may register its own domain implementation or call this for an unreviewed write.
 */
export async function invokeGrowthOperation(core: CoreContext, context: RequestContext, name: string, input: GrowthOperationInput, options: GrowthOperationExecutionOptions = {}): Promise<unknown> {
  validateGrowthOperationInput(name, input);
  const definition = await authorizeGrowthOperation(core, context, getGrowthOperation(name));
  const output = await dispatch(core, context, definition.name, input, options);
  return sanitizeGrowthOperationResult(output);
}

async function dispatch(core: CoreContext, context: RequestContext, name: string, input: GrowthOperationInput, options: GrowthOperationExecutionOptions): Promise<unknown> {
  const pool = core.pool, org = context.organizationId;
  switch (name) {
    case "workspace.read": {
      const workspace = await getOrg(pool, org) ?? missing("Workspace");
      const profile = (await pool.query('SELECT website,industry,"primaryGoal","primaryGoals" FROM "OrganizationOnboardingProfile" WHERE "orgId"=$1', [org])).rows[0] ?? null;
      return { workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, logo: workspace.logo, reportingTimezone: workspace.reportingTimezone, updatedAt: workspace.updatedAt, profile } };
    }
    case "connections.list": return page(await connections.listConnections(pool, org), input, "connections");
    case "connections.status.update": return { connection: await connections.updateStatus(pool, org, text(input, "connectionId"), text(input, "status"), options.expectedResourceRevisions?.connectionId) };
    case "content.accounts.list": {
      const accounts = await socialChannels.listSocialChannels(pool, org);
      return page(accounts.map(account => ({ ...account, capabilities: socialChannels.platformCapabilities(account.platform) })), input, "accounts");
    }
    case "content.posts.list": {
      const limit = Number(input.limit ?? 50), cursor = Number(input.cursor ?? 0);
      const rows = (await posts.listSocialPosts(pool, org)).filter(post => (!input.status || post.status === input.status) && (!input.search || `${post.title ?? ""} ${post.content}`.toLowerCase().includes(String(input.search).toLowerCase())));
      return page(rows, { limit, cursor }, "posts");
    }
    case "content.posts.get": return { post: await posts.getSocialPost(pool, org, text(input, "postId")) ?? missing("Content post") };
    case "content.posts.activity": return await posts.getSocialPostActivity(pool, org, text(input, "postId")) ?? missing("Content post");
    case "content.posts.draft.create": {
      const post=await content.createDraft(pool,context,{...object(input,"draft"),status:"DRAFT"},options);
      await draftEvent(core,context,post,true);return {post};
    }
    case "content.posts.draft.update": {
      const post=await content.updateDraft(pool,context,text(input,"postId"),{...object(input,"draft"),status:"DRAFT"},options);
      await draftEvent(core,context,post,false);return {post};
    }
    case "content.posts.update_published": return { post: await updatePublishedFacebookPost(pool, core.config, context, text(input, "postId"), {
      content: text(input, "content"), expectedUpdatedAt: text(input, "expectedUpdatedAt"), removePhoto: input.removePhoto as boolean | undefined,
    }, options) };
    case "content.posts.duplicate": {
      const original = await posts.getSocialPost(pool, org, text(input, "postId")) ?? missing("Content post");
      const channelSelections = Object.fromEntries(original.publishJobs.filter(job => job.channel_connection_id).map(job => [job.platform, job.channel_connection_id!]));
      const post = await content.createDraft(pool, context, { title: original.title, content: original.content, channels: original.channels, status: "DRAFT", primaryChannelId: original.primary_channel_id,
        channelSelections, media: original.media.map(item => ({ assetId: item.asset_id, sortOrder: item.sort_order, altText: item.alt_text })),
        variants: original.variants.map(variant => ({ platform: variant.platform, content: variant.content, status: "DRAFT", aiGenerated: variant.ai_generated })), metadata: { duplicatedFrom: original.id } }, {...options, expectedPostRevision: options.expectedPostRevision ?? original.updated_at.toISOString(), duplicateSourceId: original.id});
      await draftEvent(core, context, post, true);
      return { post };
    }
    case "content.media.list": return library.listLibraryMedia(pool, org, input);
    case "content.media.usage": return library.getLibraryMediaUsage(pool, org, text(input, "assetId"), input);
    case "content.media.update": return { asset: await library.updateLibraryMedia(pool, org, text(input, "assetId"), { expectedRevision: Number(input.expectedRevision), ...(input.displayName !== undefined ? {displayName: input.displayName as string | null} : {}), ...(input.tags !== undefined ? {tags: input.tags as string[]} : {}), ...(input.defaultAltText !== undefined ? {defaultAltText: input.defaultAltText as string | null} : {}) }, {operationKey: context.idempotencyKey ?? undefined}) };
    case "content.media.archive":
    case "content.media.restore": return { asset: await library.setLibraryMediaArchived(pool, org, text(input, "assetId"), {expectedRevision: Number(input.expectedRevision), archived: name.endsWith(".archive")}, {operationKey: context.idempotencyKey ?? undefined}) };
    case "content.templates.list": {
      const result = await contentTemplates.listContentTemplates(pool, org, input);
      return {templates: result.items, pagination: {limit: Number(input.limit ?? 30), nextCursor: result.nextCursor}};
    }
    case "content.templates.get": return {template: await contentTemplates.getContentTemplate(pool, org, text(input, "templateId"))};
    case "content.templates.create": return {template: await contentTemplates.createContentTemplate(pool, context, input as {template?: contentTemplates.TemplateInput; sourcePostId?: string})};
    case "content.templates.update": return {template: await contentTemplates.updateContentTemplate(pool, context, text(input, "templateId"), {expectedRevision: Number(input.expectedRevision), template: input.template as contentTemplates.TemplateInput})};
    case "content.templates.archive":
    case "content.templates.restore": return {template: await contentTemplates.setContentTemplateArchived(pool, context, text(input, "templateId"), {expectedRevision: Number(input.expectedRevision), archived: name.endsWith(".archive")})};
    case "content.templates.render": {
      const rendered = await contentTemplates.renderContentTemplate(pool, org, text(input, "templateId"), input as unknown as contentTemplates.TemplateRenderInput);
      for (const asset of rendered.media) {
        try { await media.getContentMediaPreview(pool, core.config, org, asset.assetId); }
        catch (error) {
          if (!(error instanceof ApiError)) throw error;
          rendered.validation.ready = false;
          for (const platform of rendered.channels) rendered.validation.errors.push({platform,code:error.code,message:error.message});
        }
      }
      return {rendered};
    }
    case "content.templates.instantiate": {
      const post = await contentTemplates.withTemplateDraft(pool, context, text(input, "templateId"), input as unknown as contentTemplates.TemplateRenderInput, async ({draft, variantMedia}) => {
        for (const asset of draft.media ?? []) await media.getContentMediaPreview(pool, core.config, org, asset.assetId);
        return content.createDraft(pool, context, draft, {...options, reusableVariantMedia: variantMedia});
      });
      await draftEvent(core, context, post, true);
      return {post};
    }
    case "content.media.get": {
      const asset = await media.getContentMediaAsset(pool, org, text(input, "assetId"));
      return {asset: asset.kind === "AUDIO" ? asset : await library.getLibraryMedia(pool, org, text(input, "assetId"))};
    }
    case "content.media.preview": {
      const [asset, previewUrl] = await media.getContentMediaPreview(pool, core.config, org, text(input, "assetId"));
      return { asset, previewUrl };
    }
    case "content.media.upload": {
      if (input.transferId) return finalizeGrowthMediaTransfer(core, context, text(input, "transferId"));
      const bytes = Buffer.from(text(input, "base64"), "base64");
      if (bytes.length > 16 * 1024 || bytes.toString("base64") !== input.base64)
        throw new ApiError(422, "operation_arguments_invalid", "Media must be canonical base64 encoding at most 16 KiB");
      if (!/^(image|video)\//.test(text(input, "mimeType"))) throw new ApiError(422, "operation_arguments_invalid", "Choose an image or video");
      return { asset: await media.uploadContentMediaBytes(pool, core.config, user(context), org, { fileName: input.fileName as string | undefined, mimeType: text(input, "mimeType"), bytes, source: "growth-operation", sourceKey: context.idempotencyKey }) };
    }
    case "content.media.transfer.prepare": return prepareGrowthMediaTransfer(core, context, input as unknown as PrepareGrowthMediaTransferInput);
    case "operations.reviews.get": {
      const { getOperationReview, operationReviewView } = await import("./reviews.js");
      return { review: operationReviewView(core, await getOperationReview(core, context, text(input, "reviewId"))) };
    }
    case "content.actions.preview": {
      const { prepareContentActionPreview } = await import("./reviews.js");
      return prepareContentActionPreview(core, context, {action:text(input,"action"), input:object(input,"input"), requestId:input.requestId as string | undefined}, options.previewBinding);
    }
    case "content.posts.publish_batch.preflight": return batches.preflight(pool, context, text(input, "postId"));
    case "content.posts.publish": return batches.publishBatch(pool, context, text(input, "postId"), options.expectedSnapshotHash, { ...options, platform: text(input, "platform") });
    case "content.posts.publish_batch": return batches.publishBatch(pool, context, text(input, "postId"), options.expectedSnapshotHash, options);
    case "content.posts.publish_batch.status": return input.batchId ? batches.getBatch(pool, context, text(input, "batchId")) : { batch: await batches.getLatestBatchForPost(pool, context, text(input, "postId")) };
    case "content.posts.publish_batch.retry": return batches.retryFailedBatch(pool, context, text(input, "batchId"), options);
    case "content.posts.schedule": return content.schedule(pool, context, text(input, "postId"), text(input, "scheduledFor"), options);
    case "content.posts.reschedule": return reschedule(core, context, text(input, "postId"), text(input, "scheduledFor"), options);
    case "content.posts.unschedule": return content.unschedule(pool, context, text(input, "postId"), options);
    case "content.jobs.cancel": return changeJob(core, context, text(input, "jobId"), "cancel", options);
    case "content.jobs.retry": return changeJob(core, context, text(input, "jobId"), "retry", options);
    case "content.posts.delete": return content.deletePost(pool, context, text(input, "postId"), options);
    case "content.posts.delete_published": return content.deletePublishedPost(pool, core.config, context, text(input, "postId"), text(input, "platform"), content.liveContentExecutionPorts(core.config), options);
    case "content.posts.insights": return content.getInsights(pool, context, text(input, "postId"), insightFilters(input));
    case "content.insights.report": return content.listInsights(pool, context, insightFilters(input), Number(input.limit ?? 50));
    case "contacts.list": return contacts.listContacts(pool, org, { q: input.search as string | undefined, opt_in: input.optIn as string | undefined, excluded: input.excluded as string | undefined, tag: input.tag as string | undefined, location: input.location as string | undefined, list_label: input.listLabel as string | undefined, limit: Number(input.limit ?? 50), cursor: Number(input.cursor ?? 0) });
    case "customers.get": return { customer: await customers.getCustomerDetail(pool, org, text(input, "customerId")) ?? missing("Customer") };
    case "contacts.update": {
      const patch = object(input, "contact");
      return contacts.updateAgentContact(pool, org, text(input, "contactId"), { ...patch, full_name: patch.fullName as string | null | undefined }, context.idempotencyKey!, { expectedSnapshot: options.expectedResourceRevisions?.contactId });
    }
    case "inbox.conversations.list": {
      const result = await inbox.listInboxConversations(pool, org, inboxOptions(core));
      return page(result.conversations, input, "conversations");
    }
    case "inbox.messages.list": {
      const result = await inbox.listConversationMessages(pool, org, text(input, "conversationId"), inboxOptions(core));
      return { ...result, ...page(result.messages as unknown[], input, "messages") };
    }
    case "inbox.conversations.update": {
      const result = await pool.query('UPDATE "Conversation" SET starred=$3,"updatedAt"=NOW() WHERE id=$1 AND "orgId"=$2 AND ($4::timestamp IS NULL OR "updatedAt"=$4::timestamp) RETURNING id,starred', [text(input, "conversationId"), org, input.starred, options.expectedResourceRevisions?.conversationId ?? null]);
      if (!result.rows[0]) throw new ApiError(409, "operation_review_conflict", "The conversation changed. Prepare a new review.");
      return { conversation: result.rows[0] };
    }
    case "inbox.conversations.mark_read":
    case "inbox.messages.send": {
      // Consume the reviewed revision before admission. Conversation recipients are immutable identities.
      const revision = options.expectedResourceRevisions?.conversationId;
      if (revision) {
        const claimed = await pool.query('UPDATE "Conversation" SET "updatedAt"=NOW() WHERE id=$1 AND "orgId"=$2 AND "updatedAt"=$3::timestamp RETURNING id', [text(input, "conversationId"), org, revision]);
        if (!claimed.rowCount) throw new ApiError(409, "operation_review_conflict", "The conversation changed. Prepare a new review.");
      }
      return name === "inbox.conversations.mark_read" ? inbox.markConversationRead(pool, user(context), org, text(input, "conversationId"), inboxOptions(core))
        : inbox.sendConversationMessage(pool, user(context), org, text(input, "conversationId"), { text: text(input, "text"), replyToMessageId: input.replyToMessageId as string | undefined }, inboxOptions(core));
    }
    case "bookings.services.list": return page(await bookings.listServices(pool, org), input, "services");
    case "bookings.list": return page(await bookings.listBookings(pool, org), input, "bookings");
    case "bookings.get": return { booking: await bookings.getBooking(pool, org, text(input, "bookingId")) ?? missing("Booking") };
    case "campaigns.list": {
      const result = await campaigns.listCampaigns(pool, org);
      const rows = (result.campaigns as Record<string, unknown>[]).filter(row => (!input.status || row.status === input.status) && (!input.search || String(row.name ?? "").toLowerCase().includes(String(input.search).toLowerCase())));
      return page(rows, input, "campaigns");
    }
    case "campaigns.get": return campaigns.getCampaignSummary(pool, org, text(input, "campaignId"));
    case "templates.list": {
      const result = await templates.listTemplates(pool, org, input.status as string | undefined);
      return page(result.templates as unknown[], input, "templates");
    }
    case "analytics.read": {
      const from = new Date(text(input, "from")), to = new Date(text(input, "to"));
      if (from >= to || to.getTime() - from.getTime() > 366 * 86400000) throw new ApiError(422, "operation_arguments_invalid", "Choose an increasing report range of at most 366 days");
      try { new Intl.DateTimeFormat("en", { timeZone: text(input, "timezone") }); } catch { throw new ApiError(422, "operation_arguments_invalid", "Choose a valid reporting timezone"); }
      const query = { range_start: input.from, range_end: input.to, timezone: input.timezone, metrics: input.metrics ?? [], breakdowns: input.breakdowns ?? [], filters: input.filters ?? {}, include_descendants: false } as ReportQueryInput;
      return { report: await reportForOrganization(core, user(context), org, query) };
    }
    default: throw new ApiError(404, "operation_not_found", "Growth operation not found");
  }
}
function inboxOptions(core: CoreContext): inbox.InboxOptions { return { config: core.config, whatsapp: createWhatsappInboxPorts(core) }; }
