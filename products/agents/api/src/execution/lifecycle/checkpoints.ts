import type { Pool, PoolClient } from "pg";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import type { DependencyManifest } from "../../contracts/source-contracts";
import type { MemoryFence } from "../../contracts/execution";
import { transaction } from "../../infrastructure/database";
import { assertCurrentAuthority, assertCurrentEvidence } from "../context/evidence-policy";
import { loadExecution } from "./state";
import type { EvidenceStore } from "../context/evidence";
import type { ContextGroup, ContextSource } from "../context/context";
import { validateMessageGroups } from "../business/model";
import { releaseCapacity } from "../scheduling/capacity";
import { recordEvent } from "../../observability/event-store";

export interface ContinuityCheckpoint {
  id: string; revision: number; taskId: string; summary: ContextSource; coveredHistoryIds: string[];
}
export interface CompactionJobInput {
  id: string; taskId: string; groups: ContextGroup[]; inputDigest: string;
  mode?:"foreground"|"background";snapshotId?:string;
  historyIds: string[]; previous?: ContinuityCheckpoint; manifest?: DependencyManifest; memoryFence?: MemoryFence;
}
export type CompactionJobOutcome={jobId:string;taskId:string;state:"pending"|"adopted"|"superseded"|"rejected"|"failed"|"uncertain";
  compactedGroupIds:string[];checkpoint?:ContinuityCheckpoint;code?:string};

export async function readCompactionJobOutcome(pool:Pool,jobId:string,taskId:string):Promise<CompactionJobOutcome> {
  const row=(await pool.query("SELECT * FROM agents_platform.context_compaction_jobs WHERE id=$1 AND task_id=$2",[jobId,taskId])).rows[0];
  if(!row)throw new PlatformError("COMPACTION_JOB_UNAVAILABLE",409,"The compaction job is unavailable");
  const result:CompactionJobOutcome={jobId:row.id,taskId:row.task_id,state:row.state==="prepared"?"pending":row.state,
    compactedGroupIds:row.source_groups.map((group:ContextGroup)=>group.id),...(row.error_code?{code:row.error_code}:{})};
  if(row.state!=="adopted")return result;
  const checkpoint=(await pool.query("SELECT c.*,h.revision AS head_revision FROM agents_platform.context_continuity_checkpoints c JOIN agents_platform.context_continuity_heads h ON h.conversation_id=c.conversation_id WHERE c.id=$1",[row.checkpoint_id])).rows[0];
  if(!checkpoint || requestDigest(checkpoint.summary)!==checkpoint.summary_digest)throw new PlatformError("CONTEXT_CHECKPOINT_INTEGRITY",409,"The continuity checkpoint is unavailable");
  if(Number(checkpoint.head_revision)>Number(checkpoint.revision))return {...result,state:"superseded"};
  await transaction(pool,async db=>{
    await assertCurrentAuthority(db,await loadExecution(db,taskId));
    if(!await memoryCurrent(db,checkpoint.memory_scope_id,checkpoint.memory_generation))throw new PlatformError("CONTEXT_INVALIDATED",409,"The selected memory changed");
    if(checkpoint.source_manifest)await assertCurrentEvidence(db,taskId,checkpoint.source_manifest);
  });
  return {...result,checkpoint:{id:checkpoint.id,revision:Number(checkpoint.revision),taskId,
    summary:{id:checkpoint.id,revision:Number(checkpoint.revision),kind:"summary",content:checkpoint.summary},coveredHistoryIds:checkpoint.covered_history_ids}};
}

export async function failCompactionJob(pool:Pool,jobId:string,taskId:string,state:"failed"|"uncertain"|"rejected",code:string):Promise<void> {
  if(!/^[A-Z][A-Z0-9_]{0,127}$/.test(code))code="COMPACTION_FAILED";
  await pool.query("UPDATE agents_platform.context_compaction_jobs SET state=$3,error_code=$4,settled_at=now() WHERE id=$1 AND task_id=$2 AND state='prepared'",[jobId,taskId,state,code]);
}

