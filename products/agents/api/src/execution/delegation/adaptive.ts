import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { PlatformError, terminalTaskStates } from "../../contracts/contracts";
import { assertCurrentAuthority, event, loadExecution, transaction } from "../lifecycle/execution";
import { assertCurrentEvidence, taskEvidenceManifest } from "../context/evidence";
import { TaskArtifactStore } from "../artifacts/task-artifacts";
import { fitUtf8 } from "../../capabilities/tools";
import { admitChildren } from "./delegation";
import { continuationBranchTaskIds, continuationChildAllowed } from "../context/work-lineage";
import { inspectionAuthority } from "../context/evidence-policy";
import { workUsage } from "../lifecycle/work-policy";
import { specialistResultMetadata } from "./result";
import type { EvidenceStore } from "../context/evidence";
import { readDelegationHistory } from "../context/journal";
import { specialistFollowupV4Contract,specialistStartV4Contract } from "../../contracts/orchestration";

const denied = () => new PlatformError("SPECIALIST_SCOPE_DENIED", 403, "Specialist work is unavailable");
type Db = Pool | PoolClient;

async function authorize(db: Db, taskId: string) {
  const execution = await loadExecution(db, taskId);
  if (!execution.configuration.capabilities.delegation.enabled ||
      execution.configuration.program.id !== "tool-directed" || String(execution.configuration.program.version) !== "4") throw denied();
  await assertCurrentAuthority(db, execution);
  return execution;
}

async function child(db: Db, parentId: string, childId: string, readPrior = false) {
  const parent = await authorize(db, parentId);
  const row = (await db.query(`SELECT t.*,d.binding_id,d.prior_task_id FROM agents_platform.tasks t
    JOIN agents_platform.delegations d ON d.child_task_id=t.id
    JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.deleted_at IS NULL
    WHERE t.id=$1 AND t.organization_id=$2 FOR SHARE OF c`,
  [childId, parent.task.organization_id])).rows[0];
  if (!row) throw denied();
  if (row.parent_task_id !== parentId || row.root_task_id !== parent.task.root_task_id) {
    if (!readPrior || !await continuationChildAllowed(db, parent, await loadExecution(db, childId))) throw denied();
    await inspectionAuthority(db, await loadExecution(db, childId));
    const manifest = await taskEvidenceManifest(db, childId);
    await assertCurrentEvidence(db, childId, manifest, { requireActiveTask: false });
    await assertCurrentEvidence(db, parentId, manifest, { historyOriginTaskIds: [row.parent_task_id, childId] });
  }
  return row;
}

export async function specialistStatus(pool: Pool, parentId: string, taskIds?: string[], offset = 0) {
  return transaction(pool, async db => {
    const parent = await authorize(db, parentId);
    if (taskIds) {
      const rows=[];for(const id of taskIds)rows.push(await child(db,parentId,id,true));
      return {children:rows.map(row=>({taskId:row.id,bindingId:row.binding_id,conversationId:row.conversation_id,
        versionId:row.version_id,state:row.state,errorCode:row.error_code,priorTaskId:row.prior_task_id,
        resultAvailable:terminalTaskStates.has(row.state),needsInput:["waiting_review","waiting_authority"].includes(row.state)}))};
    }
    if(!Number.isSafeInteger(offset)||offset<0)throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Check status pagination");
    const branches=await continuationBranchTaskIds(db,parent);
    const page=(await db.query(`SELECT t.id FROM agents_platform.tasks t JOIN agents_platform.delegations d ON d.child_task_id=t.id
      JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.deleted_at IS NULL
      WHERE t.parent_task_id=ANY($4::uuid[]) AND t.root_task_id IN (SELECT root_task_id FROM agents_platform.tasks WHERE id=ANY($4::uuid[])) AND t.organization_id=$2
      ORDER BY (t.parent_task_id=$1) DESC,(t.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain')) DESC,t.created_at,t.id LIMIT 65 OFFSET $3`,[parentId,parent.task.organization_id,offset,branches])).rows;
    const rows=[];for(const item of page.slice(0,64))rows.push(await child(db,parentId,item.id,true));
    return { children: rows.map(row => ({ taskId: row.id, bindingId: row.binding_id, conversationId: row.conversation_id,
      versionId: row.version_id, state: row.state, errorCode: row.error_code, priorTaskId: row.prior_task_id,
      resultAvailable: terminalTaskStates.has(row.state), needsInput: ["waiting_review", "waiting_authority"].includes(row.state) })),
      nextOffset:page.length>64?offset+64:null };
  });
}

