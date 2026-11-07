import { recordOrchestrationLifecycle } from "../../observability/orchestration-lifecycle";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { PlatformError, requestDigest, terminalTaskStates } from "../../contracts/contracts";
import { SHARED_HARNESS_RELEASE } from "../../contracts/execution";
import type { TaskOutcome } from "../../contracts/execution";
import { workRecordSchema, orchestrationContracts } from "../../contracts/orchestration";
import { assertCurrentAuthority, loadExecution, event, transaction } from "../lifecycle/execution";
import { instructionHead } from "../context/instruction-state";
import { continuationChildAllowed } from "../context/work-lineage";
import { fitUtf8 } from "../../capabilities/tools";

type Db = Pool | PoolClient;
export async function authorizeOrchestration(db: Db, taskId: string, tool?: string) {
  const execution = await loadExecution(db, taskId);
  const { task, configuration } = execution;
  const sharedSteering=!tool&&task.harness_release==="product-capabilities-v15"&&configuration.executionKind==="business";
  if (!sharedSteering && (configuration.program.id !== "tool-directed" || configuration.program.version !== "4" || !configuration.capabilities.delegation.enabled ||
      (tool && !(configuration.tools as string[]).includes(tool)))) {
    throw new PlatformError("ORCHESTRATION_DENIED", 403, "Specialist orchestration is unavailable");
  }
  await assertCurrentAuthority(db, execution);
  if (execution.task.pending_outcome || (await db.query("SELECT 1 FROM agents_platform.orchestration_input_closures WHERE task_id=$1",[taskId])).rowCount) throw new PlatformError("TASK_TERMINAL", 409, "This task is finishing");
  return execution;
}

export async function readWorkProgress(db: Db, taskId: string) {
  const row = (await db.query("SELECT revision,record FROM agents_platform.orchestration_progress WHERE task_id=$1", [taskId])).rows[0];
  return { revision: row ? Number(row.revision) : 0, record: row ? workRecordSchema.parse(row.record) : null };
}

export async function executeWorkTool(pool: Pool, taskId: string, operationId: string, name: "work.update" | "work.inspect", input: unknown) {
  return transaction(pool, async db => {
    await db.query("SELECT id FROM agents_platform.tasks WHERE id=$1 FOR NO KEY UPDATE", [taskId]);
    const execution=await authorizeOrchestration(db, taskId, name);
    if (name === "work.inspect") {
      const args=orchestrationContracts["work.inspect"].input.parse(input),progress=await readWorkProgress(db,taskId);
      if((execution.task.execution_policy_version??1)<2||args.instructionSequence===undefined&&args.instructionOffset===undefined)return progress;
      return {...progress,instructionPage:await instructionPage(db,execution,args.instructionSequence??"0",args.instructionOffset??0)};
    }
    const args = orchestrationContracts["work.update"].input.parse(input);
    if (Buffer.byteLength(JSON.stringify(args.record)) > 8192) throw new PlatformError("WORK_RECORD_LIMIT", 413, "Work record is too large");
    const digest = requestDigest(args);
    const receipt = (await db.query("SELECT request_digest,output FROM agents_platform.orchestration_progress_updates WHERE task_id=$1 AND operation_id=$2", [taskId, operationId])).rows[0];
    if (receipt) {
      if (receipt.request_digest !== digest) throw new PlatformError("OPERATION_CONFLICT", 409, "Work update changed");
      return receipt.output;
    }
    for (const id of args.record.evidenceTaskIds) {
      const target = (await db.query("SELECT id FROM agents_platform.tasks WHERE id=$2 AND (id=$1 OR parent_task_id=$1) AND state IN ('completed','incomplete','failed','cancelled','refused','uncertain')", [taskId, id])).rows[0];
      if (!target) {
        const prior=(await db.query("SELECT id FROM agents_platform.tasks WHERE id=$1 AND state IN ('completed','incomplete','failed','cancelled','refused')",[id])).rows[0];
        if(!prior||!await continuationChildAllowed(db,await loadExecution(db,taskId),await loadExecution(db,id)))
          throw new PlatformError("WORK_EVIDENCE_DENIED", 403, "Work evidence is outside this request");
      }
    }
    const current = await readWorkProgress(db, taskId);
    if (current.revision !== args.expectedRevision) throw new PlatformError("WORK_REVISION_CONFLICT", 409, "Read the current work record before updating");
    const output = { revision: current.revision + 1, record: args.record };
    await db.query(`INSERT INTO agents_platform.orchestration_progress(task_id,revision,record) VALUES($1,$2,$3)
      ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,record=excluded.record,updated_at=now()`, [taskId, output.revision, output.record]);
    await db.query("INSERT INTO agents_platform.orchestration_progress_updates(task_id,operation_id,request_digest,output) VALUES($1,$2,$3,$4)", [taskId, operationId, digest, output]);
    await event(db, taskId, `work:${operationId}`, "work.updated", { revision: output.revision });
    const saved=(await db.query("SELECT updated_at FROM agents_platform.orchestration_progress WHERE task_id=$1",[taskId])).rows[0];
    const specialistTasks=(await db.query("SELECT count(*)::int count FROM agents_platform.tasks WHERE parent_task_id=$1",[taskId])).rows[0].count;
    await recordOrchestrationLifecycle(db,{organizationId:execution.task.organization_id,key:taskId,action:"revision",outcome:"pending",revision:output.revision,specialistTasks,occurredAt:new Date(saved.updated_at).toISOString()});
    return output;
  });
}

