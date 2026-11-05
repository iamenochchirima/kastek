import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "@kasitek-labs/server-support/json";
import { apiJson } from "../json.js";
import type { CoreContext } from "../context.js";
import type { RequestContext } from "../identity/request-context.js";
import { ApiError } from "../error.js";
import { enqueueGrowthAgentAccess } from "../analytics/agent-access.js";
import { transaction } from "../db.js";
import { getGrowthOperation, validateGrowthOperationInput } from "./catalog.js";
import { authorizeGrowthOperation } from "./policy.js";
import { invokeGrowthOperation } from "./dispatch.js";
import { preflightInternal } from "../capabilities/content-batch.js";
import { contentActionSnapshot, directContentOperations, isContentAction } from "./content-preview.js";
export { isContentAction as isContentPublicOperation, isDirectContentOperation } from "./content-preview.js";
import { beginRequest, finishRequest, publicRateLimit, type RequestAuditHandle } from "../services/public-api.js";
import { operationDomainKey, reconcileGrowthOperationReceipt } from "./reconciliation.js";
import { recordGrowthOperation } from "./telemetry.js";
import { getSocialPost } from "../services/social/posts.js";
import type { GrowthReadDetails } from "./read-access.js";
import { reviewedRecipientLabel } from "./review-recipient.js";

export interface OperationReviewRow {
  id: string; orgId: string; userId: string; principalId: string; principalKind: string;
  operation: string; version: string; requestKey: string; payloadDigest: string;
  input: Record<string, unknown>; snapshot: Record<string, string>; state: string; result: unknown;
  decisionSource?: "requested_draft" | "requested_action" | "growth_ui" | "mcp_form" | "mcp_app" | null;
  errorCode: string | null; createdAt: Date; updatedAt: Date; expiresAt: Date; taskId: string | null; conversationId: string | null; operationId: string | null;
}
export interface OperationInvocation {
  operation: string; input: Record<string, unknown>; requestId?: string; reviewId?: string;
  taskId?: string; conversationId?: string; operationId?: string;
  prepareOnly?: boolean;
  /** Retained transport field; content requests no longer require a separate Growth approval. */
  forceReviewed?: boolean;
  continuation?: string;
  requestAudit?: RequestAuditHandle;
  captureRead?: (result: Record<string, unknown>, details: GrowthReadDetails, native: Record<string, unknown>) => Promise<(bounded: Record<string, unknown>) => Promise<void>>;
  projectRead?: (result: Record<string, unknown>) => Record<string, unknown>;
}
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(JSON.parse(apiJson(value)))).digest("hex");
const conflict = (message: string) => new ApiError(409, "operation_review_conflict", message);
const safeJson = (value: unknown) => JSON.parse(canonicalJson(value));
export const growthOperationPayloadDigest = (operation:string,input:Record<string,unknown>):string => digest({operation,version:getGrowthOperation(operation).version,input});
export function operationReviewState(row: OperationReviewRow): string {
  return ["proposed", "approved"].includes(row.state) && +new Date(row.expiresAt) <= Date.now() ? "expired" : row.state;
}

export function operationReviewView(core: CoreContext, row: OperationReviewRow) {
  return { id: row.id, requestId: row.requestKey, operation: row.operation, version: row.version,
    state: operationReviewState(row), decisionSource: row.decisionSource ?? null,
    payloadDigest: row.payloadDigest, expiresAt: new Date(row.expiresAt).toISOString(),
    reviewUrl: `${core.config.frontendUrl}/operations/reviews/${encodeURIComponent(row.id)}`,
    ...(row.snapshot.preview ? { preview: JSON.parse(row.snapshot.preview) } : {}),
    input: { ...row.input, ...(typeof row.input.base64 === "string" ? { base64: `[${row.input.base64.length} base64 characters; digest ${digest(row.input.base64)}]` } : {}) },
    result: row.result, errorCode: row.errorCode };
}

