import { z } from "zod";
import type { CapabilityBinding } from "../../contracts/capability-catalog";
import { PlatformError } from "../../contracts/contracts";
import { productEffectProjection,productReadProjection,productDescriptor } from "../../capabilities/products/product-capabilities";

const savedEffect=z.object({
  review:z.object({id:z.string().min(1).max(256),taskId:z.uuid(),operationId:z.string().min(1).max(256),payloadDigest:z.string().regex(/^[a-f0-9]{64}$/),state:z.literal("saved")}),
  receipt:z.object({operationId:z.string().min(1).max(256),payloadDigest:z.string().regex(/^[a-f0-9]{64}$/),state:z.literal("saved")}),
});
const modelDate=z.union([z.string().min(1).max(64),z.date()]).nullable().optional();
const contentPost=z.object({
  id:z.string().min(1).max(256),title:z.string().nullable(),content:z.string(),channels:z.array(z.string().max(64)),status:z.string().max(40),
  scheduled_for:modelDate,published_at:modelDate,updated_at:z.union([z.string().min(1).max(64),z.date()]),
  variants:z.array(z.object({platform:z.string().max(64),content:z.string(),status:z.string().max(40)})),
  media:z.array(z.object({asset_id:z.string().min(1).max(256),kind:z.string().max(64),mime_type:z.string().max(128),alt_text:z.string().nullable(),sort_order:z.number().int()})),
});
const postRead=z.object({post:contentPost});
const postList=z.object({posts:z.array(contentPost),pagination:z.object({limit:z.number().int().positive(),cursor:z.number().int().nonnegative(),nextCursor:z.number().int().nonnegative().nullable()})});

/** The native receipt remains unchanged; only its authorized model view is narrowed. */
export function productModelResult(binding:CapabilityBinding,output:unknown,taskId:string,operationId:string):unknown {
  if(binding.policy.effect==="read"){
    const descriptor=productDescriptor(binding),operation=descriptor.operation;
    const installedProjection=productReadProjection(binding)==="growth-content-post-read-v1";
    // Retained tasks may still pin earlier Growth adapter releases. Apply the same safe model
    // view to their exact canonical read operations without changing their native receipts.
    const retainedGrowthRead=binding.adapter.id==="growth-product"&&binding.authority?.destinationProduct==="growth"&&
      descriptor.policy.effect==="read"&&descriptor.evidence==="none"&&["content.posts.get","content.posts.list"].includes(operation)&&
      descriptor.handlerRef===`growth.operation.${operation}@${descriptor.revision}`;
    if(!installedProjection&&!retainedGrowthRead)return output;
    if(operation==="content.posts.get"){
      const parsed=postRead.safeParse(output);if(!parsed.success)throw projectionUnavailable();
      return {post:modelPost(parsed.data.post)};
    }
    if(operation==="content.posts.list"){
      const parsed=postList.safeParse(output);if(!parsed.success)throw projectionUnavailable();
      return {posts:parsed.data.posts.map(modelPost),pagination:parsed.data.pagination};
    }
    throw projectionUnavailable();
  }
  if(binding.policy.effect!=="reviewed_write")return output;
  if(productEffectProjection(binding)!=="effect-status-v1")throw new PlatformError("PRODUCT_PROJECTION_UNAVAILABLE",403,"The product result is unavailable");
  const parsed=savedEffect.safeParse(output);
  if(!parsed.success||parsed.data.review.taskId!==taskId||parsed.data.review.operationId!==operationId||
    parsed.data.receipt.operationId!==operationId||parsed.data.receipt.payloadDigest!==parsed.data.review.payloadDigest)
    throw new PlatformError("PRODUCT_EFFECT_UNCERTAIN",409,"The product effect has not been confirmed");
  return {value:{state:"saved",reviewId:parsed.data.review.id}};
}
function modelPost(post:z.infer<typeof contentPost>){
  return {id:post.id,title:post.title,content:post.content,channels:post.channels,status:post.status,
    ...(post.scheduled_for!==undefined?{scheduledFor:wireDate(post.scheduled_for)}:{}),...(post.published_at!==undefined?{publishedAt:wireDate(post.published_at)}:{}),
    updatedAt:wireDate(post.updated_at)!,variants:post.variants.map(variant=>({platform:variant.platform,content:variant.content,status:variant.status})),
    media:post.media.map(item=>({assetId:item.asset_id,kind:item.kind,mimeType:item.mime_type,altText:item.alt_text,sortOrder:item.sort_order}))};
}
function wireDate(value:string|Date|null|undefined){return value instanceof Date?value.toISOString():value;}
function projectionUnavailable(){return new PlatformError("PRODUCT_PROJECTION_UNAVAILABLE",403,"The product result is unavailable");}
