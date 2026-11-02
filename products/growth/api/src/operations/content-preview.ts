import { createHash } from "node:crypto";
import { canonicalJson } from "@kasitek-labs/server-support/json";
import type { CoreContext } from "../context.js";
import type { RequestContext } from "../identity/request-context.js";
import { ApiError } from "../error.js";
import { SQL } from "../capabilities/content-batch-sql.js";
import { preflightInternal, type TargetPlan } from "../capabilities/content-batch.js";
import { authorizationRequirement, permissionSnapshots } from "../integrations/connection-permissions.js";
import { getSocialPost } from "../services/social/posts.js";
import { THREADS_PUBLISHED_EDIT_UNSUPPORTED } from "../capabilities/content-published-edit.js";
import { apiJson } from "../json.js";

export const contentActionNames = [
  "content.posts.publish", "content.posts.publish_batch", "content.posts.publish_batch.retry",
  "content.posts.schedule", "content.posts.reschedule", "content.posts.unschedule",
  "content.jobs.cancel", "content.jobs.retry", "content.posts.delete",
  "content.posts.delete_published", "content.posts.update_published",
] as const;
export const isContentAction = (name: string): boolean => (contentActionNames as readonly string[]).includes(name);
export const directContentOperations = new Set([
  "content.posts.draft.create", "content.posts.draft.update", "content.posts.duplicate", "content.media.upload", "content.media.transfer.prepare",
]);
export const isDirectContentOperation = (name:string):boolean => directContentOperations.has(name);
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(JSON.parse(apiJson(value)))).digest("hex");
const plain = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function contentPreviewMediaAssetsDigest(core:CoreContext,ctx:RequestContext,assetIds:string[]):Promise<string> {
  const assets=assetIds.length?(await core.pool.query(`SELECT id,checksum,"updatedAt","byteSize","processingStatus"::text,"scanStatus"::text FROM "ContentMediaAsset" WHERE "orgId"=$1 AND id=ANY($2::text[]) ORDER BY id`,[ctx.organizationId,assetIds])).rows:[];
  return hash(assets);
}