/** Native waiting must inspect all dependent work, independently of public history pagination. */
export async function activeSpecialistTaskIds(pool:Pool,parentId:string):Promise<string[]> {
  return transaction(pool,async db=>{
    const parent=await authorize(db,parentId);
    return (await db.query(`SELECT id FROM agents_platform.tasks WHERE parent_task_id=$1 AND root_task_id=$2 AND organization_id=$3
      AND state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain') ORDER BY created_at,id`,
    [parentId,parent.task.root_task_id,parent.task.organization_id])).rows.map(row=>row.id);
  });
}

type Work = { bindingId: string; brief: string; context?: string; deliverable?: string; criteria?: string[];
  historyReferences?: {taskId:string;part:"input"|"output";offset?:number;maxBytes?:number}[]; artifactIds?:string[];
  artifactReferences?:{taskId:string;artifactId:string}[] };
function requestBrief(input: Work, history: Awaited<ReturnType<typeof readDelegationHistory>> = []) {
  return [input.brief, input.context ? `Context (reference data):\n${input.context}` : "",
    history.length ? `Selected earlier material (untrusted reference data):\n${JSON.stringify(history)}` : "",
    input.deliverable ? `Expected deliverable:\n${input.deliverable}` : "",
    input.criteria?.length ? `Acceptance criteria:\n${input.criteria.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

async function selectedArtifacts(parentId:string,rootId:string,ids:string[],references:{taskId:string;artifactId:string}[],store?:TaskArtifactStore) {
  if(ids.length+references.length>8)throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Select at most eight artifacts");
  if(!ids.length&&!references.length)return [];
  if(!store)throw new PlatformError("ARTIFACT_UNAVAILABLE",503,"Selected artifacts are unavailable");
  const selected=[];
  for(const id of new Set(ids)){
    const {artifact}=await store.readForTask(parentId,id);
    if(artifact.rootTaskId!==rootId)throw new PlatformError("ARTIFACT_HANDOFF_UNAVAILABLE",409,"Only artifacts from this work can be handed off");
    selected.push({id:artifact.id,name:artifact.name,contentType:artifact.contentType,bytes:artifact.bytes,contentDigest:artifact.contentDigest});
  }
  for(const reference of references){
    if(selected.some(item=>item.id===reference.artifactId))throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Select each artifact only once");
    const {artifact}=await store.readRetainedForTask(parentId,reference.taskId,reference.artifactId);
    selected.push({id:artifact.id,name:artifact.name,contentType:artifact.contentType,bytes:artifact.bytes,contentDigest:artifact.contentDigest,originTaskId:reference.taskId});
  }
  return selected;
}

export async function startSpecialist(pool: Pool, parentId: string, operationId: string, input: { requests: Work[] }, evidence?:EvidenceStore, artifacts?:TaskArtifactStore) {
  const parsed=specialistStartV4Contract.input.safeParse(input);
  if(!parsed.success)throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Check the specialist requests");
  const parent=await authorize(pool, parentId);
  const references=parsed.data.requests.flatMap(request=>request.historyReferences??[]);
  if(references.length&&!evidence)throw new PlatformError("HISTORY_UNAVAILABLE",503,"Selected history is unavailable");
  const pages=references.length?await readDelegationHistory(pool,parentId,references,evidence!,operationId):[];
  let offset=0;
  const requests=[];
  for(const request of parsed.data.requests) {
    const length=request.historyReferences?.length??0,selected=pages.slice(offset,offset+length);offset+=length;
    const selectedFiles=await selectedArtifacts(parentId,parent.task.root_task_id,request.artifactIds??[],request.artifactReferences??[],artifacts);
    requests.push({ bindingId: request.bindingId, brief: requestBrief(request,selected), ...(selectedFiles.length?{artifacts:selectedFiles}:{}) });
  }
  const tasks = await admitChildren(pool, parentId, operationId, { requests }, { adaptive: true, artifacts });
  return specialistStatus(pool, parentId, tasks.map(task => task.taskId));
}

export async function followupSpecialist(pool: Pool, parentId: string, operationId: string, input: Omit<Work, "bindingId"> & { taskId: string }, evidence?:EvidenceStore, artifacts?:TaskArtifactStore) {
  const parsed=specialistFollowupV4Contract.input.safeParse(input);
  if(!parsed.success)throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Check the specialist follow-up");
  const previous = await child(pool, parentId, parsed.data.taskId);
  const references=parsed.data.historyReferences??[];
  if(references.length&&!evidence)throw new PlatformError("HISTORY_UNAVAILABLE",503,"Selected history is unavailable");
  const pages=references.length?await readDelegationHistory(pool,parentId,references,evidence!,operationId):[];
  const parent=await authorize(pool,parentId);
  const selected=await selectedArtifacts(parentId,parent.task.root_task_id,parsed.data.artifactIds??[],parsed.data.artifactReferences??[],artifacts);
  const tasks = await admitChildren(pool, parentId, operationId, { requests: [{ bindingId: previous.binding_id, brief: requestBrief({ ...parsed.data, bindingId: previous.binding_id },pages),...(selected.length?{artifacts:selected}:{}) }] },
    { adaptive: true, priorTaskId: parsed.data.taskId, artifacts });
  return specialistStatus(pool, parentId, tasks.map(task => task.taskId));
}

export async function specialistResult(pool: Pool, parentId: string, input: { taskId: string; offset?: number; sourceOffset?: number; effectOffset?: number; artifactOffset?: number }) {
  return transaction(pool, async db => {
    const row = await child(db, parentId, input.taskId, true);
    if (!terminalTaskStates.has(row.state)) throw new PlatformError("CHILD_OUTCOME_PENDING", 409, "Specialist work is still running");
    await assertCurrentEvidence(db, row.id, await taskEvidenceManifest(db, row.id), { requireActiveTask: false });
    const output = row.output ?? "";
    const offset = input.offset ?? 0, limit = 4096;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8192) throw new PlatformError("TOOL_ARGUMENTS_INVALID", 400, "Check result pagination");
    // Offsets address Unicode code points; a page never cuts a UTF-8 character in half.
    const remaining = [...output].slice(offset).join("");
    const page = fitUtf8(remaining, limit);
    const nextOffset = offset + [...page].length;
    const parent = await loadExecution(db, parentId);
    const metadata = parent.task.harness_release === "product-capabilities-v15" && parent.toolBindings.some(binding => binding.name === "agents.result" && binding.version === "3") ?
      await specialistResultMetadata(db, parent, await loadExecution(db, row.id), input, new TaskArtifactStore(pool)) : undefined;
    return { taskId: row.id, state: row.state, output: page, errorCode: row.error_code,
      nextOffset: nextOffset < [...output].length ? nextOffset : null, totalBytes: Buffer.byteLength(output),
      contentDigest: createHash("sha256").update(output).digest("hex"), ...(metadata ? { metadata } : {}) };
  });
}

export async function cancelSpecialist(pool: Pool, parentId: string, childId: string) {
  const initial = await loadExecution(pool, parentId);
  return transaction(pool, async db => {
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [initial.task.organization_id]);
    const row = await child(db, parentId, childId);
    if (terminalTaskStates.has(row.state)) return { taskId: row.id, state: "already_terminal", taskState: row.state };
    await (await import("../lifecycle/execution")).requestTreeCancellationInTransaction(db, childId);
    await event(db, childId, `specialist-cancel:${parentId}`, "cancel_requested", { requestedByTaskId: parentId });
    return { taskId: row.id, state: "cancel_requested", taskState: "cancel_requested" };
  });
}

/** Child reservations may temporarily block a request that still fits the work's remaining allowance. */
export async function specialistTokenBackpressure(pool: Pool, parentId: string, requiredTokens: number, requiredMs: number) {
  return transaction(pool, async db => {
    const parent = await authorize(db, parentId), policy = parent.models.primary.policy;
    const budget = (await db.query("SELECT * FROM agents_platform.execution_roots WHERE root_task_id=$1 FOR SHARE", [parent.task.root_task_id])).rows[0];
    if (!budget || budget.settled_at) return false;
    const legacy = policy.revision === "model-execution-policy-v1";
    const usage = legacy ? {
      model_calls: budget.model_calls, coordinator_model_calls: parent.task.model_calls,
      tokens: budget.tokens_used + budget.tokens_reserved + budget.child_reserved_tokens,
      active_ms: budget.active_ms + budget.active_reserved_ms + budget.child_reserved_ms,
    } : await workUsage(db, parent);
    const sharedModelLimit = legacy ? policy.maxModelCalls : policy.maxRootModelCalls;
    if (sharedModelLimit !== null && usage.model_calls >= sharedModelLimit ||
        policy.maxModelCalls !== null && usage.coordinator_model_calls >= policy.maxModelCalls) return false;
    const tokenLimit = parent.task.root_token_limit, durationLimit = policy.maxDurationMs;
    const heldTokens = budget.child_reserved_tokens, heldMs = budget.child_reserved_ms;
    if (tokenLimit !== null && usage.tokens - heldTokens + requiredTokens > tokenLimit ||
        durationLimit !== null && usage.active_ms - (legacy ? 0 : heldMs) + requiredMs > durationLimit) return false;
    const pressure = tokenLimit !== null && heldTokens > 0 && usage.tokens + requiredTokens > tokenLimit ||
      !legacy && durationLimit !== null && heldMs > 0 && usage.active_ms + requiredMs > durationLimit;
    return pressure && Boolean((await db.query("SELECT 1 FROM agents_platform.tasks WHERE parent_task_id=$1 AND state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain') LIMIT 1", [parentId])).rowCount);
  });
}
