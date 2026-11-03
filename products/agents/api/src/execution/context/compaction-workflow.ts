import * as restate from "@restatedev/restate-sdk";
import type { Pool } from "pg";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { CONTEXT_COMPACTION_WORKFLOW, SHARED_HARNESS_RELEASE } from "../../contracts/execution";
import { requestDigest as modelRequestDigest, ModelOperationError, validateMessageGroups, type ModelRequest } from "../business/model";
import { operation, uncertainOperation } from "../lifecycle/durable-operation";
import { event, loadExecution } from "../lifecycle/execution";
import { assertCurrentAuthority } from "./evidence-policy";
import { invokeObservedTaskModel } from "../models/observed-invocation";
import type { TaskModelInvocation, ModelRuntimeDependencies } from "../models/runtime";
import type { ProductRuntimePort } from "../products/product-runtime";
import type { EvidenceStore } from "./evidence";
import type { ContextGroup } from "./context";
import { adoptCompactionCheckpoint, failCompactionJob, readCompactionJobOutcome, type CompactionJobOutcome } from "./checkpoints";

export { CONTEXT_COMPACTION_WORKFLOW } from "../../contracts/execution";
export interface ContextCompactionOptions {
  modelProvider:TaskModelInvocation["providerStore"];modelRuntime?:ModelRuntimeDependencies;
  evidence:EvidenceStore;product?:Pick<ProductRuntimePort,"authorizeTask"|"prepareExecution">;signal?:AbortSignal;
}
const invalid=()=>new PlatformError("COMPACTION_SNAPSHOT_INVALID",409,"The frozen compaction context is unavailable");

async function frozenJob(pool:Pool,jobId:string,taskId:string) {
  const execution=await loadExecution(pool,taskId);
  await assertCurrentAuthority(pool,execution);
  if(execution.task.harness_release!==SHARED_HARNESS_RELEASE)throw invalid();
  const job=(await pool.query("SELECT * FROM agents_platform.context_compaction_jobs WHERE id=$1 AND task_id=$2 AND mode='background'",[jobId,taskId])).rows[0];
  if(!job?.snapshot_id)throw invalid();
  const snapshot=(await pool.query("SELECT digest,payload,memory_scope_id,memory_generation FROM agents_platform.context_snapshots WHERE id=$1 AND task_id=$2",[job.snapshot_id,taskId])).rows[0];
  if(!snapshot||!Array.isArray(snapshot.payload.messages)||!Number.isSafeInteger(snapshot.payload.estimatedTokens)||snapshot.payload.estimatedTokens<0)throw invalid();
  const policy=execution.models.compaction.policy;
  const request:ModelRequest={messages:snapshot.payload.messages,model:execution.models.compaction.binding.modelId,
    maxInputTokens:policy.maxInputTokens,maxOutputTokens:policy.maxOutputTokens,maxDurationSeconds:policy.maxCallDurationMs/1000};
  validateMessageGroups(request.messages);
  if(snapshot.digest!==modelRequestDigest(request))throw invalid();
  for(const group of job.source_groups as (ContextGroup&{digest:string})[]) {
    if(group.digest!==requestDigest(group.messages)||!request.messages.some(message=>{
      if(message.role!=="user"||!message.content)return false;
      try{const records=JSON.parse(message.content);return records.groupId===group.id&&requestDigest(records.records)===group.digest;}
      catch{return false;}
    }))throw invalid();
  }
  return {execution,job,request,estimatedTokens:snapshot.payload.estimatedTokens as number,primaryReserve:snapshot.payload.primaryReserve,
    ...(snapshot.memory_scope_id?{memoryFence:{id:snapshot.memory_scope_id,generation:Number(snapshot.memory_generation),
      ...(snapshot.payload.memoryExpiresAt===undefined?{}:{expiresAt:snapshot.payload.memoryExpiresAt})}}:{})};
}