/** Revisions and an immutable human preview bind approval; provider credentials are never selected. */
async function resourceSnapshot(core: CoreContext, ctx: RequestContext, input: Record<string, unknown>, operation: string): Promise<Record<string, string>> {
  if (isContentAction(operation)) return {...await contentActionSnapshot(core, ctx, input, operation), agentReviewRevisionSchema: "1"};
  const snapshot: Record<string, string> = { agentReviewRevisionSchema: "1" };
  const preview: Record<string, unknown> = {};
  if (typeof input.text === "string") preview.content = input.text;
  if (typeof input.transferId === "string") {
    const transfer = (await core.pool.query(`SELECT checksum,"byteSize",state FROM "GrowthMediaTransfer" WHERE id=$1 AND "orgId"=$2 AND "userId"=$3 AND "principalId"=$4 AND "principalKind"=$5`, [input.transferId, ctx.organizationId, ctx.userId, ctx.principal.id, ctx.principal.kind])).rows[0];
    if (!transfer || transfer.state !== "READY") throw new ApiError(409, "media_transfer_not_ready", "Upload the media before preparing its review");
    snapshot.transfer = digest(transfer);
  }
  let postId = typeof input.postId === "string" ? input.postId : undefined;
  const selectedAccounts = new Set<string>();
  if (!postId && typeof input.jobId === "string") postId = (await core.pool.query(`SELECT "postId" FROM "SocialPublishJob" WHERE id=$1 AND "orgId"=$2`, [input.jobId, ctx.organizationId])).rows[0]?.postId;
  if (!postId && typeof input.batchId === "string") postId = (await core.pool.query(`SELECT "postId" FROM "SocialPublishBatch" WHERE id=$1 AND "orgId"=$2`, [input.batchId, ctx.organizationId])).rows[0]?.postId;
  if (postId) {
    const post = (await core.pool.query(`SELECT "updatedAt" AT TIME ZONE 'UTC' AS revision,"agentReviewRevision"::text AS "agentReviewRevision" FROM "SocialPost" WHERE id=$1 AND "orgId"=$2`, [postId, ctx.organizationId])).rows[0];
    if (!post) throw new ApiError(404, "not_found", "Content post not found");
    snapshot.postRevision = post.revision instanceof Date ? post.revision.toISOString() : String(post.revision);
    snapshot.postAgentRevision = post.agentReviewRevision;
    const saved = await getSocialPost(core.pool, ctx.organizationId, postId);
    if (!saved) throw new ApiError(404, "not_found", "Content post not found");
    Object.assign(preview, { postId, title: saved.title, content: saved.content,
      scheduledFor: input.scheduledFor ?? saved.scheduled_for?.toISOString() ?? null,
      variants: saved.variants.map(variant => ({ platform: variant.platform, content: variant.content })),
      media: saved.media.map(media => ({ assetId: media.asset_id, fileName: media.file_name, mimeType: media.mime_type })) });
    if (operation === "content.posts.update_published") {
      if (new Date(String(input.expectedUpdatedAt)).getTime() !== new Date(String(snapshot.postRevision)).getTime()) throw conflict("The post changed. Reload it before preparing this edit.");
      preview.previousContent = saved.variants.find(variant => variant.platform === "FACEBOOK")?.content ?? saved.content;
      preview.content = input.content;
      preview.variants = [{ platform: "FACEBOOK", content: input.content }];
      preview.removePhoto = input.removePhoto === true;
      preview.targetLabel = input.removePhoto === true ? "Facebook · update existing post and remove photo" : "Facebook · update existing post";
      if (input.removePhoto === true) {
        preview.removedMedia = preview.media;
        preview.media = [];
      }
    }
    const options = saved.metadata && typeof saved.metadata === "object" && !Array.isArray(saved.metadata) ? saved.metadata as Record<string, unknown> : {};
    if (saved.channels.includes("TIKTOK") && (!input.platform || input.platform === "TIKTOK"))
      preview.targetLabel = `TikTok · ${typeof options.tiktokPrivacyLevel === "string" ? options.tiktokPrivacyLevel : "SELF_ONLY"} · ${typeof options.tiktokMediaType === "string" ? options.tiktokMediaType : "VIDEO"}`;
    for (const [platform, key] of [["INSTAGRAM", "instagramImageUrl"], ["TIKTOK", "tiktokMediaUrl"]] as const) {
      if (saved.channels.includes(platform) && (!input.platform || input.platform === platform) && typeof options[key] === "string")
        (preview.media as unknown[]).push({ assetId: `${platform}:source`, fileName: options[key], mimeType: "Remote media" });
    }
    const accounts = (await core.pool.query(`SELECT "channelConnectionId" AS id FROM "SocialPublishJob" WHERE "postId"=$1 AND "orgId"=$2 AND "channelConnectionId" IS NOT NULL UNION SELECT "primaryChannelId" AS id FROM "SocialPost" WHERE id=$1 AND "orgId"=$2 AND "primaryChannelId" IS NOT NULL`, [postId, ctx.organizationId])).rows;
    for (const account of accounts) selectedAccounts.add(account.id);
    if (["content.posts.publish", "content.posts.publish_batch"].includes(operation)) {
      const plan = await preflightInternal(core.pool, ctx, postId, {syncConnections:false});
      snapshot.snapshotHash = plan.snapshotHash;
    }
  }
  const draft = input.draft && typeof input.draft === "object" ? input.draft as Record<string, unknown> : {};
  for (const field of ["title", "content", "variants"]) if (draft[field] !== undefined) preview[field] = draft[field];
  const selected = draft.channelSelections && typeof draft.channelSelections === "object" ? Object.values(draft.channelSelections) : [];
  for (const id of selected) if (typeof id === "string") selectedAccounts.add(id);
  if (typeof draft.primaryChannelId === "string") selectedAccounts.add(draft.primaryChannelId);
  const accountPreviews: Record<string, unknown>[] = [];
  for (const id of selectedAccounts) {
    const account = (await core.pool.query(`SELECT id,status::text,"updatedAt","agentReviewRevision"::text AS "agentReviewRevision",platform::text,"displayName",handle,"externalAccountId" FROM "SocialChannelConnection" WHERE id=$1 AND "orgId"=$2`, [id, ctx.organizationId])).rows[0];
    if (!account) throw new ApiError(404, "not_found", "Publishing account not found");
    snapshot[`account:${id}`] = digest({ id: account.id, status: account.status, updatedAt: account.updatedAt, agentReviewRevision: account.agentReviewRevision });
    accountPreviews.push({ id: account.id, platform: account.platform, displayName: account.displayName, handle: account.handle, externalAccountId: account.externalAccountId });
  }
  if (accountPreviews.length) preview.accounts = accountPreviews.filter(account => typeof input.platform !== "string" || account.platform === input.platform).sort((a,b) => String(a.id).localeCompare(String(b.id)));
  if (Array.isArray(draft.media)) {
    const ids = draft.media.map(value => value && typeof value === "object" ? (value as {assetId?:unknown}).assetId : null).filter(value => typeof value === "string");
    const assets = (await core.pool.query(`SELECT id AS "assetId","fileName","mimeType" FROM "ContentMediaAsset" WHERE "orgId"=$1 AND id=ANY($2::text[])`, [ctx.organizationId, ids])).rows;
    preview.media = ids.map(id => assets.find(asset => asset.assetId === id) ?? { assetId: id });
  }
  if (typeof input.contactId === "string") {
    const contact = (await core.pool.query(`SELECT m."updatedAt" AS "membershipRevision", c."updatedAt" AS "contactRevision",m."agentReviewRevision"::text AS "membershipAgentRevision",c."agentReviewRevision"::text AS "contactAgentRevision" FROM "WhatsappContactListMembership" m JOIN "WhatsappContact" c ON c.id=m."contactId" AND c."orgId"=m."orgId" WHERE m.id=$1 AND m."orgId"=$2`, [input.contactId, ctx.organizationId])).rows[0];
    if (!contact) throw new ApiError(404, "not_found", "The reviewed contact is unavailable");
    snapshot.contactId = digest(contact);
  }
  for (const [field, table] of [["conversationId", "Conversation"], ["connectionId", "ExternalConnection"]] as const) {
    if (typeof input[field] !== "string") continue;
    const row = (await core.pool.query(`SELECT "updatedAt","agentReviewRevision"::text AS "agentReviewRevision" FROM "${table}" WHERE id=$1 AND "orgId"=$2`, [input[field], ctx.organizationId])).rows[0];
    if (!row) throw new ApiError(404, "not_found", "The reviewed record is unavailable");
    snapshot[field] = row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt);
    snapshot[`${field}AgentRevision`] = row.agentReviewRevision;
    const target = field === "conversationId"
      ? (await core.pool.query(`SELECT "customerName" AS name,"customerIdentifier" AS identifier,channel FROM "Conversation" WHERE id=$1 AND "orgId"=$2`, [input[field], ctx.organizationId])).rows[0]
      : (await core.pool.query(`SELECT "displayName" AS name,handle AS identifier,provider AS channel FROM "ExternalConnection" WHERE id=$1 AND "orgId"=$2`, [input[field], ctx.organizationId])).rows[0];
    if (operation === "inbox.messages.send" && field === "conversationId") {
      const targetLabel = reviewedRecipientLabel(target);
      if (!targetLabel) throw new ApiError(409, "operation_review_recipient_unavailable", "The message recipient is unavailable for review");
      preview.targetLabel = targetLabel;
    } else if (target) preview.targetLabel = [target.name,target.identifier,target.channel].filter(Boolean).join(" · ");
  }
  if (Object.keys(preview).length) snapshot.preview = apiJson(preview);
  return snapshot;
}