export const instructionSchema = z.strictObject({ instruction: z.string().trim().min(1).max(4000), requestKey: z.uuid() });
export async function queueOrchestrationInstruction(pool: Pool, taskId: string, input: unknown) {
  return transaction(pool, db => queueOrchestrationInstructionInTransaction(db, taskId, input));
}

export async function queueOrchestrationInstructionInTransaction(db: PoolClient, taskId: string, input: unknown) {
  const args = instructionSchema.parse(input);
    await db.query("SELECT id FROM agents_platform.tasks WHERE id=$1 FOR NO KEY UPDATE", [taskId]);
    const execution = await authorizeOrchestration(db, taskId);
    if (terminalTaskStates.has(execution.task.state) || execution.task.state === "cancel_requested") throw new PlatformError("TASK_TERMINAL", 409, "This task no longer accepts instructions");
    const existing = (await db.query("SELECT instruction FROM agents_platform.orchestration_instructions WHERE task_id=$1 AND request_key=$2", [taskId, args.requestKey])).rows[0];
    if (existing) {
      if (existing.instruction !== args.instruction) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "Instruction request changed");
      return { accepted: true as const };
    }
    await db.query("INSERT INTO agents_platform.orchestration_instructions(task_id,request_key,instruction) VALUES($1,$2,$3)", [taskId, args.requestKey, args.instruction]);
    await event(db, taskId, `instruction:${args.requestKey}`, "work.instruction_queued", {});
    return { accepted: true as const };
}

/** Queued member input is user content. It never changes grants or trusted execution receipts. */
export async function readOrchestrationInstructions(pool: Pool, taskId: string) {
  const execution = await loadExecution(pool, taskId);
  if (execution.configuration.program.version !== "4" && execution.task.harness_release!=="product-capabilities-v15") return [];
  await assertCurrentAuthority(pool, execution);
  return (await pool.query("SELECT sequence,instruction FROM agents_platform.orchestration_instructions WHERE task_id=$1 ORDER BY sequence", [taskId])).rows
    .map(row => ({ role: "user" as const, content: `Additional instructions for this request:\n${row.instruction}` }));
}

/** Steering keeps its own received time; the original request time is not a substitute. */
export function instructionContent(instruction: string, receivedAt: unknown): string {
  const value = receivedAt instanceof Date ? receivedAt.toISOString() : typeof receivedAt === "string" ? receivedAt : undefined;
  return `Additional instructions for this request${value ? ` (received ${value})` : ""}:\n${instruction}`;
}