/** Runs one immutable prefix through the existing model, capacity, receipt and CAS boundaries. */
export function createContextCompactionWorkflow(pool:Pool,options:ContextCompactionOptions) {
  return restate.workflow({name:CONTEXT_COMPACTION_WORKFLOW,handlers:{
    run:async(ctx:restate.WorkflowContext,input:{jobId:string;taskId:string}):Promise<CompactionJobOutcome>=>{
      if(ctx.key!==input.jobId||typeof input.taskId!=="string")throw new restate.TerminalError("Compaction identity mismatch",{errorCode:400});
      await options.product?.prepareExecution?.(input.taskId);
      try {
        const initial=await ctx.run("compaction-state",()=>readCompactionJobOutcome(pool,input.jobId,input.taskId));
        if(initial.state!=="pending")return initial;
        const frozen=await ctx.run("frozen-compaction-context",()=>frozenJob(pool,input.jobId,input.taskId));
        const policy=frozen.execution.models.compaction.policy;
        const reservedTokens=Math.min(policy.maxInputTokens,frozen.estimatedTokens+policy.safetyTokens)+policy.maxOutputTokens;
        const generated=await operation(ctx,pool,input.taskId,{id:input.jobId,kind:"compaction",name:"context.compact",workload:"background",
          request:frozen.request,reservedTokens,reservedMs:policy.maxCallDurationMs,primaryReserve:frozen.primaryReserve,
          memoryFence:frozen.memoryFence,evidenceManifest:frozen.job.source_manifest??undefined},async()=>{
          if(frozen.execution.task.product!=="agents"||frozen.execution.configuration.productBindings.length) {
            if(!options.product)throw new PlatformError("PRODUCT_RUNTIME_UNAVAILABLE",503,"Product execution is unavailable");
            await options.product.authorizeTask(input.taskId);
          }
          const value=await invokeObservedTaskModel({pool,providerStore:options.modelProvider,execution:frozen.execution,operationId:input.jobId,
            role:"compaction",contextSnapshotId:frozen.job.snapshot_id,messages:frozen.request.messages,maxRequestBytes:policy.maxRequestBytes,
            signal:options.signal?AbortSignal.any([options.signal,ctx.request().attemptCompletedSignal]):ctx.request().attemptCompletedSignal},options.modelRuntime);
          const observed=value.usage.observed===true&&Number.isSafeInteger(value.usage.inputTokens)&&Number.isSafeInteger(value.usage.outputTokens);
          return {value,tokens:observed?value.usage.inputTokens!+value.usage.outputTokens!:reservedTokens};
        });
        if(!generated.ok)await ctx.run("compaction-failed",()=>failCompactionJob(pool,input.jobId,input.taskId,generated.uncertain?"uncertain":"failed",generated.code));
        else if(generated.value.contextDisposition==="quarantined"||generated.value.finishReason!=="stop"||!generated.value.message.content)
          await ctx.run("compaction-rejected",()=>failCompactionJob(pool,input.jobId,input.taskId,"rejected",generated.value.guardCode??"COMPACTION_INVALID"));
        else {
          await ctx.run("compaction-summary-evidence",()=>options.evidence.deriveSummaryFromSnapshot(input.taskId,input.jobId,frozen.job.snapshot_id));
          await ctx.run("compaction-adopt",()=>adoptCompactionCheckpoint(pool,{jobId:input.jobId,taskId:input.taskId,
            summary:generated.value.message.content!,finishReason:generated.value.finishReason}));
        }
      } catch(error) {
        if(error instanceof restate.CancelledError) {await ctx.run("compaction-cancelled",()=>failCompactionJob(pool,input.jobId,input.taskId,"failed","TASK_CANCELLED"));throw error;}
        if(!(error instanceof PlatformError)&&!(error instanceof ModelOperationError))throw error;
        await ctx.run("compaction-failed-before-adoption",()=>failCompactionJob(pool,input.jobId,input.taskId,uncertainOperation(error)?"uncertain":"failed",error.code));
      }
      const outcome=await ctx.run("compaction-outcome",()=>readCompactionJobOutcome(pool,input.jobId,input.taskId));
      await ctx.run("compaction-event",()=>event(pool,input.taskId,`background:${input.jobId}`,outcome.state==="adopted"?"context.compacted":"context.compaction_settled",
        {mode:"background",state:outcome.state,count:outcome.compactedGroupIds.length,
          outcome:outcome.state==="adopted"||outcome.state==="superseded"?"completed":outcome.state==="uncertain"?"uncertain":"failed",
          ...(outcome.code?{errorCode:outcome.code}:{})}));
      return outcome;
    },
    capacity:async(ctx:restate.WorkflowSharedContext,input:{requestId:string;generation:number})=>{
      if(input.requestId!==ctx.key||!Number.isSafeInteger(input.generation)||input.generation<1)throw new restate.TerminalError("Invalid compaction capacity control",{errorCode:409});
      const allowed=await ctx.run("verify-compaction-capacity",async()=>Boolean((await pool.query(`SELECT 1 FROM agents_platform.capacity_notifications n
        JOIN agents_platform.capacity_requests q ON q.id=n.request_id AND q.task_id=n.task_id
        JOIN agents_platform.context_compaction_jobs j ON j.id=q.id AND j.task_id=q.task_id AND j.mode='background'
        WHERE n.request_id=$1 AND n.generation=$2`,[input.requestId,input.generation])).rowCount));
      if(!allowed)throw new restate.TerminalError("Compaction capacity control unavailable",{errorCode:409});
      await ctx.promise(`capacity:${input.requestId}:${input.generation}`).resolve(true);return{accepted:true};
    },
  }});
}
export type ContextCompactionWorkflow=ReturnType<typeof createContextCompactionWorkflow>;
