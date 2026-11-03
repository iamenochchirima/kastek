import { deadlineMillis } from "../lifecycle/deadline";
import * as restate from "@restatedev/restate-sdk";
import type { Pool } from "pg";
import type { ProductReviewReference } from "@kasitek-labs/contracts";
import type { CapabilityBinding } from "../../contracts/capability-catalog";
import type { ProductRuntimePort } from "../products/product-runtime";
import type { TaskOutcome } from "../../contracts/execution";
import { PlatformError,terminalTaskStates } from "../../contracts/contracts";
import { event } from "../lifecycle/execution";
import { productEffectProjection } from "../../capabilities/products/product-capabilities";
export async function awaitProductReview(ctx:restate.WorkflowContext,pool:Pool,runtime:ProductRuntimePort,taskId:string,operationId:string,binding:CapabilityBinding,args:unknown):
  Promise<{review:ProductReviewReference}|{outcome:TaskOutcome}|{errorCode:string}> {
  const prepared=await ctx.run("product-prepare:"+operationId,async()=>{
    try {if(!productEffectProjection(binding))throw new PlatformError("PRODUCT_PROJECTION_UNAVAILABLE",403,"The product result is unavailable");await runtime.authorizeTask(taskId);const value=await runtime.prepare(taskId,operationId,binding,args);return {review:value.review!};}
    catch(error){if(error instanceof PlatformError)return {code:error.code};throw error;}
  });
  if("code" in prepared){
    if(prepared.code!==undefined&&["TOOL_ARGUMENTS_INVALID","AGENT_DESTINATION_REQUIRED","AGENT_DESTINATION_UNAVAILABLE"].includes(prepared.code))return {errorCode:prepared.code};
    return {outcome:{state:"incomplete",errorCode:prepared.code}};
  }
  let review=prepared.review;
  for(let attempt=0;attempt<64;attempt++) {
    const current=await ctx.run("product-review:"+operationId+":"+attempt,async()=>{
      try {
        const task=(await pool.query("SELECT state,control_generation,deadline_at FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];
        if(!task||task.state==="cancel_requested")return {outcome:{state:"cancelled" as const}};
        if(terminalTaskStates.has(task.state))return {outcome:{state:task.state as TaskOutcome["state"]}};
        const result=await runtime.review(taskId,operationId,binding,review),latest=result.review!;
        if(latest.state==="approved"||latest.state==="saved") {
          await pool.query("UPDATE agents_platform.tasks SET state='running',updated_at=now() WHERE id=$1 AND state='waiting_review'",[taskId]);return {review:latest,approved:true as const};
        }
        if(latest.state!=="proposed"||new Date(latest.expiresAt).getTime()<=Date.now())return {outcome:{state:"incomplete" as const,errorCode:"PRODUCT_REVIEW_"+latest.state.toUpperCase()}};
        await pool.query("UPDATE agents_platform.tasks SET state='waiting_review',updated_at=now() WHERE id=$1 AND state='running'",[taskId]);
        await event(pool,taskId,"product-review:"+latest.id,"review.required",{reviewId:latest.id,product:latest.product,kind:"product",bindingId:binding.id,operationId,expiresAt:latest.expiresAt});
        return {review:latest,generation:task.control_generation,deadline:Math.min(deadlineMillis(task.deadline_at),new Date(latest.expiresAt).getTime())};
      }catch(error){if(error instanceof PlatformError)return {outcome:{state:"incomplete" as const,errorCode:error.code}};throw error;}
    });
    if("outcome" in current&&current.outcome)return {outcome:current.outcome};
    review=current.review;if(current.approved)return {review};
    await restate.RestatePromise.race([ctx.promise("review:"+current.generation).get(),ctx.sleep(Math.max(1,current.deadline!-await ctx.date.now()))]);
  }
  return {outcome:{state:"incomplete",errorCode:"PRODUCT_REVIEW_WAIT_LIMIT"}};
}