export async function orchestrationInstructionGroups(pool: Db, taskId: string, excluded: readonly string[], limit = 4) {
  const execution = await loadExecution(pool, taskId);
  if (execution.task.harness_release!=="product-capabilities-v15" && (execution.configuration.program.id !== "tool-directed" || execution.configuration.program.version !== "4")) return [];
  await assertCurrentAuthority(pool, execution);
  const seen = new Set(excluded);
  if((execution.task.execution_policy_version??1)>=2){
    const rows=(await pool.query(`SELECT i.task_id,i.sequence,i.instruction,i.created_at FROM agents_platform.orchestration_instructions i
      JOIN agents_platform.tasks t ON t.id=i.task_id WHERE t.work_id=$1 AND t.organization_id=$2 AND t.principal=$3::jsonb
        AND t.id=ANY($4::uuid[])
        AND NOT ('instruction:'||i.task_id||':'||i.sequence=ANY($5::text[]))
        AND NOT EXISTS(SELECT 1 FROM agents_platform.context_snapshots c
          JOIN agents_platform.tasks origin ON origin.id=c.task_id AND origin.work_id=t.work_id AND origin.organization_id=t.organization_id AND origin.principal=t.principal
          JOIN agents_platform.operations o ON o.task_id=c.task_id AND o.id='model:'||c.task_id||':'||c.step
          WHERE o.kind='model' AND o.name='model.generate' AND o.state='completed' AND c.step>=0 AND (
            coalesce(c.payload->'primaryInstructionIds','[]'::jsonb) ? ('instruction:'||i.task_id||':'||i.sequence)
            OR (NOT(c.payload ? 'primaryInstructionIds') AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(c.payload->'instructionGroups','[]'::jsonb)) g WHERE g->>'id'='instruction:'||i.task_id||':'||i.sequence))))
      ORDER BY t.turn_sequence,i.sequence LIMIT $6`,[execution.task.work_id??taskId,execution.task.organization_id,JSON.stringify(execution.task.principal),await instructionTaskIds(pool,execution),excluded,limit])).rows;
    return rows.map(row=>({id:`instruction:${row.task_id}:${row.sequence}`,messages:[{role:"user" as const,content:instructionContent(row.instruction,row.created_at)}]}));
  }
  const rows = (await pool.query("SELECT sequence,instruction,created_at FROM agents_platform.orchestration_instructions WHERE task_id=$1 ORDER BY sequence", [taskId])).rows;
  return rows.map(row => ({ id: `instruction:${taskId}:${row.sequence}`, messages: [{ role: "user" as const, content: instructionContent(row.instruction, row.created_at) }] }))
    .filter(group => !seen.has(group.id)).slice(0, limit);
}

export const ACTIVE_INSTRUCTION_LIMIT = 24;
export interface InstructionRow { task_id:string; sequence:number|string; instruction:string; created_at:unknown }
/**
 * Delivered instructions stay applicable until superseded. Only the newest bounded window enters the
 * prompt; omissions are counted so the caller can disclose them instead of silently dropping them.
 */
export function retainedInstructionGroups(rows: readonly InstructionRow[], pendingIds: ReadonlySet<string>, limit = ACTIVE_INSTRUCTION_LIMIT){
  const omittedActive=Math.max(0,rows.length-limit);
  const kept=rows.slice(omittedActive);
  return { omittedActive, retained: kept
    .filter(row=>!pendingIds.has(`instruction:${row.task_id}:${row.sequence}`))
    .map(row=>({id:`instruction:${row.task_id}:${row.sequence}`,messages:[{role:"user" as const,content:instructionContent(row.instruction,row.created_at)}]})) };
}
export async function primaryInstructionContext(pool:Pool,taskId:string,delivered:readonly string[]){
  const execution=await loadExecution(pool,taskId);await assertCurrentAuthority(pool,execution);
  if(execution.configuration.program.version!=="4"&&execution.task.harness_release!=="product-capabilities-v15")
    return{pending:[] as {id:string;messages:{role:"user";content:string}[]}[],retained:[] as {id:string;messages:{role:"user";content:string}[]}[],omittedActive:0,latest:undefined as {id:string;content:string}|undefined};
  const pending=await orchestrationInstructionGroups(pool,taskId,delivered,1);
  const rows=(await pool.query(`SELECT i.task_id,i.sequence,i.instruction,i.created_at FROM agents_platform.orchestration_instructions i
    JOIN agents_platform.tasks t ON t.id=i.task_id WHERE t.work_id=$1 AND t.organization_id=$2 AND t.principal=$3::jsonb
      AND t.id=ANY($4::uuid[]) AND i.state='active' ORDER BY t.turn_sequence,i.sequence`,
  [execution.task.work_id??taskId,execution.task.organization_id,JSON.stringify(execution.task.principal),await instructionTaskIds(pool,execution)])).rows;
  const pendingIds=new Set(pending.map(group=>group.id));
  const {retained,omittedActive}=retainedInstructionGroups(rows,pendingIds);
  const latestRow=rows.at(-1);
  return{pending,retained,omittedActive,
    latest:latestRow?{id:`instruction:${latestRow.task_id}:${latestRow.sequence}`,content:instructionContent(latestRow.instruction,latestRow.created_at).replace("Additional instructions for this request","Latest instructions for this request")} :undefined};
}

