import { deadlineMillis } from "../../execution/lifecycle/deadline";
import * as restate from "@restatedev/restate-sdk";
import type { Pool } from "pg";
import { PlatformError } from "../../contracts/contracts";
import type { Execution, MemoryFence, OperationRequest, TaskOutcome } from "../../contracts/execution";
import { assertPublishedTools } from "../../capabilities/tool-definitions";
import { toolDescriptor } from "../../capabilities/tool-descriptors";
import { event, finishOperation } from "../../execution/lifecycle/execution";

export interface ActionState {id:string;state:"pending_review"|"approved"|"rejected"|"expired"|"invalidated"|"claimed"|"delivered"|"failed"|"uncertain";expiresAt:string;errorCode?:string|null}
export interface ActionRuntime {
  prepare(taskId:string,operationId:string,input:{connectionId:string;artifactId:string;title?:string}):Promise<ActionState>;
  getReview(taskId:string,reviewId:string):Promise<ActionState>;
  execute(taskId:string,actionId:string):Promise<ActionState>;
  reconcile(actionId:string):Promise<ActionState>;
}
export interface ReportWorkflowOptions {
  actions?: ActionRuntime;
  selectReportArtifact?: (taskId:string,name:string,generatedOutput:string)=>Promise<{id:string}>;
}
type Result<T> = {ok:true;value:T}|{ok:false;code:string;uncertain:boolean};
export interface ReportWorkflowPorts {
  awaitAuthority(ctx:restate.WorkflowContext,pool:Pool,taskId:string,label:string):Promise<Execution|TaskOutcome>;
  operation<T>(ctx:restate.WorkflowContext,pool:Pool,taskId:string,input:OperationRequest,perform:()=>Promise<{value:T;tokens:number}>,journalName?:string):Promise<Result<T>>;
  failed(result:{code:string;uncertain:boolean}):TaskOutcome;
}

function actionState(value:ActionState):ActionState {return{id:value.id,state:value.state,expiresAt:value.expiresAt,...(value.errorCode?{errorCode:value.errorCode}:{})};}