export async function getOperationReview(core: CoreContext, ctx: RequestContext, id: string, owner = false): Promise<OperationReviewRow> {
  const row = (await core.pool.query<OperationReviewRow>(`SELECT * FROM "GrowthOperationReview" WHERE id=$1 AND "orgId"=$2 AND "userId"=$3${owner ? "" : ' AND "principalId"=$4 AND "principalKind"=$5'}`, [id, ctx.organizationId, ctx.userId, ...(owner ? [] : [ctx.principal.id, ctx.principal.kind])])).rows[0];
  if (!row) throw new ApiError(404, "operation_review_missing", "Review not found");
  return row;
}

export async function decideOperationReview(core: CoreContext, ctx: RequestContext, id: string, decision: "approve" | "reject", payloadDigest: string) {
  if (ctx.principal.kind !== "direct_user") throw new ApiError(403, "forbidden", "Open Growth to review this action");
  const row = await getOperationReview(core, ctx, id, true);
  await authorizeGrowthOperation(core, { ...ctx, idempotencyKey: row.requestKey }, row.operation);
  if (row.payloadDigest !== payloadDigest) throw conflict("The reviewed action changed");
  if (+new Date(row.expiresAt) <= Date.now()) throw conflict("This review expired");
  if (decision === "approve" && ["proposed", "approved"].includes(row.state) && row.snapshot.agentReviewRevisionSchema !== "1")
    throw conflict("This review is out of date. Prepare a new review.");
  if (row.state !== "proposed") {
    if (row.state === (decision === "approve" ? "approved" : "rejected")) return row;
    throw conflict("This review was already decided");
  }
  return transaction(core.pool, async db => {
    const result = await db.query<OperationReviewRow>(`UPDATE "GrowthOperationReview" SET state=$2,"decisionSource"='growth_ui',"updatedAt"=now() WHERE id=$1 AND state='proposed' RETURNING *`, [id, decision === "approve" ? "approved" : "rejected"]);
    const saved = result.rows[0];
    if (!saved) throw conflict("This review was already decided");
    await enqueueGrowthAgentAccess(db, { orgId: saved.orgId, subjectId: saved.id, kind: "operation", action: decision === "approve" ? "approved" : "rejected", operation: saved.operation, time: saved.updatedAt });
    return saved;
  });
}