/** Queued directions remain private to their accepted branch. A delegated brief selects applicable facts. */
async function instructionTaskIds(db:Db,execution:Awaited<ReturnType<typeof loadExecution>>):Promise<string[]> {
  return (await db.query(`SELECT id FROM agents_platform.tasks WHERE conversation_id=$1 AND work_id=$2
    AND organization_id=$3 AND principal=$4::jsonb`,
  [execution.task.conversation_id,execution.task.work_id??execution.task.root_task_id,execution.task.organization_id,JSON.stringify(execution.task.principal)])).rows.map(row=>row.id);
}

async function instructionPage(db:PoolClient,execution:Awaited<ReturnType<typeof loadExecution>>,sequence:string,offset:number){
  const params=[execution.task.work_id??execution.task.id,execution.task.organization_id,JSON.stringify(execution.task.principal),await instructionTaskIds(db,execution)];
  const scope=`FROM agents_platform.orchestration_instructions i JOIN agents_platform.tasks t ON t.id=i.task_id WHERE t.work_id=$1 AND t.organization_id=$2 AND t.principal=$3::jsonb AND t.id=ANY($4::uuid[])`;
  const row=(await db.query(`SELECT i.task_id,i.sequence,i.instruction ${scope} AND ($5::bigint=0 OR i.sequence=$5::bigint) ORDER BY i.sequence LIMIT 1`,[...params,sequence])).rows[0];
  if(!row){if(sequence!=="0")throw new PlatformError("WORK_INSTRUCTION_SCOPE_DENIED",403,"Instruction is outside this work");return null;}
  const points=[...row.instruction as string];if(offset>points.length)throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Check instruction pagination");
  const text=fitUtf8(points.slice(offset).join(""),1024),nextOffset=offset+[...text].length;
  const next=nextOffset<points.length?{sequence:String(row.sequence),offset:nextOffset}:(await db.query(`SELECT i.sequence ${scope} AND i.sequence>$5::bigint ORDER BY i.sequence LIMIT 1`,[...params,row.sequence])).rows[0];
  return{taskId:row.task_id,sequence:String(row.sequence),offset,text,next:next?{sequence:String(next.sequence),offset:next.offset??0}:null};
}

/** Serialize the final input check with instruction admission without publishing an unvalidated outcome. */
export async function closeOrchestrationInstructions(pool: Pool, taskId: string, incorporated: readonly string[], outcome: import("../../contracts/execution").TaskOutcome) {
  return transaction(pool, async db => {
    await db.query("SELECT id FROM agents_platform.tasks WHERE id=$1 FOR NO KEY UPDATE", [taskId]);
    const execution=await loadExecution(db,taskId);
    await assertCurrentAuthority(db,execution);
    if(execution.configuration.program.version!=="4"&&execution.task.harness_release!=="product-capabilities-v15")throw new PlatformError("ORCHESTRATION_DENIED",403,"Specialist orchestration is unavailable");
    const digest=requestDigest(outcome);
    const closed=(await db.query("SELECT outcome_digest FROM agents_platform.orchestration_input_closures WHERE task_id=$1",[taskId])).rows[0];
    if(closed){if(closed.outcome_digest!==digest)throw new PlatformError("OPERATION_CONFLICT",409,"Completion intent changed");return true;}
    if((execution.task.execution_policy_version??1)>=2){
      if((await orchestrationInstructionGroups(db,taskId,incorporated,1)).length)return false;
      await db.query("INSERT INTO agents_platform.orchestration_input_closures(task_id,outcome_digest) VALUES($1,$2)",[taskId,digest]);
      return true;
    }
    const seen = new Set(incorporated);
    const queued = (await db.query("SELECT sequence FROM agents_platform.orchestration_instructions WHERE task_id=$1", [taskId])).rows;
    if (queued.some(row => !seen.has(`instruction:${taskId}:${row.sequence}`))) return false;
    await db.query("INSERT INTO agents_platform.orchestration_input_closures(task_id,outcome_digest) VALUES($1,$2)", [taskId, digest]);
    return true;
  });
}