/** Reads saved content and readiness only. Previewing never synchronizes provider connections. */
export async function contentActionSnapshot(core: CoreContext, ctx: RequestContext, input: Record<string, unknown>, action: string): Promise<Record<string, string>> {
  let postId = typeof input.postId === "string" ? input.postId : undefined;
  const snapshot: Record<string, string> = {};
  if (typeof input.jobId === "string") {
    const job = (await core.pool.query(`SELECT id,"postId",platform::text,status::text,"updatedAt","externalPostId","channelConnectionId",metadata FROM "SocialPublishJob" WHERE id=$1 AND "orgId"=$2`, [input.jobId, ctx.organizationId])).rows[0];
    if (!job) throw new ApiError(404, "not_found", "Publishing job not found");
    postId = job.postId; snapshot.job = hash(job);
  }
  let retryJobIds: Set<string> | undefined;
  if (typeof input.batchId === "string") {
    const batch = (await core.pool.query(`SELECT id,"postId",status,"snapshotHash","updatedAt" FROM "SocialPublishBatch" WHERE id=$1 AND "orgId"=$2`, [input.batchId, ctx.organizationId])).rows[0];
    if (!batch) throw new ApiError(404, "not_found", "Publication batch not found");
    postId = batch.postId;
    const items = (await core.pool.query(`SELECT item.id,item."jobId",item.status,item.retryable,item."updatedAt",job.status::text AS "jobStatus",job.metadata->>'_kasitek_outcome' AS outcome FROM "SocialPublishBatchItem" item JOIN "SocialPublishJob" job ON job.id=item."jobId" WHERE item."batchId"=$1 AND job."orgId"=$2 ORDER BY item.id`, [input.batchId, ctx.organizationId])).rows;
    snapshot.batch = hash({batch, items});
    retryJobIds = new Set(items.filter(row => row.status === "FAILED" && row.retryable && row.jobStatus === "FAILED" && row.outcome !== "UNKNOWN").map(row => row.jobId));
  }
  if (!postId) throw new ApiError(404, "not_found", "Content post not found");
  const saved = await getSocialPost(core.pool, ctx.organizationId, postId);
  if (!saved) throw new ApiError(404, "not_found", "Content post not found");
  const revision = (await core.pool.query(`SELECT "updatedAt" AT TIME ZONE 'UTC' AS revision FROM "SocialPost" WHERE id=$1 AND "orgId"=$2`, [postId, ctx.organizationId])).rows[0]?.revision;
  snapshot.postRevision = revision instanceof Date ? revision.toISOString() : String(revision);
  const threadsEdit = action === "content.posts.update_published" && saved.channels.length === 1 && saved.channels[0] === "THREADS";
  const targetPlatform = action === "content.posts.update_published" ? threadsEdit ? "THREADS" : "FACEBOOK" : typeof input.platform === "string" ? input.platform : undefined;
  const jobs = saved.publishJobs.filter(job => (!targetPlatform || job.platform === targetPlatform) && (!input.jobId || job.id === input.jobId) && (!retryJobIds || retryJobIds.has(job.id))).sort((a,b) => a.id.localeCompare(b.id));
  const media = saved.media.map(item => ({assetId:item.asset_id, fileName:item.file_name, mimeType:item.mime_type, kind:item.kind, altText:item.alt_text, sortOrder:item.sort_order, byteSize:String(item.byte_size), width:item.width, height:item.height, durationMs:item.duration_ms, processingStatus:item.processing_status, scanStatus:item.scan_status})).sort((a,b) => a.sortOrder-b.sortOrder || a.assetId.localeCompare(b.assetId));
  snapshot.mediaAssets = await contentPreviewMediaAssetsDigest(core,ctx,saved.media.map(item=>item.asset_id));
  const variants = saved.variants.filter(variant => !targetPlatform || variant.platform === targetPlatform).map(variant => ({platform:variant.platform, content:variant.content, status:variant.status})).sort((a,b) => a.platform.localeCompare(b.platform));
  snapshot.content = hash({content:saved.content, title:saved.title, status:saved.status, channels:saved.channels, scheduledFor:saved.scheduled_for, variants:saved.variants, media, metadata: Object.fromEntries(["instagramImageUrl","tiktokMediaUrl","tiktokMediaType","tiktokPrivacyLevel","tiktokConsent"].map(key => [key, plain(saved.metadata)[key] ?? null]))});
  snapshot.jobs = hash(jobs.map(job => ({id:job.id,platform:job.platform,status:job.status,updatedAt:job.updated_at,externalPostId:job.external_post_id,accountId:job.channel_connection_id,scheduledFor:job.scheduled_for,metadata:job.metadata})));
  const errors: {code:string; message:string}[] = [];
  let planTargets: TargetPlan[] = [];
  if (["content.posts.publish", "content.posts.publish_batch", "content.posts.publish_batch.retry", "content.posts.schedule", "content.posts.reschedule", "content.jobs.retry"].includes(action)) {
    try {
      const plan = await preflightInternal(core.pool, ctx, postId, {syncConnections:false});
      planTargets = plan.targets.filter(target => jobs.some(job => job.id === target.jobId));
      if (["content.posts.publish", "content.posts.publish_batch"].includes(action)) snapshot.snapshotHash = plan.snapshotHash;
      if (["content.posts.schedule","content.posts.reschedule"].includes(action) && saved.status === "SCHEDULED") {
        planTargets = planTargets.map(target => target.state === "IN_PROGRESS" && jobs.some(job => job.id === target.jobId && job.status === "QUEUED" && !job.external_post_id && plain(job.metadata)._kasitek_outcome !== "UNKNOWN") ? {...target,state:"READY",status:"READY",reasonCode:undefined,message:undefined,remediationMode:"NONE"} : target);
      }
      snapshot.readiness = hash(planTargets);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      errors.push({code:error.code,message:error.message});
      snapshot.readiness = hash(errors);
    }
  }
  if (!jobs.length && action !== "content.posts.delete") errors.push({code:"no_action_targets",message:"No eligible destinations exist for this action"});
  const accountIds = [...new Set(jobs.map(job => job.channel_connection_id).filter((id): id is string => id !== null))];
  const accessRows = accountIds.length ? (await core.pool.query(SQL.load_channel_access[0],[ctx.organizationId,accountIds])).rows.sort((a,b)=>String(a.id).localeCompare(String(b.id))) : [];
  snapshot.accountAccess = hash(accessRows);
  const accounts: Record<string, unknown>[] = [];
  for (const id of accountIds) {
    const account = (await core.pool.query(`SELECT id,status::text,"updatedAt",platform::text,"displayName",handle,"externalAccountId",metadata FROM "SocialChannelConnection" WHERE id=$1 AND "orgId"=$2`, [id,ctx.organizationId])).rows[0];
    if (!account) throw new ApiError(404,"not_found","Publishing account not found");
    snapshot[`account:${id}`] = hash({id:account.id,status:account.status,updatedAt:account.updatedAt});
    snapshot[`permission:${id}`] = hash(permissionSnapshots(account.platform,account.metadata));
    const capability = action === "content.posts.delete_published" ? "SOCIAL_POST_DELETE" : saved.media.length ? "MEDIA_PUBLISH" : "SOCIAL_PUBLISH";
    const permission = authorizationRequirement(account.platform,account.metadata,capability);
    accounts.push({id:account.id,platform:account.platform,displayName:account.displayName,handle:account.handle,externalAccountId:account.externalAccountId,status:account.status,requiredCapability:capability,permission:permission ? permission.reasonCode : "GRANTED"});
    if (!["content.posts.delete","content.jobs.cancel","content.posts.unschedule"].includes(action)) {
      const access = accessRows.find(row=>row.id===id);
      if (account.status !== "CONNECTED" || permission || (access && (access.external_status === "NEEDS_ATTENTION" || access.health_status === "NEEDS_ATTENTION")))
        errors.push({code:"missing_provider_permission",message:`Check the account and grant ${capability} access before this action`});
    }
  }
  const timezone = (await core.pool.query(`SELECT "reportingTimezone" FROM "Organization" WHERE id=$1`,[ctx.organizationId])).rows[0]?.reportingTimezone ?? "UTC";
  const preview: Record<string,unknown> = {action,postId,title:saved.title,content:targetPlatform ? variants.find(variant=>variant.platform===targetPlatform)?.content ?? saved.content : saved.content,variants,media,accounts,scheduledFor:input.scheduledFor ?? saved.scheduled_for?.toISOString() ?? null,timezone,
    targets:jobs.map(job => ({jobId:job.id,platform:job.platform,accountId:job.channel_connection_id,externalPostId:job.external_post_id,status:job.status,content:saved.variants.find(variant=>variant.id===job.variant_id)?.content ?? saved.content,...(planTargets.find(target=>target.jobId===job.id) ?? {})})),
    validation:{ready:false,errors},
  };
  if (typeof input.scheduledFor === "string") {
    preview.requestedScheduledFor = input.scheduledFor;
    if (new Date(input.scheduledFor).getTime() <= Date.now()) errors.push({code:"schedule_in_past",message:"Choose a future publication time"});
  }
  const publishingOptions=plain(saved.metadata);
  if (jobs.some(job=>job.platform==="TIKTOK")) preview.tiktok={privacyLevel:publishingOptions.tiktokPrivacyLevel ?? "SELF_ONLY",mediaType:publishingOptions.tiktokMediaType ?? "VIDEO",consent:publishingOptions.tiktokConsent ?? null};
  const remoteMedia:Record<string,unknown>[]=[];
  for(const [platform,key] of [["INSTAGRAM","instagramImageUrl"],["TIKTOK","tiktokMediaUrl"]] as const){
    const value=publishingOptions[key];
    if(!jobs.some(job=>job.platform===platform)||typeof value!=="string") continue;
    try{const url=new URL(value);const sensitive=!!url.username||!!url.password||[...url.searchParams.keys()].some(key=>/access.?token|refresh.?token|client.?secret|password|authorization/i.test(key));remoteMedia.push({platform,source:"provider_media_url",...(sensitive?{urlOmitted:"Sensitive media URL"}:{url:value})});}
    catch{remoteMedia.push({platform,source:"provider_media_url",invalidUrl:true});}
  }
  if(remoteMedia.length) preview.remoteMedia=remoteMedia;
  if (action === "content.posts.update_published") {
    if (new Date(String(input.expectedUpdatedAt)).getTime() !== new Date(snapshot.postRevision).getTime()) throw new ApiError(409,"operation_review_conflict","The post changed. Reload it before preparing this edit.");
    preview.previousContent = saved.variants.find(variant=>variant.platform===targetPlatform)?.content ?? saved.content;
    preview.content = input.content; preview.variants = [{platform:targetPlatform,content:input.content}];
    preview.targets = (preview.targets as Record<string,unknown>[]).map(target=>({...target,content:input.content}));
    preview.removePhoto = input.removePhoto === true;
    preview.targetLabel = threadsEdit ? "Threads · published post" : input.removePhoto === true ? "Facebook · update existing post and remove photo" : "Facebook · update existing post";
    if (!threadsEdit && input.removePhoto === true) {preview.removedMedia=media;preview.media=[];}
    if (threadsEdit) errors.push({code:"platform_edit_unsupported",message:THREADS_PUBLISHED_EDIT_UNSUPPORTED});
    else if (saved.status !== "PUBLISHED" || saved.channels.length !== 1 || saved.channels[0] !== "FACEBOOK" || saved.publishJobs.length !== 1 || jobs.some(job=>job.status!=="PUBLISHED" || !job.external_post_id)) errors.push({code:"unsupported_published_edit",message:"Only a confirmed Facebook-only publication can be updated"});
    if (!threadsEdit && input.removePhoto === true && (saved.media.length!==1 || saved.media[0]?.kind!=="IMAGE")) errors.push({code:"photo_removal_unavailable",message:"Photo removal requires one published image"});
  }
  const unknown = (job:typeof jobs[number]) => plain(job.metadata)._kasitek_outcome === "UNKNOWN";
  if (action === "content.posts.schedule" && (!["DRAFT","SCHEDULED"].includes(saved.status) || jobs.some(job=>!["PENDING","QUEUED","CANCELED"].includes(job.status) || job.external_post_id || unknown(job)))) errors.push({code:"schedule_unavailable",message:"Only unclaimed draft content can be scheduled"});
  if (action === "content.posts.reschedule" && (saved.status!=="SCHEDULED" || jobs.some(job=>job.status!=="QUEUED" || job.external_post_id || unknown(job)))) errors.push({code:"reschedule_unavailable",message:"Only unclaimed scheduled content can be rescheduled"});
  if (action === "content.posts.unschedule" && (saved.status!=="SCHEDULED" || jobs.some(job=>["PUBLISHED","PROCESSING"].includes(job.status) || unknown(job)))) errors.push({code:"unschedule_unavailable",message:"Publishing has started or the content is not scheduled"});
  if (action === "content.jobs.cancel" && jobs.some(job=>!["PENDING","QUEUED"].includes(job.status) || unknown(job))) errors.push({code:"cancel_unavailable",message:"Only unclaimed pending or queued jobs can be canceled"});
  if (action === "content.jobs.retry" && jobs.some(job=>job.status!=="FAILED" || job.external_post_id || unknown(job))) errors.push({code:"retry_unavailable",message:"Only a confirmed failed job can be retried"});
  if (action === "content.posts.delete_published" && jobs.some(job=>job.status!=="PUBLISHED" || !job.external_post_id)) errors.push({code:"publication_not_confirmed",message:"Only confirmed published destinations can be deleted"});
  if (action === "content.posts.delete" && saved.publishJobs.some(job=>["PUBLISHED","PROCESSING","QUEUED"].includes(job.status))) errors.push({code:"draft_delete_unavailable",message:"Published or active content cannot be deleted as a draft"});
  if (planTargets.some(target=>!["READY","ALREADY_PUBLISHED"].includes(target.state))) errors.push({code:"destination_not_ready",message:"One or more selected destinations require attention"});
  (preview.validation as {ready:boolean}).ready=errors.length===0;
  snapshot.preview=apiJson(preview);
  return snapshot;
}
