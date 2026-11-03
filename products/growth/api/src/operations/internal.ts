import type { ProductCapabilityInvocation, ProductCapabilityResult, ProductReviewReference } from "@kasitek-labs/contracts";
import type { CoreContext } from "../context.js";
import type { RequestContext } from "../identity/request-context.js";
import { ApiError } from "../error.js";
import { authorizeGrowthOperation } from "./policy.js";
import { boundedGrowthOperationResult, executeGrowthOperation, getOperationReview, operationReviewState, operationReviewView, type OperationReviewRow } from "./reviews.js";
import { growthToolArguments, requireGrowthAgentAccess } from "./transport.js";
import { getGrowthOperation } from "./catalog.js";
import { assertGrowthReadAccess, growthReadResources, issueGrowthEffectAccess, issueGrowthReadAccess, type GrowthReadAccess } from "./read-access.js";

export function internalOperationContext(command: Pick<ProductCapabilityInvocation, "actor" | "authority" | "operationId" | "requestId">): RequestContext {
  return { principal: { kind: "trusted_internal_service", id: command.actor.subject, subjectUserId: command.actor.subject, clientId: "growth-execution" },
    organizationId: command.authority.tenantId, userId: command.actor.subject, clientId: "growth-execution",
    effectiveGrants: new Set(), apiScopes: new Set(["growth:read", "growth:draft", "growth:publish", "growth:manage"]),
    correlationId: command.requestId, causationId: null, idempotencyKey: command.operationId };
}
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
  const observation=(command as ProductCapabilityInvocation & {observation?:unknown}).observation;
  const definition=getGrowthOperation(command.operation);
  if(observation!==undefined && !(observation==="access-v1" && command.control==="invoke" && (definition.effect==="read"||definition.stagingControl===true) ||
      observation==="effect-status-v1" && ["review","commit"].includes(command.control) && definition.review==="required"))
    throw new ApiError(403,"operation_control_denied","The observation is unavailable");
  if (command.control === "authorize") return { value: { authorized: true } };
  if (command.control === "evidence") return {value:await assertGrowthReadAccess(core,context,command)};
  if (command.control === "review" || command.control === "commit") {
    if (!command.review || command.review.product !== "growth" || command.review.taskId !== command.taskId || command.review.operationId !== command.operationId) throw new ApiError(403, "operation_review_denied", "The review belongs to another operation");
    const row = await getOperationReview(core, context, command.review.id);
    if (row.operation !== command.operation || row.taskId !== command.taskId || row.operationId !== command.operationId || row.payloadDigest !== command.review.payloadDigest) throw new ApiError(403, "operation_review_denied", "The review belongs to another operation");
    const result = command.control === "commit" ? await executeGrowthOperation(core, context, { operation: row.operation, input: row.input, requestId: row.requestKey, reviewId: row.id }) : boundedGrowthOperationResult({ state: row.state, review: operationReviewView(core, row), result: row.result });
    const latest = await getOperationReview(core, context, row.id);
    const review=reference(latest);
    let access:GrowthReadAccess|undefined;
    if(observation==="effect-status-v1"&&review.state==="saved") {
      try {access=await issueGrowthEffectAccess(core,context,command,review,result);}
      catch {throw new ApiError(503,"agent_effect_access_unavailable","The saved effect needs reconciliation");}
    }
    return { value: result, review, ...(access?{access}:{}), ...(latest.state === "succeeded" ? { receipt: { id: latest.id, operationId: command.operationId, payloadDigest: latest.payloadDigest, state: "saved" as const } } : {}) };
  }
  const args = growthToolArguments(command.input as Record<string, unknown>);
  let access:GrowthReadAccess|undefined;
  const value = await executeGrowthOperation(core, context, { operation: command.operation, ...args, requestId: args.requestId ?? command.operationId,
    taskId: command.taskId, conversationId: command.conversationId, operationId: command.operationId, prepareOnly: command.control === "prepare",
    ...(observation==="access-v1"?{captureRead:async (raw,details)=>{
      if(raw.state!=="succeeded")throw new ApiError(409,"agent_read_access_unavailable","The read result cannot be retained safely");
      if(command.operation==="operations.reviews.get")await authorizeGrowthOperation(core,context,String((details.review as {operation?:unknown})?.operation),{discovery:true});
      const prepared=growthReadResources(command.operation,args.input,raw.result,details);
      if(command.operation==="workspace.read" && (raw.result as {workspace?:{id?:unknown}})?.workspace?.id!==command.authority.tenantId)
        throw new ApiError(403,"agent_read_access_unavailable","The read result is outside the workspace");
      return async bounded=>{access=await issueGrowthReadAccess(core,command,prepared,bounded);};
    }}:{}) });
  if (command.control === "prepare") {
    const view = value.review as { id: string } | undefined;
    if (!view) throw new ApiError(409, "operation_review_missing", "No review was created for this operation");
    return { value, review: reference(await getOperationReview(core, context, view.id)) };
  }
  return { value,...(access?{access}:{}) };
}
