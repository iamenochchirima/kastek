import { deadlineMillis } from "../lifecycle/deadline";
import * as restate from "@restatedev/restate-sdk";
import type { Pool } from "pg";
import type { CapabilityBinding } from "../../contracts/capability-catalog";
import { PlatformError, terminalTaskStates } from "../../contracts/contracts";
import type { TaskOutcome } from "../../contracts/execution";
import { ToolReviewStore } from "../../capabilities/reviews/tool-reviews";
import { event } from "../lifecycle/execution";

/** Human wait precedes physical-operation admission, so it holds no provider execution slot. */
export async function awaitToolInvocationReview(ctx:restate.WorkflowContext,pool:Pool,reviews:ToolReviewStore,
  taskId:string,operationId:string,binding:CapabilityBinding,args:unknown):Promise<TaskOutcome|undefined> {
  for(let check=0;check<64;check++) {
    const status=await ctx.run(`tool-review:${operationId}:${check}`,async()=>{
      try {
        const task=(await pool.query("SELECT state,control_generation,deadline_at FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];
        if(!task)throw new PlatformError("TASK_NOT_FOUND",404,"Task not found");
        if(task.state==="cancel_requested")return {cancelled:true};
        if(terminalTaskStates.has(task.state))return {settled:task.state as TaskOutcome["state"]};
        const review=await reviews.prepare(taskId,operationId,binding,args);
        if(review.state==="approved") {
          await pool.query("UPDATE agents_platform.tasks SET state='running',updated_at=now() WHERE id=$1 AND state='waiting_review'",[taskId]);
          return {approved:true};
        }
        if(review.state!=="pending")return {denied:`TOOL_REVIEW_${review.state.toUpperCase()}`};
        if(new Date(review.expiresAt).getTime()<=Date.now()) {
          await pool.query("UPDATE agents_platform.tool_invocation_reviews SET state='expired' WHERE id=$1 AND state='pending'",[review.id]);
          return {denied:"TOOL_REVIEW_EXPIRED"};
        }
        await pool.query("UPDATE agents_platform.tasks SET state='waiting_review',updated_at=now() WHERE id=$1 AND state='running'",[taskId]);
        await event(pool,taskId,`tool-review:${review.id}`,"review.required",{reviewId:review.id,kind:"tool",expiresAt:review.expiresAt});
        return {generation:task.control_generation,deadline:Math.min(deadlineMillis(task.deadline_at),new Date(review.expiresAt).getTime())};
      }catch(error){if(error instanceof PlatformError)return {denied:error.code};throw error;}
    });
    if(status.cancelled)return {state:"cancelled"};
    if(status.settled)return {state:status.settled};
    if(status.denied)return {state:"incomplete",errorCode:status.denied};
    if(status.approved)return;
    await restate.RestatePromise.race([ctx.promise(`review:${status.generation}`).get(),ctx.sleep(Math.max(1,status.deadline!-await ctx.date.now()))]);
  }
  return {state:"incomplete",errorCode:"TOOL_REVIEW_WAIT_LIMIT"};
}
