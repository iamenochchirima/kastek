import type { ProductCapabilityInvocation, ProductCapabilityResult, ProductReviewReference } from "@kasitek-labs/contracts";
import type { CoreContext } from "../context.js";
import type { RequestContext } from "../identity/request-context.js";
import { ApiError } from "../error.js";
import { authorizeGrowthOperation } from "./policy.js";
import { boundedGrowthOperationResult, executeGrowthOperation, getOperationReview, operationReviewState, operationReviewView, type OperationReviewRow, isDirectContentOperation, isContentPublicOperation, growthOperationPayloadDigest, observeGrowthOperationReceipt, prepareInternalContentActionFromPreview } from "./reviews.js";
import { growthToolArguments, requireGrowthAgentAccess } from "./transport.js";

export function internalOperationContext(command: Pick<ProductCapabilityInvocation, "actor" | "authority" | "operationId" | "requestId">): RequestContext {
  return { principal: { kind: "trusted_internal_service", id: command.actor.subject, subjectUserId: command.actor.subject, clientId: "growth-execution" },
    organizationId: command.authority.tenantId, userId: command.actor.subject, clientId: "growth-execution",
    effectiveGrants: new Set(), apiScopes: new Set(["growth:read", "growth:draft", "growth:publish", "growth:manage"]),
    correlationId: command.requestId, causationId: null, idempotencyKey: command.operationId };
}
const isRequestedContentOperation = (name: string) => isDirectContentOperation(name) || isContentPublicOperation(name);
function reference(row: OperationReviewRow): ProductReviewReference {
  const current = operationReviewState(row);
  const state = current === "succeeded" ? "saved" : ["executing", "failed", "uncertain"].includes(current) ? "uncertain" : current;
  return { id: row.id, product: "growth", taskId: row.taskId!, operationId: row.operationId!, payloadDigest: row.payloadDigest,
    state: state as ProductReviewReference["state"], expiresAt: new Date(row.expiresAt).toISOString() };
}
export function internalOperationReviewView(core: CoreContext, row: OperationReviewRow) {
  const view = operationReviewView(core, row);
  return { id: row.id, taskId: row.taskId!, conversationId: row.conversationId!, featureId: "content" as const,
    kind: "operation" as const, operation: row.operation, input: view.input, reviewUrl: view.reviewUrl,
    payloadDigest: row.payloadDigest, state: view.state,
    createdAt: new Date((row as OperationReviewRow & { createdAt: Date }).createdAt).toISOString(), expiresAt: view.expiresAt, result: null };
}
export async function invokeInternalGrowthOperation(core: CoreContext, command: ProductCapabilityInvocation): Promise<ProductCapabilityResult> {
  requireGrowthAgentAccess(core);
  const context = internalOperationContext(command);
  await authorizeGrowthOperation(core, context, command.operation, { discovery: true });
  const retainedContentReview = isDirectContentOperation(command.operation) && command.operation !== "content.media.transfer.prepare" && ["6","7","8"].includes(command.authority.policyRevision);
  if (command.control === "authorize") return { value: { authorized: true } };
  if (command.control === "evidence") throw new ApiError(403, "operation_control_denied", "Use the canonical read operation");
  if (command.control === "review" && !command.review && !retainedContentReview && isRequestedContentOperation(command.operation)) {
    const args=growthToolArguments(command.input as Record<string,unknown>);
    const row=(await core.pool.query<OperationReviewRow>(`SELECT * FROM "GrowthOperationReview" WHERE "orgId"=$1 AND "userId"=$2 AND "principalKind"=$3 AND "principalId"=$4 AND "requestKey"=$5`,[context.organizationId,context.userId,context.principal.kind,context.principal.id,command.operationId])).rows[0];
    if (!row) return {value:{state:"uncertain",message:"No receipt exists for this operation; status checks do not admit a new write"}};
    if (row.operation!==command.operation || row.version!=="1" || row.taskId!==command.taskId || row.conversationId!==command.conversationId || row.operationId!==command.operationId || row.payloadDigest!==growthOperationPayloadDigest(command.operation,args.input)) throw new ApiError(403,"operation_receipt_denied","The receipt belongs to another operation");
    const latest=await observeGrowthOperationReceipt(core,context,row);
    return {value:boundedGrowthOperationResult({state:latest.state,result:latest.result,review:operationReviewView(core,latest)}),...(latest.state==="succeeded"?{receipt:{id:latest.id,operationId:command.operationId,payloadDigest:latest.payloadDigest,state:"saved" as const}}:{})};
  }
  if (command.control === "review" || command.control === "commit") {
    if (!command.review || command.review.product !== "growth" || command.review.taskId !== command.taskId || command.review.operationId !== command.operationId) throw new ApiError(403, "operation_review_denied", "The review belongs to another operation");
    const row = await getOperationReview(core, context, command.review.id);
    if (row.operation !== command.operation || row.taskId !== command.taskId || row.conversationId !== command.conversationId || row.operationId !== command.operationId || row.payloadDigest !== command.review.payloadDigest) throw new ApiError(403, "operation_review_denied", "The review belongs to another operation");
    const result = command.control === "commit" ? await executeGrowthOperation(core, context, { operation: row.operation, input: row.input, requestId: row.requestKey, reviewId: row.id, forceReviewed:retainedContentReview }) : boundedGrowthOperationResult({ state: row.state, review: operationReviewView(core, row), result: row.result });
    const latest = await getOperationReview(core, context, row.id);
    return { value: result, review: reference(latest), ...(latest.state === "succeeded" ? { receipt: { id: latest.id, operationId: command.operationId, payloadDigest: latest.payloadDigest, state: "saved" as const } } : {}) };
  }
  const args = growthToolArguments(command.input as Record<string, unknown>);
  if (["prepare", "invoke"].includes(command.control) && isContentPublicOperation(command.operation) && typeof (command.input as Record<string,unknown>)._previewId === "string") {
    const existing=(await core.pool.query<OperationReviewRow>(`SELECT * FROM "GrowthOperationReview" WHERE "orgId"=$1 AND "principalKind"=$2 AND "principalId"=$3 AND "requestKey"=$4`,[context.organizationId,context.principal.kind,context.principal.id,command.operationId])).rows[0];
    if(existing && existing.state !== "proposed") {
      if(existing.operation!==command.operation || existing.taskId!==command.taskId || existing.conversationId!==command.conversationId || existing.operationId!==command.operationId || existing.payloadDigest!==growthOperationPayloadDigest(command.operation,args.input)) throw new ApiError(403,"operation_receipt_denied","The receipt belongs to another operation");
      const value=await executeGrowthOperation(core,context,{operation:existing.operation,input:existing.input,requestId:existing.requestKey,reviewId:existing.id,prepareOnly:command.control==="prepare"});
      const latest=await getOperationReview(core,context,existing.id);
      return {value,...(latest.state==="succeeded"?{receipt:{id:latest.id,operationId:command.operationId,payloadDigest:latest.payloadDigest,state:"saved" as const}}:{})};
    }
    const value=await prepareInternalContentActionFromPreview(core,context,args.reviewId!,{operation:command.operation,input:args.input,taskId:command.taskId,conversationId:command.conversationId,operationId:command.operationId});
    const row=await getOperationReview(core,context,(value.review as {id:string}).id);
    if (command.control === "prepare") return {value,review:reference(row)};
    const result = await executeGrowthOperation(core,context,{operation:command.operation,input:args.input,requestId:command.operationId,reviewId:row.id});
    const latest = await getOperationReview(core,context,row.id);
    return {value:result,...(latest.state === "succeeded" ? {receipt:{id:latest.id,operationId:command.operationId,payloadDigest:latest.payloadDigest,state:"saved" as const}} : {})};
  }
  const value = await executeGrowthOperation(core, context, { operation: command.operation, ...args, requestId: isRequestedContentOperation(command.operation) ? command.operationId : args.requestId ?? command.operationId,
    taskId: command.taskId, conversationId: command.conversationId, operationId: command.operationId, prepareOnly: command.control === "prepare",forceReviewed:retainedContentReview });
  if (command.control === "prepare") {
    const view = value.review as { id: string } | undefined;
    if (!view) throw new ApiError(409, "operation_review_missing", "No review was created for this operation");
    return { value, review: reference(await getOperationReview(core, context, view.id)) };
  }
  if (isRequestedContentOperation(command.operation) && command.control === "invoke") {
    const id=(value.review as {id?:string}|undefined)?.id;
    if (!id) return {value};
    const row=await getOperationReview(core,context,id);
    if (row.operation!==command.operation || row.operationId!==command.operationId || row.taskId!==command.taskId || row.conversationId!==command.conversationId || row.requestKey!==command.operationId || row.payloadDigest!==growthOperationPayloadDigest(command.operation,args.input)) throw new ApiError(403,"operation_receipt_denied","The receipt belongs to another operation");
    return {value,...(row.state==="succeeded"?{receipt:{id:row.id,operationId:command.operationId,payloadDigest:row.payloadDigest,state:"saved" as const}}:{})};
  }
  return { value };
}
