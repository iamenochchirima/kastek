import type { FastifyInstance } from "fastify";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { resolveProductContext } from "../identity/request-context.js";
import { requireOrigin } from "../identity/session.js";
import { listGrowthOperations } from "./policy.js";
import { executeGrowthOperation, getOperationReview, decideOperationReview, operationReviewView } from "./reviews.js";
import { growthToolArguments, growthToolInputSchema, requireGrowthAgentAccess, resolveGrowthOperationContext } from "./transport.js";
import { GrowthAgentClient } from "../agents/client.js";
import { growthAgentActor } from "../agents/security.js";
import { auditGrowthAccess } from "./telemetry.js";

export function registerGrowthOperationRoutes(app: FastifyInstance, core: CoreContext) {
  app.get("/v1/operations", async request => {
    const context = await resolveGrowthOperationContext(core, request);
    return auditGrowthAccess(core, context, "discovery", async () => ({ operations: (await listGrowthOperations(core, context)).map(operation => ({ ...operation, inputSchema: growthToolInputSchema(operation) })) }));
  });
  app.post("/v1/operations/:operation", { bodyLimit: 4 * 1024 * 1024 }, async request => {
    const context = await resolveGrowthOperationContext(core, request);
    if (context.principal.kind === "direct_user") requireOrigin(request, core);
    const operation = (request.params as { operation: string }).operation;
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) throw new ApiError(422, "operation_arguments_invalid", "Check the operation arguments");
    const args = growthToolArguments(request.body as Record<string, unknown>);
    return executeGrowthOperation(core, context, { operation, ...args });
  });
  app.get("/v1/operation-reviews/:id", async request => {
    const context = await resolveGrowthOperationContext(core, request);
    return auditGrowthAccess(core, context, "operations.reviews.get", async () => ({ review: operationReviewView(core, await getOperationReview(core, context, (request.params as { id: string }).id)) }));
  });
  app.get("/api/operations/reviews/:id", async request => {
    const context = await resolveProductContext(request, core);
    const review = await getOperationReview(core, context, (request.params as { id: string }).id, true);
    return { review: operationReviewView(core, review) };
  });
  app.post("/api/operations/reviews/:id/decision", async request => {
    requireOrigin(request, core);
    requireGrowthAgentAccess(core);
    const context = await resolveProductContext(request, core);
    const body = request.body as { decision?: unknown; payloadDigest?: unknown } | null;
    if (!body || !["approve", "reject"].includes(String(body.decision)) || typeof body.payloadDigest !== "string") throw new ApiError(422, "operation_review_invalid", "Choose a review decision");
    const row = await decideOperationReview(core, context, (request.params as { id: string }).id, body.decision as "approve" | "reject", body.payloadDigest);
    // The caller resumes the original operation. Approval alone never performs an external effect.
    let resumePending = false;
    if (row.taskId) {
      try {
        await new GrowthAgentClient(core.config).command({ tenantId: row.orgId, actor: growthAgentActor(core.config, row.userId) }, "reviews.decide", { taskId: row.taskId, reviewId: row.id, payloadDigest: row.payloadDigest, decision: body.decision as "approve" | "reject" }, `operation-review:${row.id}:${body.decision}`);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status < 500) throw error;
        resumePending = true;
      }
    }
    return { review: operationReviewView(core, row), resumePending };
  });
}