/** A preview creates only a scoped internal receipt, never a content or provider mutation. */
export async function prepareContentActionPreview(core: CoreContext, ctx: RequestContext, value: {action:string;input:Record<string,unknown>;requestId?:string}, binding: Pick<OperationInvocation,"taskId"|"conversationId"|"operationId"> = {}) {
  if (!isContentAction(value.action)) throw new ApiError(422,"operation_arguments_invalid","Choose a supported content action");
  const result = await runGrowthOperation(core,ctx,{operation:value.action,input:value.input,requestId:value.requestId ?? `content-preview:${randomUUID()}`,...binding,prepareOnly:true});
  if (!result.review || typeof result.review !== "object") throw conflict("This action did not produce a preview");
  const review = result.review as Record<string,unknown>;
  return {preview:{...review,previewId:review.id}};
}

/** An internal action gets its own proposed review; preview approval is never reassigned. */
export async function prepareInternalContentActionFromPreview(core:CoreContext,ctx:RequestContext,previewId:string,call:OperationInvocation) {
  const source=await getOperationReview(core,ctx,previewId);
  if (!isContentAction(call.operation) || !call.taskId || !call.conversationId || !call.operationId || source.taskId!==call.taskId || source.conversationId!==call.conversationId || !source.operationId)
    throw new ApiError(403,"operation_review_denied","The preview belongs to another task or conversation");
  if (source.operation!==call.operation || source.payloadDigest!==growthOperationPayloadDigest(call.operation,call.input)) throw conflict("The preview belongs to different content or an action");
  if (source.state!=="proposed" || +new Date(source.expiresAt)<=Date.now()) throw conflict("Prepare a fresh preview for this action");
  await authorizeGrowthOperation(core,{...ctx,idempotencyKey:call.operationId},call.operation);
  const current=await resourceSnapshot(core,ctx,call.input,call.operation);
  if (digest(current)!==digest(source.snapshot)) throw conflict("The content, account or record changed. Prepare a new preview.");
  const value=await executeGrowthOperation(core,ctx,{...call,reviewId:undefined,requestId:call.operationId,prepareOnly:true});
  const id=(value.review as {id?:string}|undefined)?.id;
  if (!id) throw conflict("This action did not produce a review");
  const prepared=await getOperationReview(core,ctx,id);
  if (prepared.taskId!==call.taskId || prepared.conversationId!==call.conversationId || prepared.operationId!==call.operationId || digest(prepared.snapshot)!==digest(source.snapshot)) throw conflict("The action review does not match the exact preview");
  return value;
}