type ProgressOperation = { name: string; request_digest: string; request?: unknown; output: unknown; error_code: string | null; state: string };
const runtimeHandleKeys = new Set(["taskId", "taskIds", "priorTaskId", "conversationId"]);

function normalizeRuntimeHandles(value: unknown, key = ""): unknown {
  if (runtimeHandleKeys.has(key)) return Array.isArray(value) ? ["<task>"] : value === null ? null : "<task>";
  if (Array.isArray(value)) {
    const normalized = value.map(item => normalizeRuntimeHandles(item));
    return key === "children" ? [...new Map(normalized.map(item => [requestDigest(item),item])).values()] : normalized;
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([name,item]) => [name,normalizeRuntimeHandles(item,name)]));
}

function progressFingerprint(row: ProgressOperation) {
  let request = row.request;
  if (request && typeof request === "object" && "arguments" in request) {
    try { request = JSON.parse(String((request as { arguments: unknown }).arguments)); }
    catch { request = undefined; }
  }
  const orchestration = row.name.startsWith("agents.");
  const output = row.name === "work.update" ? "work.record" : row.output;
  return requestDigest({ name: row.name,
    request: row.name === "work.update" ? "work.update" : request !== undefined ? orchestration ? normalizeRuntimeHandles(request) : request : row.request_digest,
    output: orchestration ? normalizeRuntimeHandles(output) : output, error: row.error_code, state: row.state });
}

/** New evidence breaks a cycle; creating another equivalent runtime handle does not. */
export function repeatedOperationObservation(rows: ProgressOperation[], limit: number) {
  const fingerprints = rows.map(progressFingerprint);
  for (let period = 1; period <= 4 && period * limit <= fingerprints.length; period++) {
    const sequence = fingerprints.slice(0,period * limit);
    if (!sequence.every((value,index) => value === sequence[index % period])) continue;
    const cycle = sequence.slice(0,period);
    const rotations = cycle.map((_,index) => [...cycle.slice(index),...cycle.slice(0,index)].join(":"));
    return requestDigest({cycle: rotations.sort()[0]});
  }
  return null;
}

/** Progress observation applies to every tool-directed agent, with or without delegation. */
export function progressObservationApplies(configuration: { program: { version: string } }): boolean {
  return configuration.program.version === "4";
}

export async function orchestrationProgressObservation(pool: Db, taskId: string) {
  const execution = await loadExecution(pool, taskId), delegation = execution.configuration.capabilities.delegation;
  if (!progressObservationApplies(execution.configuration)) return null;
  const limit = delegation.enabled ? delegation.policy?.maxStalls ?? 3 : 3;
  if ((await pool.query("SELECT 1 FROM agents_platform.tasks WHERE parent_task_id=$1 AND state NOT IN ('completed','incomplete','failed','cancelled','refused','uncertain') LIMIT 1", [taskId])).rowCount) return null;
  // Shared-runtime operations pin the instruction revision they observed. Earlier actions
  // cannot establish that the revised request is making no progress.
  const head=execution.task.harness_release===SHARED_HARNESS_RELEASE?await instructionHead(pool,taskId):null;
  const rows = (await pool.query(`SELECT name,request_digest,request,output,error_code,state FROM agents_platform.operations
    WHERE task_id=$1 AND kind IN ('tool','delegation','resource') AND state IN ('completed','failed')
      AND name<>'agents.wait' AND ($3::text IS NOT NULL OR name<>'work.inspect')
      AND ($3::text IS NULL OR request->>'instructionHead'=$3)
    ORDER BY started_at DESC,id DESC LIMIT $2`, [taskId, limit * 4,head])).rows;
  const observation=repeatedOperationObservation(rows, limit);
  return observation&&head!==null?requestDigest({observation,instructionHead:head}):observation;
}

