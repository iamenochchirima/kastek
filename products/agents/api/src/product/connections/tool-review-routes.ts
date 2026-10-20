import type { FastifyInstance,FastifyRequest } from "fastify";
import { z } from "zod";
import type { ActionScope } from "../../contracts/connections";
import { ToolReviewStore } from "../../capabilities/reviews/tool-reviews";
import { PlatformError } from "../../contracts/contracts";

export function registerToolReviewRoutes(app:FastifyInstance,options:{store:ToolReviewStore;resolveTask(request:FastifyRequest):Promise<ActionScope&{taskId:string}>}) {
  const base="/api/organizations/:organizationId/tasks/:taskId/tool-reviews";
  app.get(base,async request=>{const scope=await options.resolveTask(request);return {reviews:await options.store.list(scope,scope.taskId)};});
  app.post(`${base}/:reviewId/decision`,async request=>{
    const scope=await options.resolveTask(request),id=z.uuid().parse((request.params as Record<string,string>).reviewId);
    const input=z.strictObject({decision:z.enum(["approve","reject"]),requestDigest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.body);
    const allowed=await options.store.list(scope,scope.taskId);
    if(!allowed.some(review=>review.id===id))throw new PlatformError("NOT_FOUND",404,"Tool review not found");
    return {review:await options.store.decide(scope,id,input)};
  });
}
