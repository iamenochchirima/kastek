import * as restate from "@restatedev/restate-sdk";
import type { Pool } from "pg";
import type { GrowthDraftProposal, GrowthAgentReview } from "@kasitek-labs/contracts";
import type { GrowthProductRuntime } from "../../adapters/products/growth-runtime";
import type { TaskOutcome } from "../../contracts/execution";
import { PlatformError,terminalTaskStates } from "../../contracts/contracts";
import { event } from "../lifecycle/execution";
export async function awaitGrowthReview(ctx:restate.WorkflowContext,pool:Pool,runtime:GrowthProductRuntime,taskId:string,operationId:string,draft:GrowthDraftProposal):
  Promise<{review:GrowthAgentReview}|{outcome:TaskOutcome}> {
  const prepared=await ctx.run("growth-prepare:"+operationId,async()=>{
    try {await runtime.authorizeTask(taskId);const value=await runtime.call(taskId,operationId+":prepare","draft.prepare",{draft});
      await runtime.project(value.review,taskId);return {review:value.review};}
    catch(error){if(error instanceof PlatformError)return {code:error.code};throw error;}
  });
  if("code" in prepared)return {outcome:{state:"failed",errorCode:prepared.code}};
  let review=prepared.review;
  for(let attempt=0;attempt<64;attempt++) {
    const current=await ctx.run("growth-review:"+operationId+":"+attempt,async()=>{
      try {
        const task=(await pool.query("SELECT state,control_generation,deadline_at FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];
        if(!task||task.state==="cancel_requested")return {outcome:{state:"cancelled" as const}};
        if(terminalTaskStates.has(task.state))return {outcome:{state:task.state as TaskOutcome["state"]}};
        const result=await runtime.review(taskId,operationId+":review:"+attempt,review.id),latest=result.review;
        if(latest.state==="approved"||latest.state==="saved") {
          await pool.query("UPDATE agents_platform.tasks SET state='running',updated_at=now() WHERE id=$1 AND state='waiting_review'",[taskId]);
          return {review:latest,approved:true as const};
        }
        if(latest.state!=="proposed"||new Date(latest.expiresAt).getTime()<=Date.now())return {outcome:{state:"incomplete" as const,errorCode:"GROWTH_REVIEW_"+latest.state.toUpperCase()}};
        await pool.query("UPDATE agents_platform.tasks SET state='waiting_review',updated_at=now() WHERE id=$1 AND state='running'",[taskId]);
        await event(pool,taskId,"growth-review:"+latest.id,"review.required",{reviewId:latest.id,kind:"growth",expiresAt:latest.expiresAt});
        return {review:latest,generation:task.control_generation,deadline:Math.min(new Date(task.deadline_at).getTime(),new Date(latest.expiresAt).getTime())};
      }catch(error){if(error instanceof PlatformError)return {outcome:{state:"incomplete" as const,errorCode:error.code}};throw error;}
    });
    if("outcome" in current && current.outcome)return {outcome:current.outcome};
    review=current.review;
    if(current.approved)return {review};
    await restate.RestatePromise.race([ctx.promise("review:"+current.generation).get(),ctx.sleep(Math.max(1,current.deadline!-await ctx.date.now()))]);
  }
  return {outcome:{state:"incomplete",errorCode:"GROWTH_REVIEW_WAIT_LIMIT"}};
}
