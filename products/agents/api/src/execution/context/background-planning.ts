import type {Pool} from "pg";
import type {Execution,MemoryFence} from "../../contracts/execution";
import {requestDigest as modelRequestDigest,type ModelRequest} from "../business/model";
import {prepareCompaction,type ContextGroup,type ContextModelPolicy} from "./context";
import {prepareCompactionJob,type ContinuityCheckpoint} from "../lifecycle/checkpoints";
import type {EvidenceStore} from "./evidence";
import {PlatformError,requestDigest} from "../../contracts/contracts";

/** Freeze complete eligible groups before sending a background job; later tail appends are separate. */
export async function planBackgroundCompaction(pool:Pool,input:{execution:Execution;step:number;history:ContextGroup[];working:ContextGroup[];
  previous?:ContinuityCheckpoint;memoryFence?:MemoryFence;modelPolicy:ContextModelPolicy;evidence:EvidenceStore}){
  const {execution,step,evidence}=input,taskId=execution.task.id;
  const groups=[...input.history,...input.working].filter(group=>!group.id.startsWith("instruction:"));
  if(groups.length<3)return undefined;
  const policy=execution.models.compaction.policy;
  const primary=(await pool.query("SELECT payload FROM agents_platform.context_snapshots WHERE id=$1 AND task_id=$2",[`context:${taskId}:${step}`,taskId])).rows[0];
  if(!primary||!Number.isSafeInteger(primary.payload.estimatedTokens)||primary.payload.estimatedTokens<0)
    throw new PlatformError("CONTEXT_SNAPSHOT_UNAVAILABLE",409,"The prepared foreground context is unavailable");
  const primaryPolicy=execution.models.primary.policy;
  const primaryReserve={tokens:Math.min(primaryPolicy.maxInputTokens,primary.payload.estimatedTokens+primaryPolicy.safetyTokens)+primaryPolicy.maxOutputTokens,
    activeMs:primaryPolicy.maxCallDurationMs};
  const plan=prepareCompaction(groups,{model:execution.models.compaction.binding.modelId,modelPolicy:input.modelPolicy,
    retainRecentTokens:15_000,maxInputTokens:policy.maxInputTokens,maxOutputTokens:policy.maxOutputTokens,previousSummary:input.previous?.summary});
  const prefix=groups.filter(group=>plan.compactedGroupIds.includes(group.id));
  const previous=(await pool.query("SELECT id,source_groups FROM agents_platform.context_compaction_jobs WHERE task_id=$1 AND mode='background' ORDER BY created_at DESC LIMIT 1",[taskId])).rows[0];
  // A threshold oscillation cannot compact the same prefix again; new eligible groups rearm it.
  if(previous&&previous.id!==`background:${taskId}:${step}`&&requestDigest(previous.source_groups.map(({id,messages}:ContextGroup)=>({id,messages})))===requestDigest(prefix.map(({id,messages})=>({id,messages}))))return undefined;
  const request:ModelRequest={messages:plan.messages,model:execution.models.compaction.binding.modelId,maxDurationSeconds:policy.maxCallDurationMs/1000,
    maxInputTokens:policy.maxInputTokens,maxOutputTokens:policy.maxOutputTokens};
  const snapshotId=`context:background:${taskId}:${step}`;
  const historyIds=plan.compactedGroupIds.filter(id=>input.history.some(group=>group.id===id)&&/^[a-f0-9-]{36}$/.test(id));
  await pool.query(`INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,source_references,memory_scope_id,memory_generation,history_cutoff)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,[snapshotId,taskId,-step-1,modelRequestDigest(request),
    {messages:request.messages,estimatedTokens:plan.estimatedTokens,historyGroupIds:historyIds,memoryExpiresAt:input.memoryFence?.expiresAt,primaryReserve},
    JSON.stringify(plan.compactedGroupIds.map(id=>({id,revision:1,kind:"result"}))),input.memoryFence?.id??null,input.memoryFence?.generation??null,execution.task.history_cutoff??"0"]);
  await evidence.inheritHistory(taskId,snapshotId,historyIds);
  await evidence.supplyContext(taskId,snapshotId,prefix.flatMap(group=>group.evidenceIds??[]));
  return prepareCompactionJob(pool,{id:`background:${taskId}:${step}`,taskId,mode:"background",snapshotId,
    groups:prefix,inputDigest:plan.inputDigest,historyIds,previous:input.previous,manifest:await evidence.taskManifest(taskId),memoryFence:input.memoryFence});
}
