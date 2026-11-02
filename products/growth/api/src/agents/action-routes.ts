import type { FastifyInstance } from "fastify";
import { GROWTH_AGENT_ACTION_PATH, GrowthAgentContractError, growthAgentCanonicalJson, parseGrowthAgentAction } from "@kasitek-labs/contracts";
import { registerGrowthCapabilityRoutes } from "./capability-routes.js";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { verifyGrowthAgentAction } from "./security.js";
import { authorizeGrowthAgentScope, assertGrowthAgentContext, readGrowthAgentContext } from "./scope.js";
import { GrowthAgentReviewStore, type GrowthDraftPorts } from "./reviews.js";
import { getOperationReview } from "../operations/reviews.js";
import { internalOperationContext, internalOperationReviewView } from "../operations/internal.js";
import { authorizeGrowthOperation } from "../operations/policy.js";
export function registerGrowthAgentActionRoutes(app: FastifyInstance, core: CoreContext, options: { drafts?: GrowthDraftPorts } = {}): void {
  registerGrowthCapabilityRoutes(app,core,options);
  const reviews = new GrowthAgentReviewStore(core, options.drafts);
  app.post(GROWTH_AGENT_ACTION_PATH, { bodyLimit: 1048576 }, async (request) => {
    let action;
    try { action = parseGrowthAgentAction(request.body); } catch (error) {
      if (error instanceof GrowthAgentContractError) throw new ApiError(400, "agent_action_invalid", "Check the agent action fields");
      throw error;
    }
    await verifyGrowthAgentAction(core.config, request.headers.authorization, request.body);
    const scope = { tenantId: action.tenantId, actor: action.actor };
    await authorizeGrowthAgentScope(core, scope, action.featureId);
    if (action.operation !== "operation.review.read") await assertGrowthAgentContext(core, scope, action.context, action.contextRevision);
    switch (action.operation) {
      case "operation.review.read": {
        const context = internalOperationContext({ actor: action.actor, authority: { tenantId: action.tenantId } as import("@kasitek-labs/contracts").ProductCapabilityAuthority, operationId: action.operationId, requestId: action.requestId });
        const row = await getOperationReview(core, context, action.input.reviewId);
        if (row.taskId !== action.taskId || row.conversationId !== action.conversationId) throw new ApiError(403, "operation_review_denied", "The review belongs to another task");
        await authorizeGrowthOperation(core, context, row.operation, { discovery: true });
        return { review: internalOperationReviewView(core, row), result: null };
      }
      case "authorization.check":
        if (action.input.context !== undefined && growthAgentCanonicalJson(action.input.context) !== growthAgentCanonicalJson(action.context)) throw new ApiError(403, "agent_context_denied", "The action does not cover this record");
        return { authorized: true };
      case "workspace.read": return readGrowthAgentContext(core, scope, { kind: "workspace" });
      case "context.read":
        if (!action.context || growthAgentCanonicalJson(action.input.context) !== growthAgentCanonicalJson(action.context)) throw new ApiError(403, "agent_context_denied", "The action does not cover this record");
        return readGrowthAgentContext(core, scope, action.input.context);
      case "draft.prepare":
        throw new ApiError(403,"agent_capability_required","Use an admitted product capability for content changes");
      case "draft.commit": return reviews.commit(action);
      case "draft.reconcile": return reviews.reconcile(action);
    }
  });
}