/** Trusted transport boundary. A model-supplied approval field is never accepted here. */
async function decideContentOperationReview(core:CoreContext,ctx:RequestContext,id:string,payloadDigest:string,source:"mcp_form"|"mcp_app",decision:"approve"|"reject") {
  if (source !== "mcp_form" && source !== "mcp_app") throw new ApiError(403,"forbidden","Unsupported content confirmation source");
  const row = await getOperationReview(core,ctx,id);
  if (!isContentAction(row.operation)) throw new ApiError(403,"forbidden","This confirmation is only valid for content actions");
  await authorizeGrowthOperation(core,{...ctx,idempotencyKey:row.requestKey},row.operation);
  if (row.payloadDigest !== payloadDigest) throw conflict("The previewed action changed");
  if (decision === "approve" && row.decisionSource === source && ["approved","executing","succeeded","uncertain"].includes(row.state)) return row;
  if (decision === "reject" && row.state === "rejected" && row.decisionSource === source) return row;
  if (+new Date(row.expiresAt) <= Date.now()) throw conflict("This preview expired");
  if (row.state !== "proposed") throw conflict("This preview was already decided");
  const snapshot = await resourceSnapshot(core,ctx,row.input,row.operation);
  if (digest(snapshot) !== digest(row.snapshot)) throw conflict("The content, account or record changed. Prepare a new preview.");
  if (decision === "approve" && snapshot.preview && JSON.parse(snapshot.preview).validation?.ready === false)
    throw conflict("Resolve the preview validation issues before confirming");
  return transaction(core.pool,async db=>{
    const result = await db.query<OperationReviewRow>(`UPDATE "GrowthOperationReview" SET state=$2,"decisionSource"=$3,"updatedAt"=now() WHERE id=$1 AND state='proposed' RETURNING *`,[id,decision === "approve" ? "approved" : "rejected",source]);
    const saved=result.rows[0];
    if (!saved) throw conflict("This preview was already decided");
    await enqueueGrowthAgentAccess(db,{orgId:saved.orgId,subjectId:saved.id,kind:"operation",action:decision === "approve" ? "approved" : "rejected",operation:saved.operation,time:saved.updatedAt});
    return saved;
  });
}
export const confirmContentOperationReview = (core:CoreContext,ctx:RequestContext,id:string,payloadDigest:string,source:"mcp_form"|"mcp_app") => decideContentOperationReview(core,ctx,id,payloadDigest,source,"approve");
export const rejectContentOperationReview = (core:CoreContext,ctx:RequestContext,id:string,payloadDigest:string,source:"mcp_form"|"mcp_app") => decideContentOperationReview(core,ctx,id,payloadDigest,source,"reject");