type StallStop = {kind:"stop";observation:string;outcome:TaskOutcome};
const stallOutcomeSchema=z.strictObject({state:z.literal("incomplete"),errorCode:z.literal("ORCHESTRATION_STALLED"),output:z.string().min(1)});
function storedStall(row:Record<string,any>,step:number,observation?:string):StallStop|null {
  if(Number(row.step)!==step)return null;
  const outcome=stallOutcomeSchema.parse(row.outcome);
  if(requestDigest(outcome)!==row.outcome_digest||row.closure_digest!==row.outcome_digest||observation&&row.observation_digest!==observation)throw new PlatformError("OPERATION_CONFLICT",409,"The stalled stop decision changed");
  return {kind:"stop",observation:row.observation_digest,outcome};
}

/** Read before rebuilding a partial response after a committed decision loses its acknowledgement. */
export async function readStallDecision(db:Db,taskId:string,step:number):Promise<StallStop|null>{
  const row=(await db.query(`SELECT d.step,d.observation_digest,d.outcome,d.outcome_digest,c.outcome_digest AS closure_digest
    FROM agents_platform.orchestration_stall_decisions d LEFT JOIN agents_platform.orchestration_input_closures c ON c.task_id=d.task_id WHERE d.task_id=$1`,[taskId])).rows[0];
  return row?storedStall(row,step):null;
}

/** The task lock serializes a late instruction with the exact stop outcome and input closure. */
export async function decideStallStop(pool:Pool,taskId:string,step:number,observation:string,incorporated:readonly string[],outcome:TaskOutcome):Promise<StallStop|{kind:"resume"}>{
  const exact=stallOutcomeSchema.parse(outcome);
  return transaction(pool,async db=>{
    const initial=await loadExecution(db,taskId);
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[initial.task.organization_id]);
    await db.query("SELECT id FROM agents_platform.tasks WHERE id=$1 FOR NO KEY UPDATE",[taskId]);
    const prior=(await db.query(`SELECT d.step,d.observation_digest,d.outcome,d.outcome_digest,c.outcome_digest AS closure_digest
      FROM agents_platform.orchestration_stall_decisions d LEFT JOIN agents_platform.orchestration_input_closures c ON c.task_id=d.task_id WHERE d.task_id=$1`,[taskId])).rows[0];
    if(prior){const saved=storedStall(prior,step,observation);if(!saved)throw new PlatformError("OPERATION_CONFLICT",409,"The stalled stop decision changed");return saved;}
    const execution=await loadExecution(db,taskId);await assertCurrentAuthority(db,execution);
    if(execution.task.harness_release!==SHARED_HARNESS_RELEASE)throw new PlatformError("ORCHESTRATION_DENIED",403,"The stalled stop is unavailable");
    if(await orchestrationProgressObservation(db,taskId)!==observation||(await orchestrationInstructionGroups(db,taskId,incorporated,1)).length)return {kind:"resume" as const};
    const digest=requestDigest(exact);
    if((await db.query("SELECT 1 FROM agents_platform.orchestration_input_closures WHERE task_id=$1",[taskId])).rowCount)throw new PlatformError("OPERATION_CONFLICT",409,"The input was already closed");
    await db.query("INSERT INTO agents_platform.orchestration_input_closures(task_id,outcome_digest) VALUES($1,$2)",[taskId,digest]);
    await db.query("INSERT INTO agents_platform.orchestration_stall_decisions(task_id,step,observation_digest,outcome,outcome_digest) VALUES($1,$2,$3,$4,$5)",[taskId,step,observation,exact,digest]);
    return {kind:"stop" as const,observation,outcome:exact};
  });
}

export async function orchestrationStalled(pool: Pool, taskId: string) {
  const execution = await loadExecution(pool, taskId), delegation = execution.configuration.capabilities.delegation;
  if (execution.configuration.program.version !== "4" || !delegation.enabled) return false;
  const limit = delegation.enabled ? delegation.policy?.maxStalls ?? 3 : 3;
  if ((await pool.query("SELECT 1 FROM agents_platform.tasks WHERE parent_task_id=$1 AND state NOT IN ('completed','incomplete','failed','cancelled','refused','uncertain') LIMIT 1", [taskId])).rowCount) return false;
  const rows = (await pool.query("SELECT request_digest FROM agents_platform.operations WHERE task_id=$1 AND kind IN ('tool','delegation','resource') AND name NOT IN ('agents.wait','work.inspect') ORDER BY started_at DESC,id DESC LIMIT $2", [taskId, limit])).rows;
  return rows.length === limit && rows.every(row => row.request_digest === rows[0].request_digest);
}