/** Foreground recovery may replace queued optional work, never an admitted physical attempt. */
export async function retireQueuedBackgroundCompaction(pool:Pool,taskId:string,jobId:string):Promise<boolean> {
  return transaction(pool,async db=>{
    const initial=await loadExecution(db,taskId);
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[initial.task.organization_id]);
    const execution=await loadExecution(db,taskId,true);await assertCurrentAuthority(db,execution);
    const job=(await db.query("SELECT state FROM agents_platform.context_compaction_jobs WHERE id=$1 AND task_id=$2 AND mode='background' FOR UPDATE",[jobId,taskId])).rows[0];
    if(job?.state!=="prepared")return false;
    if((await db.query("SELECT 1 FROM agents_platform.operations WHERE id=$1 AND task_id=$2",[jobId,taskId])).rowCount)return false;
    const capacity=(await db.query("SELECT state,generation FROM agents_platform.capacity_requests WHERE id=$1 AND task_id=$2 FOR UPDATE",[jobId,taskId])).rows[0];
    if(capacity&&["active","uncertain"].includes(capacity.state))return false;
    await db.query("UPDATE agents_platform.context_compaction_jobs SET state='failed',error_code='COMPACTION_FOREGROUND_REQUIRED',settled_at=now() WHERE id=$1",[jobId]);
    if(capacity){
      if(["waiting","granted"].includes(capacity.state))await releaseCapacity(db,jobId,"failed");
      await db.query("INSERT INTO agents_platform.capacity_notifications(request_id,generation,task_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[jobId,capacity.generation,taskId]);
    }
    await recordEvent(db,taskId,`foreground-required:${jobId}`,"context.compaction_settled",{mode:"background",state:"failed",outcome:"failed",errorCode:"COMPACTION_FOREGROUND_REQUIRED"});
    return true;
  });
}

async function memoryCurrent(db: PoolClient, id: string | null, generation: string | number | null) {
  if (!id) return true;
  const row = (await db.query("SELECT generation,next_expiry_at FROM agents_platform.memory_scopes WHERE id=$1", [id])).rows[0];
  return Boolean(row && Number(row.generation) === Number(generation) && (!row.next_expiry_at || new Date(row.next_expiry_at).getTime() > Date.now()));
}

/** A portable checkpoint never replaces the retained task, instruction or operation records. */
export async function loadContinuityCheckpoint(pool: Pool, taskId: string, evidence: EvidenceStore): Promise<ContinuityCheckpoint | undefined> {
  const current = await loadExecution(pool, taskId);
  if (current.task.channel_binding) return undefined;
  const row = (await pool.query(`SELECT c.* FROM agents_platform.context_continuity_heads h
    JOIN agents_platform.context_continuity_checkpoints c ON c.id=h.checkpoint_id
    JOIN agents_platform.tasks t ON t.id=c.task_id
    WHERE h.conversation_id=$1 AND c.organization_id=$2 AND t.product=$3 AND t.principal=$4::jsonb
      AND t.resource_id=$5 AND t.caller_client_id=$6 AND t.turn_sequence<=$7`, [current.task.conversation_id, current.task.organization_id,
    current.task.product, JSON.stringify(current.task.principal), current.task.resource_id, current.task.caller_client_id, current.task.turn_sequence])).rows[0];
  if (!row) return undefined;
  if (requestDigest(row.summary) !== row.summary_digest) throw new PlatformError("CONTEXT_CHECKPOINT_INTEGRITY", 409, "The continuity checkpoint is unavailable");
  try {
    await transaction(pool, async db => {
      await assertCurrentAuthority(db, await loadExecution(db, taskId));
      if (!await memoryCurrent(db, row.memory_scope_id, row.memory_generation)) throw new PlatformError("CONTEXT_INVALIDATED", 409, "Memory changed");
      if (row.source_manifest) await assertCurrentEvidence(db, taskId, row.source_manifest, { historyOriginTaskIds: row.task_id === taskId ? [] : [row.task_id] });
    });
    const origins = [...new Set([...row.covered_history_ids, ...(row.task_id === taskId ? [] : [row.task_id])])];
    for (let offset = 0; offset < origins.length; offset += 64) {
      if ((await evidence.checkHistory(taskId, origins.slice(offset, offset + 64))).some(result => !result.eligible)) return undefined;
    }
    await evidence.inheritCheckpoint(taskId,row.id);
  } catch (error) {
    if (error instanceof PlatformError && /EVIDENCE|CONTEXT_INVALIDATED|MEMORY|SCOPE|GRANT_CAPABILITY/.test(error.code)) return undefined;
    throw error;
  }
  return { id: row.id, revision: Number(row.revision), taskId: row.task_id,
    summary: { id: row.id, revision: Number(row.revision), kind: "summary", content: row.summary }, coveredHistoryIds: row.covered_history_ids };
}

