import * as restate from "@restatedev/restate-sdk";
import type {Pool} from "pg";
import {EnquiryStore} from "../../capabilities/enquiries/enquiries";
import {PlatformError,terminalTaskStates} from "../../contracts/contracts";
import type {TaskOutcome} from "../../contracts/execution";
import {event} from "../lifecycle/execution";

export async function awaitEnquiryConfirmation(ctx:restate.WorkflowContext,pool:Pool,taskId:string,operationId:string,args:unknown):Promise<TaskOutcome|undefined>{
 const enquiries=new EnquiryStore(pool);
 for(let check=0;check<64;check++){
  const status=await ctx.run(`enquiry-confirmation:${operationId}:${check}`,async()=>{
   try{
    const task=(await pool.query("SELECT state,control_generation,deadline_at FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];
    if(!task)throw new PlatformError("TASK_NOT_FOUND",404,"Task not found");
    if(task.state==="cancel_requested")return {outcome:{state:"cancelled"} as TaskOutcome};
    if(terminalTaskStates.has(task.state))return {outcome:{state:task.state} as TaskOutcome};
    const enquiry=await enquiries.prepare(taskId,operationId,args);
    if(["approved","submitted"].includes(enquiry.state)){await pool.query("UPDATE agents_platform.tasks SET state='running',updated_at=now() WHERE id=$1 AND state='waiting_review'",[taskId]);return {approved:true};}
    if(enquiry.state!=="pending")return {outcome:{state:"incomplete",errorCode:`ENQUIRY_${enquiry.state.toUpperCase()}`} as TaskOutcome};
    const deadline=Math.min(Date.parse(enquiry.expiresAt),new Date(task.deadline_at).getTime());
    if(deadline<=Date.now())return {outcome:{state:"incomplete",errorCode:"ENQUIRY_CONFIRMATION_EXPIRED"} as TaskOutcome};
    await pool.query("UPDATE agents_platform.tasks SET state='waiting_review',updated_at=now() WHERE id=$1 AND state='running'",[taskId]);
    await event(pool,taskId,`enquiry-confirmation:${enquiry.id}`,"review.enquiry_required",{enquiryId:enquiry.id,expiresAt:enquiry.expiresAt});
    return {generation:task.control_generation,deadline};
   }catch(error){if(error instanceof PlatformError)return {outcome:{state:"incomplete",errorCode:error.code} as TaskOutcome};throw error;}
  });
  if(status.outcome)return status.outcome;if(status.approved)return;
  await restate.RestatePromise.race([ctx.promise(`review:${status.generation}`).get(),ctx.sleep(Math.max(1,status.deadline!-await ctx.date.now()))]);
 }
 return {state:"incomplete",errorCode:"ENQUIRY_CONFIRMATION_WAIT_LIMIT"};
}
