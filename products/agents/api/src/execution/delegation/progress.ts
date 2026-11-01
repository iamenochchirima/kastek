import { recordOrchestrationLifecycle } from "../../observability/orchestration-lifecycle";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { PlatformError, requestDigest, terminalTaskStates } from "../../contracts/contracts";
import { workRecordSchema, orchestrationContracts } from "../../contracts/orchestration";
import { assertCurrentAuthority, loadExecution, event, transaction } from "../lifecycle/execution";
import { continuationChildAllowed } from "../context/work-lineage";
import { fitUtf8 } from "../../capabilities/tools";

type Db = Pool | PoolClient;
export async function authorizeOrchestration(db: Db, taskId: string, tool?: string) {
  const execution = await loadExecution(db, taskId);
  const { task, configuration } = execution;
  if (task.parent_task_id || task.id !== task.root_task_id || !["human", "automation"].includes(task.principal.kind) ||
      configuration.program.id !== "tool-directed" || configuration.program.version !== "4" || !configuration.capabilities.delegation.enabled ||
      (tool && !(configuration.tools as string[]).includes(tool))) {
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
    const count = (await db.query("SELECT count(*)::int count FROM agents_platform.orchestration_instructions WHERE task_id=$1", [taskId])).rows[0].count;
    if (count >= 32) throw new PlatformError("INSTRUCTION_LIMIT", 429, "This task has reached its instruction limit");
    await db.query("INSERT INTO agents_platform.orchestration_instructions(task_id,request_key,instruction) VALUES($1,$2,$3)", [taskId, args.requestKey, args.instruction]);
    await event(db, taskId, `instruction:${args.requestKey}`, "work.instruction_queued", {});
    return { accepted: true as const };
}

/** Queued member input is user content. It never changes grants or trusted execution receipts. */
export async function readOrchestrationInstructions(pool: Pool, taskId: string) {
  const execution = await loadExecution(pool, taskId);
  if (execution.configuration.program.version !== "4" || execution.task.parent_task_id) return [];
  await assertCurrentAuthority(pool, execution);
  return (await pool.query("SELECT sequence,instruction FROM agents_platform.orchestration_instructions WHERE task_id=$1 ORDER BY sequence", [taskId])).rows
    .map(row => ({ role: "user" as const, content: `Additional instructions for this request:\n${row.instruction}` }));
}

export async function orchestrationInstructionGroups(pool: Db, taskId: string, excluded: readonly string[], limit = 4) {
  const execution = await loadExecution(pool, taskId);
  if (execution.configuration.program.id !== "tool-directed" || execution.configuration.program.version !== "4" || execution.task.parent_task_id) return [];
  await assertCurrentAuthority(pool, execution);
  const seen = new Set(excluded);
  if((execution.task.execution_policy_version??1)>=2){
    const rows=(await pool.query(`SELECT i.task_id,i.sequence,i.instruction FROM agents_platform.orchestration_instructions i
      JOIN agents_platform.tasks t ON t.id=i.task_id WHERE t.work_id=$1 AND t.organization_id=$2 AND t.principal=$3::jsonb
        AND t.conversation_id=$4 AND t.parent_task_id IS NULL
        AND NOT ('instruction:'||i.task_id||':'||i.sequence=ANY($5::text[]))
        AND NOT EXISTS(SELECT 1 FROM agents_platform.context_snapshots c
          JOIN agents_platform.tasks origin ON origin.id=c.task_id AND origin.work_id=t.work_id AND origin.organization_id=t.organization_id AND origin.principal=t.principal
          JOIN agents_platform.operations o ON o.task_id=c.task_id AND o.id='model:'||c.task_id||':'||c.step
          WHERE o.kind='model' AND o.name='model.generate' AND o.state='completed' AND c.step>=0 AND (
            coalesce(c.payload->'primaryInstructionIds','[]'::jsonb) ? ('instruction:'||i.task_id||':'||i.sequence)
            OR (NOT(c.payload ? 'primaryInstructionIds') AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(c.payload->'instructionGroups','[]'::jsonb)) g WHERE g->>'id'='instruction:'||i.task_id||':'||i.sequence))))
      ORDER BY t.turn_sequence,i.sequence LIMIT $6`,[execution.task.work_id??taskId,execution.task.organization_id,JSON.stringify(execution.task.principal),execution.task.conversation_id,excluded,limit])).rows;
    return rows.map(row=>({id:`instruction:${row.task_id}:${row.sequence}`,messages:[{role:"user" as const,content:`Additional instructions for this request:\n${row.instruction}`}]}));
  }
  const rows = (await pool.query("SELECT sequence,instruction FROM agents_platform.orchestration_instructions WHERE task_id=$1 ORDER BY sequence", [taskId])).rows;
  return rows.map(row => ({ id: `instruction:${taskId}:${row.sequence}`, messages: [{ role: "user" as const, content: `Additional instructions for this request:\n${row.instruction}` }] }))
    .filter(group => !seen.has(group.id)).slice(0, limit);
}

export async function primaryInstructionContext(pool:Pool,taskId:string,delivered:readonly string[]){
  const execution=await loadExecution(pool,taskId);await assertCurrentAuthority(pool,execution);
  if(execution.task.parent_task_id||execution.configuration.program.version!=="4")return{pending:[] as {id:string;messages:{role:"user";content:string}[]}[],latest:undefined as {id:string;content:string}|undefined};
  const pending=await orchestrationInstructionGroups(pool,taskId,delivered,1);
  const row=(await pool.query(`SELECT i.task_id,i.sequence,i.instruction FROM agents_platform.orchestration_instructions i
    JOIN agents_platform.tasks t ON t.id=i.task_id WHERE t.work_id=$1 AND t.organization_id=$2 AND t.principal=$3::jsonb
      AND t.conversation_id=$4 AND t.parent_task_id IS NULL ORDER BY t.turn_sequence DESC,i.sequence DESC LIMIT 1`,
  [execution.task.work_id??taskId,execution.task.organization_id,JSON.stringify(execution.task.principal),execution.task.conversation_id])).rows[0];
  return{pending,latest:row?{id:`instruction:${row.task_id}:${row.sequence}`,content:`Latest instructions for this request:\n${row.instruction}`} :undefined};
}

async function instructionPage(db:PoolClient,execution:Awaited<ReturnType<typeof loadExecution>>,sequence:string,offset:number){
  const params=[execution.task.work_id??execution.task.id,execution.task.organization_id,JSON.stringify(execution.task.principal),execution.task.conversation_id];
  const scope=`FROM agents_platform.orchestration_instructions i JOIN agents_platform.tasks t ON t.id=i.task_id WHERE t.work_id=$1 AND t.organization_id=$2 AND t.principal=$3::jsonb AND t.conversation_id=$4 AND t.parent_task_id IS NULL`;
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
    if(execution.task.parent_task_id||execution.configuration.program.version!=="4")throw new PlatformError("ORCHESTRATION_DENIED",403,"Specialist orchestration is unavailable");
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

export async function orchestrationProgressObservation(pool: Pool, taskId: string) {
  const execution = await loadExecution(pool, taskId), delegation = execution.configuration.capabilities.delegation;
  if (execution.configuration.program.version !== "4" || !delegation.enabled || execution.task.parent_task_id) return null;
  const limit = delegation.policy?.maxStalls ?? 3;
  if ((await pool.query("SELECT 1 FROM agents_platform.tasks WHERE parent_task_id=$1 AND state NOT IN ('completed','incomplete','failed','cancelled','refused','uncertain') LIMIT 1", [taskId])).rowCount) return null;
  const rows = (await pool.query("SELECT name,request_digest,request,output,error_code,state FROM agents_platform.operations WHERE task_id=$1 AND kind IN ('tool','delegation','resource') AND state IN ('completed','failed') AND name NOT IN ('agents.wait','work.inspect') ORDER BY started_at DESC,id DESC LIMIT $2", [taskId, limit * 4])).rows;
  return repeatedOperationObservation(rows, limit);
}

export async function orchestrationStalled(pool: Pool, taskId: string) {
  const execution = await loadExecution(pool, taskId), delegation = execution.configuration.capabilities.delegation;
  if (execution.configuration.program.version !== "4" || !delegation.enabled || execution.task.parent_task_id) return false;
  const limit = delegation.policy?.maxStalls ?? 3;
  if ((await pool.query("SELECT 1 FROM agents_platform.tasks WHERE parent_task_id=$1 AND state NOT IN ('completed','incomplete','failed','cancelled','refused','uncertain') LIMIT 1", [taskId])).rowCount) return false;
  const rows = (await pool.query("SELECT request_digest FROM agents_platform.operations WHERE task_id=$1 AND kind IN ('tool','delegation','resource') AND name NOT IN ('agents.wait','work.inspect') ORDER BY started_at DESC,id DESC LIMIT $2", [taskId, limit])).rows;
  return rows.length === limit && rows.every(row => row.request_digest === rows[0].request_digest);
}