/** Freeze exact complete groups before generating. Retrying the job cannot change its prefix. */
export async function prepareCompactionJob(pool: Pool, input: CompactionJobInput): Promise<{ id: string; taskId:string; baseRevision: number }> {
  return transaction(pool, async db => {
    const execution = await loadExecution(db, input.taskId);
    await assertCurrentAuthority(db, execution);
    if (!input.groups.length || new Set(input.groups.map(group => group.id)).size !== input.groups.length) throw new PlatformError("COMPACTION_PLAN_INVALID", 400, "The compaction prefix is invalid");
    for(const group of input.groups)validateMessageGroups(group.messages);
    if(input.historyIds.some(id=>!input.groups.some(group=>group.id===id)))throw new PlatformError("COMPACTION_COVERAGE_INVALID",409,"The history coverage does not match the frozen prefix");
    if(input.historyIds.length){
      const covered=await db.query(`SELECT id FROM agents_platform.tasks WHERE id=ANY($1::uuid[]) AND conversation_id=$2
        AND organization_id=$3 AND product=$4 AND principal=$5::jsonb AND turn_sequence<$6`,[input.historyIds,
        execution.task.conversation_id,execution.task.organization_id,execution.task.product,JSON.stringify(execution.task.principal),execution.task.turn_sequence]);
      if(covered.rowCount!==new Set(input.historyIds).size)throw new PlatformError("COMPACTION_COVERAGE_INVALID",409,"The frozen prefix is outside this conversation");
    }
    if (input.manifest) await assertCurrentEvidence(db, input.taskId, input.manifest);
    await db.query("INSERT INTO agents_platform.context_continuity_heads(conversation_id) VALUES($1) ON CONFLICT DO NOTHING", [execution.task.conversation_id]);
    const head = (await db.query("SELECT revision FROM agents_platform.context_continuity_heads WHERE conversation_id=$1 FOR UPDATE", [execution.task.conversation_id])).rows[0];
    if(input.mode==="background") {
      if(!input.snapshotId || !(await db.query("SELECT 1 FROM agents_platform.context_snapshots WHERE id=$1 AND task_id=$2",[input.snapshotId,input.taskId])).rowCount)
        throw new PlatformError("CONTEXT_SNAPSHOT_UNAVAILABLE",409,"The frozen compaction context is unavailable");
      const pending=(await db.query("SELECT id,task_id,base_revision FROM agents_platform.context_compaction_jobs WHERE conversation_id=$1 AND mode='background' AND state='prepared' FOR UPDATE",[execution.task.conversation_id])).rows[0];
      if(pending&&pending.id!==input.id) {
        const origin=(await db.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[pending.task_id])).rows[0];
        if(origin&&!["completed","incomplete","failed","cancelled","uncertain","refused"].includes(origin.state))return{id:pending.id,taskId:pending.task_id,baseRevision:Number(pending.base_revision)};
        const physical=(await db.query("SELECT state FROM agents_platform.operations WHERE id=$1 AND task_id=$2",[pending.id,pending.task_id])).rows[0];
        const uncertain=physical&&["started","uncertain"].includes(physical.state);
        await db.query("UPDATE agents_platform.context_compaction_jobs SET state=$2,error_code='TASK_SETTLED',settled_at=now() WHERE id=$1",[pending.id,uncertain?"uncertain":"failed"]);
      }
    }
    const previousCoverage = input.previous?.coveredHistoryIds ?? [];
    const historyIds = [...new Set([...previousCoverage, ...input.historyIds])];
    const sources = input.groups.map(group => ({ ...group, digest: requestDigest(group.messages) }));
    const inserted = (await db.query(`INSERT INTO agents_platform.context_compaction_jobs
      (id,organization_id,conversation_id,task_id,base_revision,input_digest,source_groups,covered_history_ids,source_manifest,memory_scope_id,memory_generation,mode,snapshot_id,previous_summary)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO NOTHING RETURNING *`,
    [input.id, execution.task.organization_id, execution.task.conversation_id, input.taskId, input.previous?.revision ?? Number(head.revision),
      input.inputDigest, JSON.stringify(sources), historyIds, input.manifest ?? null, input.memoryFence?.id ?? null, input.memoryFence?.generation ?? null,
      input.mode??"foreground",input.snapshotId??null,input.previous?.summary.content??null])).rows[0];
    const row = inserted ?? (await db.query("SELECT * FROM agents_platform.context_compaction_jobs WHERE id=$1", [input.id])).rows[0];
    if (row.task_id !== input.taskId || row.input_digest !== input.inputDigest || requestDigest(row.source_groups) !== requestDigest(sources) ||
      row.mode!==(input.mode??"foreground") || row.snapshot_id!==(input.snapshotId??null) || row.previous_summary!==(input.previous?.summary.content??null)) throw new PlatformError("COMPACTION_JOB_CONFLICT", 409, "The compaction job changed");
    return { id: row.id, taskId:row.task_id, baseRevision: Number(row.base_revision) };
  });
}