/** Refresh may issue another UI nonce, but never extends the original review deadline. */
export async function refreshContentOperationPreview(core:CoreContext,ctx:RequestContext,id:string,payloadDigest:string) {
  const row=await getOperationReview(core,ctx,id);
  if (!isContentAction(row.operation) || row.payloadDigest!==payloadDigest || row.state!=="proposed" || +new Date(row.expiresAt)<=Date.now()) throw conflict("Only an unexpired unchanged proposed preview can be refreshed");
  await authorizeGrowthOperation(core,{...ctx,idempotencyKey:row.requestKey},row.operation);
  const current=await resourceSnapshot(core,ctx,row.input,row.operation);
  if (digest(current)!==digest(row.snapshot)) throw conflict("The content, account or record changed. Prepare a new preview.");
  return row;
}

/** Observes an existing admission only; it never invokes a new business action. */
export async function observeGrowthOperationReceipt(core:CoreContext,ctx:RequestContext,row:OperationReviewRow):Promise<OperationReviewRow> {
  if (!["executing","uncertain"].includes(row.state)) return row;
  const recovered=await reconcileGrowthOperationReceipt(core,row,ctx);
  if (!recovered) return row;
  return transaction(core.pool,async db=>{
    const result=await db.query<OperationReviewRow>(`UPDATE "GrowthOperationReview" SET state='succeeded',result=$2,"errorCode"=NULL,"updatedAt"=now() WHERE id=$1 AND state IN ('executing','uncertain') RETURNING *`,[row.id,canonicalJson(recovered)]);
    const saved=result.rows[0];
    if (saved) await enqueueGrowthAgentAccess(db,{orgId:row.orgId,subjectId:row.id,kind:"operation",action:"succeeded",operation:row.operation,time:saved.updatedAt});
    return saved ?? getOperationReview(core,ctx,row.id);
  });
}