export async function runRequiredReport(ctx:restate.WorkflowContext,pool:Pool,taskId:string,options:ReportWorkflowOptions,outcome:TaskOutcome,memoryFence:MemoryFence|undefined,ports:ReportWorkflowPorts):Promise<TaskOutcome> {
  const { awaitAuthority, operation, failed } = ports;
  const execution=await awaitAuthority(ctx,pool,taskId,"report-authority");
  if(!("configuration" in execution))return execution;
  const profile=execution.configuration.capabilities.workflows;
  if(!profile.enabled)return outcome;
  assertPublishedTools(execution.configuration,execution.toolBindings);
  if(!options.actions||!options.selectReportArtifact)throw new PlatformError("REPORT_WORKFLOW_UNAVAILABLE",503,"Report delivery is unavailable");
  const actions=options.actions;
  const prepared=await operation<ActionState>(ctx,pool,taskId,{id:`report:${taskId}:prepare`,kind:"tool",name:"report.prepare",request:{profile},reservedTokens:0,reservedMs:60000,retrySafe:true,maxResultBytes:8192,memoryFence},async()=>{
    const artifact=await options.selectReportArtifact!(taskId,profile.reportArtifactName,outcome.output??"");
    return{value:actionState(await actions.prepare(taskId,`report:${taskId}:deliver`,{connectionId:profile.connectionId,artifactId:artifact.id,title:profile.title})),tokens:0};
  });
  if(!prepared.ok)return failed(prepared);
  let action=prepared.value;
  for(let check=0;check<64;check++) {
    const status=await ctx.run(`report-review:${check}`,async()=>{
      const task=(await pool.query("SELECT state,control_generation,deadline_at FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];
      if(!task)throw new PlatformError("TASK_NOT_FOUND",404,"Task not found");
      let fresh:ActionState;
      try{fresh=actionState(await actions.getReview(taskId,action.id));}catch(error){if(error instanceof PlatformError)return{denied:error.code};throw error;}
      if(fresh.state==="pending_review" && task.state!=="cancel_requested") {
        await pool.query("UPDATE agents_platform.tasks SET state='waiting_review',updated_at=now() WHERE id=$1 AND state='running'",[taskId]);
        await event(pool,taskId,`review:${fresh.id}`,"review.required",{reviewId:fresh.id,expiresAt:fresh.expiresAt});
      }
      return{action:fresh,state:task.state,generation:task.control_generation,deadline:Math.min(deadlineMillis(task.deadline_at),new Date(fresh.expiresAt).getTime())};
    });
    if(status.denied) return failed({code:status.denied,uncertain:false});
    action=status.action!;
    if(status.state==="cancel_requested")return {state:"cancelled"};
    if(action.state!=="pending_review")break;
    await restate.RestatePromise.race([ctx.promise(`review:${status.generation}`).get(),ctx.sleep(Math.max(1,status.deadline!-await ctx.date.now()))]);
  }
  if(action.state==="pending_review")return{state:"incomplete",errorCode:"REVIEW_WAIT_LIMIT"};
  if(["rejected","expired","invalidated","failed"].includes(action.state))return{state:"incomplete",errorCode:action.errorCode??`ACTION_${action.state.toUpperCase()}`};
  if(action.state==="delivered")return outcome;
  if(action.state==="approved") {
    const authorized=await awaitAuthority(ctx,pool,taskId,"report-claim-authority");
    if(!("configuration" in authorized))return authorized;
    const descriptor=toolDescriptor("report.deliver")!;
    await ctx.run("report-dispatch-stage",()=>pool.query("UPDATE agents_platform.tasks SET state='running',updated_at=now() WHERE id=$1 AND state='waiting_review'",[taskId]).then(()=>undefined));
    const delivered=await operation<ActionState>(ctx,pool,taskId,{id:`report:${taskId}:dispatch`,kind:"tool",name:"report.deliver",request:{actionId:action.id},reservedTokens:0,reservedMs:descriptor.maxDurationMs,retrySafe:true,maxResultBytes:descriptor.maxResultBytes},async()=>({value:actionState(await actions.execute(taskId,action.id)),tokens:0}));
    if(!delivered.ok) {
      const recorded=await ctx.run("report-postclaim-inspection",()=>actions.getReview(taskId,action.id).then(actionState));
      if(!["claimed","uncertain","delivered"].includes(recorded.state))return failed(delivered);
      action=recorded;
    } else action=delivered.value;
  }
  for(let attempt=0;attempt<3 && ["claimed","uncertain"].includes(action.state);attempt++) {
    await ctx.run(`report-reconcile-stage:${attempt}`,()=>pool.query("UPDATE agents_platform.tasks SET state='reconciling',updated_at=now() WHERE id=$1 AND state='running'",[taskId]).then(()=>undefined));
    await ctx.sleep(1000*(attempt+1));
    action=await ctx.run(`report-reconcile:${attempt}`,async()=>{try{return actionState(await actions.reconcile(action.id));}catch(error){if(error instanceof PlatformError)return{...action,state:"uncertain" as const,errorCode:error.code};throw error;}});
  }
  await ctx.run("report-operation-receipt",async()=>{
    const pending=(await pool.query("SELECT state FROM agents_platform.operations WHERE id=$1 AND task_id=$2",[`report:${taskId}:dispatch`,taskId])).rows[0];
    if(pending?.state==="started")await finishOperation(pool,taskId,`report:${taskId}:dispatch`,action.state==="delivered"?"completed":"uncertain",actionState(action),action.errorCode??null,0);
  });
  await ctx.run("report-outcome",()=>event(pool,taskId,`report:${action.id}:outcome`,"action.outcome",{actionId:action.id,state:action.state}));
  if(action.state==="delivered")return outcome;
  if(["claimed","uncertain"].includes(action.state))return{state:"uncertain",errorCode:action.errorCode??"ACTION_OUTCOME_UNCERTAIN"};
  return{state:"incomplete",errorCode:action.errorCode??`ACTION_${action.state.toUpperCase()}`};
}