export async function adoptCompactionCheckpoint(pool: Pool, input: { jobId: string; taskId: string; summary: string; finishReason: string; previousSummary?: string }): Promise<ContinuityCheckpoint | undefined> {
  return transaction(pool, async db => {
    const execution = await loadExecution(db, input.taskId);
    await assertCurrentAuthority(db, execution);
    const row = (await db.query("SELECT * FROM agents_platform.context_compaction_jobs WHERE id=$1 AND task_id=$2 FOR UPDATE", [input.jobId, input.taskId])).rows[0];
    if (!row) throw new PlatformError("COMPACTION_JOB_UNAVAILABLE", 409, "The compaction job is unavailable");
    if (row.state === "adopted") {
      if (row.candidate_digest !== requestDigest(input.summary)) throw new PlatformError("COMPACTION_JOB_CONFLICT", 409, "The compaction candidate changed");
      return { id: row.id, revision: Number(row.base_revision) + 1, taskId: row.task_id, summary: { id: row.id, revision: Number(row.base_revision) + 1, kind: "summary", content: row.candidate }, coveredHistoryIds: row.covered_history_ids };
    }
    if (row.state !== "prepared") return undefined;
    const inputBytes = Buffer.byteLength(JSON.stringify(row.source_groups.map((group: ContextGroup) => group.messages))) + Buffer.byteLength(row.previous_summary??input.previousSummary ?? "");
    if (input.finishReason !== "stop" || !input.summary.trim() || Buffer.byteLength(input.summary) >= inputBytes ||
      !await memoryCurrent(db, row.memory_scope_id, row.memory_generation)) {
      await db.query("UPDATE agents_platform.context_compaction_jobs SET state='rejected',settled_at=now() WHERE id=$1", [row.id]);
      return undefined;
    }
    if (row.source_manifest) await assertCurrentEvidence(db, input.taskId, row.source_manifest);
    const head = (await db.query("SELECT revision FROM agents_platform.context_continuity_heads WHERE conversation_id=$1 FOR UPDATE", [row.conversation_id])).rows[0];
    if (Number(head.revision) !== Number(row.base_revision)) {
      await db.query("UPDATE agents_platform.context_compaction_jobs SET state='superseded',settled_at=now() WHERE id=$1", [row.id]);
      return undefined;
    }
    const revision = Number(row.base_revision) + 1, digest = requestDigest(input.summary);
    await db.query(`INSERT INTO agents_platform.context_continuity_checkpoints
      (id,organization_id,conversation_id,task_id,revision,summary,summary_digest,covered_history_ids,source_manifest,memory_scope_id,memory_generation)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [row.id, row.organization_id, row.conversation_id, row.task_id, revision, input.summary, digest, row.covered_history_ids, row.source_manifest, row.memory_scope_id, row.memory_generation]);
    await db.query("UPDATE agents_platform.context_continuity_heads SET revision=$2,checkpoint_id=$3,updated_at=now() WHERE conversation_id=$1 AND revision=$4", [row.conversation_id, revision, row.id, row.base_revision]);
    await db.query("UPDATE agents_platform.context_compaction_jobs SET state='adopted',candidate=$2,candidate_digest=$3,checkpoint_id=$1,settled_at=now() WHERE id=$1", [row.id, input.summary, digest]);
    return { id: row.id, revision, taskId: row.task_id, summary: { id: row.id, revision, kind: "summary", content: input.summary }, coveredHistoryIds: row.covered_history_ids };
  });
}