/** Content uses durable requested actions; other effects retain their exact review policy. */
async function runGrowthOperation(core: CoreContext, ctx: RequestContext, call: OperationInvocation, readDetails: GrowthReadDetails = {}): Promise<Record<string, unknown>> {
  const definition = getGrowthOperation(call.operation);
  validateGrowthOperationInput(call.operation, call.input);
  const owned = call.reviewId ? await getOperationReview(core,ctx,call.reviewId) : undefined;
  const context = { ...ctx, idempotencyKey: call.requestId ?? owned?.requestKey ?? ctx.idempotencyKey };
  await authorizeGrowthOperation(core, context, definition);
  const directContentWrite = directContentOperations.has(definition.name);
  const requestedContentWrite = directContentWrite || isContentAction(definition.name);
  if (definition.review === "none" && !requestedContentWrite) {
    if (call.continuation && definition.effect !== "read") throw new ApiError(409, "operation_continuation_changed", "A continuation can only observe an existing result");
    return { state: "succeeded", result: await invokeGrowthOperation(core, context, call.operation, call.input, {...(call.captureRead ? {readDetails} : {}),previewBinding:{taskId:call.taskId,conversationId:call.conversationId,operationId:call.operationId}}) };
  }
  if (!call.prepareOnly && ["external_effect", "destructive"].includes(definition.effect) && (core.config.env.GROWTH_AGENT_EFFECTS_ENABLED === "false" || core.config.environment === "production" && core.config.env.GROWTH_AGENT_EFFECTS_ENABLED !== "true")) throw new ApiError(503, "agent_effects_disabled", "New external agent actions are disabled");
  const payloadDigest = digest({ operation: definition.name, version: definition.version, input: call.input });
  let row: OperationReviewRow;
  if (owned) row = owned;
  else row = await transaction(core.pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`growth-operation:${ctx.organizationId}:${ctx.principal.kind}:${ctx.principal.id}:${context.idempotencyKey}`]);
    const previous = (await db.query<OperationReviewRow>(`SELECT * FROM "GrowthOperationReview" WHERE "orgId"=$1 AND "principalId"=$2 AND "requestKey"=$3 AND "principalKind"=$4`, [ctx.organizationId, ctx.principal.id, context.idempotencyKey, ctx.principal.kind])).rows[0];
    if (previous) return previous;
    const snapshot = await resourceSnapshot(core, context, call.input, call.operation);
    const created = (await db.query<OperationReviewRow>(`INSERT INTO "GrowthOperationReview"(id,"orgId","userId","principalId","principalKind",operation,version,"requestKey","payloadDigest",input,snapshot,"expiresAt","taskId","conversationId","operationId","decisionSource") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+interval '30 minutes',$12,$13,$14,$15) RETURNING *`,
      [randomUUID(), ctx.organizationId, ctx.userId, ctx.principal.id, ctx.principal.kind, definition.name, definition.version, context.idempotencyKey, payloadDigest, canonicalJson(call.input), canonicalJson(snapshot), call.taskId ?? null, call.conversationId ?? null, call.operationId ?? null,directContentWrite ? "requested_draft" : null])).rows[0]!;
    if (!requestedContentWrite) await enqueueGrowthAgentAccess(db, { orgId: created.orgId, subjectId: created.id, kind: "operation", action: "proposed", operation: created.operation, time: created.createdAt });
    return created;
  });
  if (row.payloadDigest !== payloadDigest || row.operation !== call.operation || row.requestKey !== context.idempotencyKey) throw conflict("This request identity belongs to different content or an action");
  if (row.state === "succeeded") return { state: "succeeded", result: row.result, review: operationReviewView(core, row) };
  if (row.state === "executing" || row.state === "uncertain") {
    row = await observeGrowthOperationReceipt(core,context,row);
    if (row.state === "succeeded") return {state:"succeeded",result:row.result,review:operationReviewView(core,row)};
    return { state: "uncertain", review: operationReviewView(core, row), message: "The result needs reconciliation. Do not repeat this action with a new request identity." };
  }
  if (["rejected", "failed", "expired"].includes(row.state) || +new Date(row.expiresAt) <= Date.now()) return { state: row.state === "proposed" || row.state === "approved" ? "expired" : row.state, review: operationReviewView(core, row) };
  if (row.snapshot.agentReviewRevisionSchema !== "1") throw conflict("This review is out of date. Prepare a new review.");
  const requestedAction = requestedContentWrite && row.state === "proposed";
  if (row.state !== "approved" && !requestedAction) return { state: "approval_required", review: operationReviewView(core, row) };
  if (call.prepareOnly || call.continuation) return { state: requestedContentWrite ? "prepared" : "approval_required", review: operationReviewView(core, row) };
  if (+new Date(row.expiresAt) <= Date.now()) throw conflict("This review expired");
  const snapshot = await resourceSnapshot(core, context, call.input, call.operation);
  if (digest(snapshot) !== digest(row.snapshot)) throw conflict("The content, account or record changed. Prepare a new review.");
  if (isContentAction(call.operation) && snapshot.preview && JSON.parse(snapshot.preview).validation?.ready === false)
    throw conflict("Resolve the preview validation issues before executing");
  const requestSource=requestedAction?(directContentWrite?"requested_draft":"requested_action"):null;
  const claimed = await core.pool.query(`UPDATE "GrowthOperationReview" SET state='executing',"decisionSource"=COALESCE($3::text,"decisionSource"),"updatedAt"=now() WHERE id=$1 AND state=$2`, [row.id,requestedAction ? "proposed" : "approved",requestSource]);
  if (!claimed.rowCount) return { state: "uncertain", review: operationReviewView(core, { ...row, state: "executing" }) };
  if (requestSource) row = {...row,decisionSource:requestSource};
  try {
    const result = await invokeGrowthOperation(core, { ...context, operationReviewId: row.id, idempotencyKey: operationDomainKey(row.id) }, call.operation, call.input, {
      expectedPostRevision: snapshot.postRevision, expectedPostAgentRevision: snapshot.postAgentRevision, expectedSnapshotHash: snapshot.snapshotHash,
      expectedAccounts: Object.fromEntries(Object.entries(snapshot).filter(([key]) => key.startsWith("account:")).map(([key,value]) => [key.slice(8),value])),
      expectedResourceRevisions: snapshot,
    });
    const value = safeJson(result ?? {});
    await transaction(core.pool, async db => {
      const saved = (await db.query<OperationReviewRow>(`UPDATE "GrowthOperationReview" SET state='succeeded',result=$2,"updatedAt"=now() WHERE id=$1 AND state='executing' RETURNING *`, [row.id, canonicalJson(value)])).rows[0];
      if (saved) await enqueueGrowthAgentAccess(db, { orgId: saved.orgId, subjectId: saved.id, kind: "operation", action: "succeeded", operation: saved.operation, time: saved.updatedAt });
    });
    return { state: "succeeded", result: value, review: operationReviewView(core, { ...row, state: "succeeded", result: value }) };
  } catch (error) {
    const known = error instanceof ApiError && error.status < 500 && error.code !== "published_update_unconfirmed";
    await transaction(core.pool, async db => {
      const saved = (await db.query<OperationReviewRow>(`UPDATE "GrowthOperationReview" SET state=$2,"errorCode"=$3,"updatedAt"=now() WHERE id=$1 AND state='executing' RETURNING *`, [row.id, known ? "failed" : "uncertain", error instanceof ApiError ? error.code : "operation_result_unknown"])).rows[0];
      if (saved) await enqueueGrowthAgentAccess(db, { orgId: saved.orgId, subjectId: saved.id, kind: "operation", action: known ? "failed" : "uncertain", operation: saved.operation, time: saved.updatedAt });
    });
    throw error;
  }
}

