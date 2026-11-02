import {createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import type {CoreContext} from "../context.js";
import type {RequestContext} from "../identity/request-context.js";
import {ApiError} from "../error.js";
import {apiJson} from "../json.js";
import {authorizeGrowthOperation} from "./policy.js";
import {auditGrowthAccess} from "./telemetry.js";
import {growthToolArguments} from "./transport.js";
import {operationDomainKey} from "./reconciliation.js";
import {getBatch} from "../capabilities/content-batch.js";
import {invokeGrowthOperation} from "./dispatch.js";
import {contentPreviewMediaAssetsDigest} from "./content-preview.js";
import {contentMcpAppHtml} from "./content-mcp-app-ui.generated.js";
import {confirmContentOperationReview,rejectContentOperationReview,executeGrowthOperation,getOperationReview,
  growthOperationPayloadDigest,isContentPublicOperation,operationReviewState,observeGrowthOperationReceipt,refreshContentOperationPreview,type OperationReviewRow} from "./reviews.js";

export const CONTENT_APP_URI="ui://growth/content-review-v1.html";
export const CONTENT_APP_MIME="text/html;profile=mcp-app";
export const CONTENT_APP_TOOL_NAME="content.actions.confirm";
const META_KEY="kasitek.co.za/contentReview";
const DOMAIN="growth-content-mcp-app-v1\0";
const publicationActions=new Set(["content.posts.publish","content.posts.publish_batch","content.posts.publish_batch.retry"]);
type Json=Record<string,unknown>;
const object=(value:unknown):value is Json=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const invalid=()=>new ApiError(403,"content_confirmation_invalid","This content confirmation is invalid or expired");
function secret(core:CoreContext):string {
  const value=core.config.rawEnv.GROWTH_MCP_CONFIRMATION_SECRET;
  if(!value||core.config.environment==="production"&&Buffer.byteLength(value)<32)throw new ApiError(503,"content_confirmation_unavailable","Content confirmation is not configured");
  return value;
}
interface Nonce {version:1;previewId:string;payloadDigest:string;operation:string;requestKey:string;principalKind:string;principalId:string;userId:string|null;organizationId:string;clientId:string|null;expires:number;nonce:string}
function seal(core:CoreContext,ctx:RequestContext,row:OperationReviewRow) {
  const expires=Math.min(+new Date(row.expiresAt),Date.now()+5*60_000);
  const data:Nonce={version:1,previewId:row.id,payloadDigest:row.payloadDigest,operation:row.operation,requestKey:row.requestKey,
    principalKind:ctx.principal.kind,principalId:ctx.principal.id,userId:ctx.userId,organizationId:ctx.organizationId,clientId:ctx.clientId,expires,nonce:randomUUID()};
  const encoded=Buffer.from(JSON.stringify(data)).toString("base64url");
  return {token:encoded+"."+createHmac("sha256",secret(core)).update(DOMAIN+encoded).digest("base64url"),expiresAt:new Date(expires).toISOString()};
}
function unseal(core:CoreContext,ctx:RequestContext,token:unknown):Nonce {
  if(typeof token!=="string"||token.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))throw invalid();
  const [encoded,mac]=token.split(".") as [string,string];
  const expected=createHmac("sha256",secret(core)).update(DOMAIN+encoded).digest("base64url");
  if(!timingSafeEqual(Buffer.from(mac),Buffer.from(expected)))throw invalid();
  let value:unknown;try{value=JSON.parse(Buffer.from(encoded,"base64url").toString("utf8"));}catch{throw invalid();}
  if(!object(value)||value.version!==1||typeof value.previewId!=="string"||typeof value.payloadDigest!=="string"||typeof value.requestKey!=="string"||typeof value.operation!=="string"||typeof value.nonce!=="string"||typeof value.expires!=="number"||!Number.isFinite(value.expires)||value.principalKind!==ctx.principal.kind||value.principalId!==ctx.principal.id||value.userId!==ctx.userId||value.organizationId!==ctx.organizationId||value.clientId!==ctx.clientId)throw invalid();
  return value as unknown as Nonce;
}
export function contentMcpAppTool() {
  return {name:CONTENT_APP_TOOL_NAME,description:"Confirm or inspect the exact content action shown in the content review app.",
    inputSchema:{type:"object",properties:{previewId:{type:"string",minLength:1,maxLength:256},token:{type:"string",minLength:1,maxLength:8192},decision:{type:"string",enum:["approve","reject","status","refresh"]}},required:["previewId","token","decision"],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true},_meta:{ui:{visibility:["app"]},"openai/widgetAccessible":true,"openai/visibility":"private"}};
}
export function contentMcpAppResourcesList() {
  return {resources:[{uri:CONTENT_APP_URI,name:"Growth content review",mimeType:CONTENT_APP_MIME}]};
}
function mediaOrigin(publicApiUrl:string):string {
  let url:URL;try{url=new URL(publicApiUrl);}catch{throw new ApiError(503,"content_confirmation_unavailable","Content media origin is not configured");}
  if(!["http:","https:"].includes(url.protocol)||url.username||url.password||!/^https?:\/\/(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d+)?$/i.test(url.origin))throw new ApiError(503,"content_confirmation_unavailable","Content media origin is invalid");
  return url.origin;
}
export function readContentMcpAppResource(uri:string,publicApiUrl:string) {
  if(uri!==CONTENT_APP_URI)throw new ApiError(404,"not_found","Content review resource not found");
  const origin=mediaOrigin(publicApiUrl);
  return {contents:[{uri:CONTENT_APP_URI,mimeType:CONTENT_APP_MIME,text:contentMcpAppHtml.replaceAll("__GROWTH_MEDIA_ORIGIN__",origin),
    _meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[origin],frameDomains:[],baseUriDomains:[]}}}}]};
}
function raw(value:Json,meta?:Json) {
  const output=JSON.parse(apiJson(value)) as Json;
  return {content:[{type:"text" as const,text:JSON.stringify(output)}],structuredContent:output,...(meta?{_meta:meta}:{})};
}
async function delivery(core:CoreContext,ctx:RequestContext,row:OperationReviewRow):Promise<Json|undefined> {
  if(!publicationActions.has(row.operation)||!["succeeded","executing","uncertain"].includes(row.state))return;
  const result=object(row.result)?row.result:{};
  const batch=object(result.batch)?result.batch:{};
  let batchId=typeof result.batchId==="string"?result.batchId:typeof batch.batchId==="string"?batch.batchId:row.input.batchId;
  if(typeof batchId!=="string")batchId=(await core.pool.query(`SELECT id FROM "SocialPublishBatch" WHERE "orgId"=$1 AND "idempotencyKey"=$2`,[ctx.organizationId,operationDomainKey(row.id)])).rows[0]?.id;
  if(typeof batchId!=="string")return {status:row.state==="executing"?"PROCESSING":"UNKNOWN"};
  const status=await getBatch(core.pool,ctx,batchId);
  return Object.fromEntries(Object.entries(status).filter(([key])=>["batchId","status","publishedCount","processingCount","unknownCount","failedCount","blockedCount","targetCount","targets","errorCode","errorMessage"].includes(key)));
}
async function mediaPreviews(core:CoreContext,ctx:RequestContext,row:OperationReviewRow,preview:Json):Promise<Json[]> {
  const requested=[...(Array.isArray(preview.media)?preview.media:[]),...(Array.isArray(preview.removedMedia)?preview.removedMedia:[])].filter(object)
    .filter((item,index,all)=>typeof item.assetId==="string"&&all.findIndex(other=>other.assetId===item.assetId)===index).slice(0,20);
  if(!requested.length)return [];
  const unavailable=(reason:string)=>requested.map(item=>({assetId:item.assetId,kind:item.kind,unavailable:reason}));
  try{await authorizeGrowthOperation(core,ctx,"content.media.preview");}catch(error){if(error instanceof ApiError&&[401,403].includes(error.status))return unavailable("read_access_required");throw error;}
  const revision=await contentPreviewMediaAssetsDigest(core,ctx,requested.map(item=>item.assetId as string));
  if(revision!==row.snapshot.mediaAssets)return unavailable("asset_changed_or_unavailable");
  return Promise.all(requested.map(async item=>{
    try{
      const result=await invokeGrowthOperation(core,ctx,"content.media.preview",{assetId:item.assetId});
      if(!object(result)||typeof result.previewUrl!=="string"||new URL(result.previewUrl).origin!==mediaOrigin(core.config.publicApiUrl))return {assetId:item.assetId,kind:item.kind,unavailable:"preview_unavailable"};
      return {assetId:item.assetId,kind:item.kind,previewUrl:result.previewUrl};
    }catch(error){if(error instanceof ApiError&&error.status<500)return {assetId:item.assetId,kind:item.kind,unavailable:"preview_unavailable"};throw error;}
  }));
}
async function appResult(core:CoreContext,ctx:RequestContext,row:OperationReviewRow) {
  const preview=JSON.parse(row.snapshot.preview??"null") as unknown;
  if(!object(preview))throw invalid();
  const state=operationReviewState(row),published=await delivery(core,ctx,row);
  const value:Json={state,previewId:row.id,action:row.operation,payloadDigest:row.payloadDigest,expiresAt:new Date(row.expiresAt).toISOString(),postId:preview.postId,
    accounts:preview.accounts,scheduledFor:preview.scheduledFor,timezone:preview.timezone,validation:preview.validation,
    ...(row.state==="succeeded"?{outcome:publicationActions.has(row.operation)?"publication_admitted":"action_completed"}:{}),...(published?{delivery:published}:{})};
  const nonce=seal(core,ctx,row);
  const media=await mediaPreviews(core,ctx,row,preview);
  // The app receives the full exact preview. Model output is a separate bounded summary, not a cursor for different content.
  if(Buffer.byteLength(apiJson(value))>8192){delete value.accounts;if(object(value.delivery))value.delivery=Object.fromEntries(Object.entries(value.delivery).filter(([key])=>key!=="targets"));}
  if(Buffer.byteLength(apiJson(value))>8192)throw new ApiError(413,"operation_result_too_large","Content review summary exceeds the result limit");
  return raw(value,{[META_KEY]:{previewId:row.id,...nonce,state,preview,mediaPreviews:media,
    ...(value.outcome?{outcome:value.outcome}:{}),...(published?{delivery:published}:{})}});
}
async function reviewedResult(core:CoreContext,ctx:RequestContext,operation:string,args:Json,value:Json):Promise<OperationReviewRow|null> {
  let id:unknown;
  if(isContentPublicOperation(operation))id=object(value.review)?value.review.id:undefined;
  else if(operation==="content.actions.preview") {
    const result=object(value.result)?value.result:undefined;
    id=result&&object(result.preview)?result.preview.previewId:undefined;
    if(!id&&typeof args.requestId==="string")id=(await core.pool.query(`SELECT id FROM "GrowthOperationReview" WHERE "orgId"=$1 AND "userId"=$2 AND "principalKind"=$3 AND "principalId"=$4 AND "requestKey"=$5`,[ctx.organizationId,ctx.userId,ctx.principal.kind,ctx.principal.id,args.requestId])).rows[0]?.id;
  }
  if(typeof id!=="string")return null;
  const row=await getOperationReview(core,ctx,id);
  const invocation=growthToolArguments(args);
  const action=operation==="content.actions.preview"?args.action:operation;
  const input=operation==="content.actions.preview"?args.input:invocation.input;
  if(typeof action!=="string"||!isContentPublicOperation(action)||!object(input)||row.operation!==action||row.payloadDigest!==growthOperationPayloadDigest(action,input))throw invalid();
  const requestKey=operation==="content.actions.preview"?args.requestId:invocation.requestId;
  if(requestKey!==undefined&&requestKey!==row.requestKey||invocation.reviewId!==undefined&&invocation.reviewId!==row.id)throw invalid();
  await authorizeGrowthOperation(core,{...ctx,idempotencyKey:row.requestKey},row.operation);
  return row;
}
/** Only UI metadata carries the capability token. The model receives content and status. */
export async function decorateContentMcpAppResult(core:CoreContext,ctx:RequestContext,operation:string,args:Json,value:Json) {
  const row=await reviewedResult(core,ctx,operation,args,value);
  return row?appResult(core,ctx,row):raw(value);
}
export async function invokeContentMcpAppControl(core:CoreContext,ctx:RequestContext,args:Json) {
  return auditGrowthAccess(core,ctx,"content.confirmation",()=>runContentMcpAppControl(core,ctx,args));
}
async function runContentMcpAppControl(core:CoreContext,ctx:RequestContext,args:Json) {
  if(!object(args)||Object.keys(args).length!==3||typeof args.previewId!=="string"||!args.previewId||args.previewId.length>256||typeof args.decision!=="string"||!["approve","reject","status","refresh"].includes(args.decision))throw invalid();
  const nonce=unseal(core,ctx,args.token);
  if(nonce.previewId!==args.previewId)throw invalid();
  let row=await getOperationReview(core,ctx,nonce.previewId);
  if(!isContentPublicOperation(row.operation)||row.operation!==nonce.operation||row.payloadDigest!==nonce.payloadDigest||row.requestKey!==nonce.requestKey)throw invalid();
  await authorizeGrowthOperation(core,{...ctx,idempotencyKey:row.requestKey},row.operation);
  if(args.decision==="status") {
    if(row.state==="proposed"&&+new Date(row.expiresAt)>Date.now())row=await refreshContentOperationPreview(core,ctx,row.id,row.payloadDigest);
    if(["executing","uncertain"].includes(row.state))row=await observeGrowthOperationReceipt(core,ctx,row);
    return appResult(core,ctx,row);
  }
  if(args.decision==="refresh")return appResult(core,ctx,await refreshContentOperationPreview(core,ctx,row.id,row.payloadDigest));
  // Expired UI nonces may observe a durable outcome, but may never admit another effect.
  if(["executing","succeeded","uncertain","rejected","failed"].includes(row.state))return appResult(core,ctx,row);
  if(nonce.expires<=Date.now())throw invalid();
  if(args.decision==="reject")row=await rejectContentOperationReview(core,ctx,row.id,row.payloadDigest,"mcp_app");
  else {
    await confirmContentOperationReview(core,ctx,row.id,row.payloadDigest,"mcp_app");
    await executeGrowthOperation(core,ctx,{operation:row.operation,input:row.input,requestId:row.requestKey,reviewId:row.id});
    row=await getOperationReview(core,ctx,row.id);
  }
  return appResult(core,ctx,row);
}