/** Same bounded observation contract on all transports; continuation never widens resource authority. */
export function boundedGrowthOperationResult(value: Record<string, unknown>, continuation?: string): Record<string, unknown> {
  const encoded = canonicalJson(value);
  if (!continuation && Buffer.byteLength(encoded) <= 8192) return value;
  if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new ApiError(413, "operation_result_too_large", "Narrow the requested range or page size");
  const hash = digest(value), characters = Array.from(encoded);
  let offset = 0;
  if (continuation) {
    try {
      if (continuation.length > 512) throw new Error();
      const cursor = JSON.parse(Buffer.from(continuation, "base64url").toString());
      if (cursor.digest !== hash || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset >= characters.length) throw new Error();
      offset = cursor.offset;
    } catch { throw new ApiError(409, "operation_continuation_changed", "The result changed or continuation is invalid. Read the result again."); }
  }
  let length = Math.min(2000, characters.length - offset);
  for (;;) {
    const end = offset + length;
    const result = { state: value.state, result: { encoding: "json", chunk: characters.slice(offset, end).join(""), offset, totalCharacters: characters.length, digest: hash,
      continuation: end < characters.length ? Buffer.from(JSON.stringify({ offset: end, digest: hash })).toString("base64url") : null },
      ...(value.review && typeof value.review === "object" ? { review: Object.fromEntries(Object.entries(value.review).filter(([key]) => !["input", "result", "preview"].includes(key))) } : {}) };
    if (Buffer.byteLength(canonicalJson(result)) <= 8192) return result;
    length = Math.floor(length / 2);
    if (length < 1) throw new ApiError(413, "operation_result_too_large", "The operation metadata exceeds the result limit");
  }
}

export async function executeGrowthOperation(core: CoreContext, context: RequestContext, call: OperationInvocation): Promise<Record<string, unknown>> {
  const started = performance.now();
  const audit = call.requestAudit ?? await beginRequest(core.pool, publicRateLimit(core.config), context, "POST", `/operations/${call.operation}`);
  audit.action = call.operation;
  try {
    const details: GrowthReadDetails = {};
    const unbounded = await runGrowthOperation(core, context, call, details);
    const projected = call.projectRead ? call.projectRead(unbounded) : unbounded;
    const finishRead = call.captureRead ? await call.captureRead(projected, details, unbounded) : undefined;
    const result = boundedGrowthOperationResult(projected, call.continuation);
    await finishRead?.(result);
    if (!call.requestAudit) await finishRequest(core.pool, audit, 200);
    recordGrowthOperation(context, call.operation, String(result.state), started);
    return result;
  } catch (error) {
    if (!call.requestAudit) await finishRequest(core.pool, audit, error instanceof ApiError ? error.status : 500);
    recordGrowthOperation(context, call.operation, "failed", started, error instanceof ApiError ? error.code : "internal_error");
    throw error;
  }
}
