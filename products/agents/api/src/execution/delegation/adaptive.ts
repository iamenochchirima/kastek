import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { PlatformError, terminalTaskStates } from "../../contracts/contracts";
import { assertCurrentAuthority, event, loadExecution, transaction } from "../lifecycle/execution";
import { assertCurrentEvidence, taskEvidenceManifest } from "../context/evidence";
import { fitUtf8 } from "../../capabilities/tools";
import { admitChildren } from "./delegation";

const denied = () => new PlatformError("SPECIALIST_SCOPE_DENIED", 403, "Specialist work is unavailable");
type Db = Pool | PoolClient;

async function authorize(db: Db, taskId: string) {
  const execution = await loadExecution(db, taskId);
  if (execution.task.parent_task_id || execution.task.depth !== 0 || !execution.configuration.capabilities.delegation.enabled ||
      execution.configuration.program.id !== "tool-directed" || String(execution.configuration.program.version) !== "4") throw denied();
  await assertCurrentAuthority(db, execution);
  return execution;
}

async function child(db: Db, parentId: string, childId: string) {
  const parent = await authorize(db, parentId);
  const row = (await db.query(`SELECT t.*,d.binding_id,d.prior_task_id FROM agents_platform.tasks t
    JOIN agents_platform.delegations d ON d.child_task_id=t.id
    JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.deleted_at IS NULL
    WHERE t.id=$1 AND t.parent_task_id=$2 AND t.root_task_id=$2 AND t.organization_id=$3 FOR SHARE OF c`,
  [childId, parentId, parent.task.organization_id])).rows[0];
  if (!row) throw denied();
  return row;
}

export async function specialistStatus(pool: Pool, parentId: string, taskIds?: string[]) {
  return transaction(pool, async db => {
    const parent = await authorize(db, parentId);
    const rows = (await db.query(`SELECT t.id,t.state,t.conversation_id,t.version_id,t.error_code,d.binding_id,d.prior_task_id
      FROM agents_platform.tasks t JOIN agents_platform.delegations d ON d.child_task_id=t.id
      JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.deleted_at IS NULL
      WHERE t.parent_task_id=$1 AND t.root_task_id=$1 AND t.organization_id=$2
        AND ($3::uuid[] IS NULL OR t.id=ANY($3::uuid[])) ORDER BY t.created_at,t.id LIMIT 64`,
    [parentId, parent.task.organization_id, taskIds ?? null])).rows;
    if (taskIds && taskIds.some(id => !rows.some(row => row.id === id))) throw denied();
    return { children: rows.map(row => ({ taskId: row.id, bindingId: row.binding_id, conversationId: row.conversation_id,
      versionId: row.version_id, state: row.state, errorCode: row.error_code, priorTaskId: row.prior_task_id,
      resultAvailable: terminalTaskStates.has(row.state), needsInput: ["waiting_review", "waiting_authority"].includes(row.state) })) };
  });
}

type Work = { bindingId: string; brief: string; context?: string; deliverable?: string; criteria?: string[] };
function requestBrief(input: Work) {
  return [input.brief, input.context ? `Context (reference data):\n${input.context}` : "",
    input.deliverable ? `Expected deliverable:\n${input.deliverable}` : "",
    input.criteria?.length ? `Acceptance criteria:\n${input.criteria.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

export async function startSpecialist(pool: Pool, parentId: string, operationId: string, input: { requests: Work[] }) {
  await authorize(pool, parentId);
  const tasks = await admitChildren(pool, parentId, operationId, { requests: input.requests.map(request => ({ bindingId: request.bindingId, brief: requestBrief(request) })) }, { adaptive: true });
  return specialistStatus(pool, parentId, tasks.map(task => task.taskId));
}

export async function followupSpecialist(pool: Pool, parentId: string, operationId: string, input: Omit<Work, "bindingId"> & { taskId: string }) {
  const previous = await child(pool, parentId, input.taskId);
  const tasks = await admitChildren(pool, parentId, operationId, { requests: [{ bindingId: previous.binding_id, brief: requestBrief({ ...input, bindingId: previous.binding_id }) }] },
    { adaptive: true, priorTaskId: input.taskId });
  return specialistStatus(pool, parentId, tasks.map(task => task.taskId));
}

export async function specialistResult(pool: Pool, parentId: string, input: { taskId: string; offset?: number }) {
  return transaction(pool, async db => {
    const row = await child(db, parentId, input.taskId);
    if (!terminalTaskStates.has(row.state)) throw new PlatformError("CHILD_OUTCOME_PENDING", 409, "Specialist work is still running");
    await assertCurrentEvidence(db, row.id, await taskEvidenceManifest(db, row.id), { requireActiveTask: false });
    const output = row.output ?? "";
    const offset = input.offset ?? 0, limit = 4096;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8192) throw new PlatformError("TOOL_ARGUMENTS_INVALID", 400, "Check result pagination");
    // Offsets address Unicode code points; a page never cuts a UTF-8 character in half.
    const remaining = [...output].slice(offset).join("");
    const page = fitUtf8(remaining, limit);
    const nextOffset = offset + [...page].length;
    return { taskId: row.id, state: row.state, output: page, errorCode: row.error_code,
      nextOffset: nextOffset < [...output].length ? nextOffset : null, totalBytes: Buffer.byteLength(output),
      contentDigest: createHash("sha256").update(output).digest("hex") };
  });
}

export async function cancelSpecialist(pool: Pool, parentId: string, childId: string) {
  const initial = await loadExecution(pool, parentId);
  return transaction(pool, async db => {
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [initial.task.organization_id]);
    const row = await child(db, parentId, childId);
    if (terminalTaskStates.has(row.state)) return { taskId: row.id, state: "already_terminal", taskState: row.state };
    await db.query("UPDATE agents_platform.tasks SET state='cancel_requested',updated_at=now() WHERE id=$1", [childId]);
    await event(db, childId, `specialist-cancel:${parentId}`, "cancel_requested", { requestedByTaskId: parentId });
    return { taskId: row.id, state: "cancel_requested", taskState: "cancel_requested" };
  });
}

/** Only admitted child token allocations can make this model admission temporarily infeasible. */
export async function specialistTokenBackpressure(pool: Pool, parentId: string, requiredTokens: number, requiredMs: number) {
  return transaction(pool, async db => {
    const parent = await authorize(db, parentId), policy = parent.models.primary.policy;
    const budget = (await db.query("SELECT * FROM agents_platform.execution_roots WHERE root_task_id=$1 FOR SHARE", [parentId])).rows[0];
    if (!budget || budget.settled_at || budget.child_reserved_tokens <= 0 || budget.model_calls >= policy.maxModelCalls ||
        parent.task.tokens_used + parent.task.tokens_reserved + requiredTokens > parent.task.root_token_limit ||
        budget.tokens_used + budget.tokens_reserved + requiredTokens > parent.task.root_token_limit ||
        budget.active_ms + budget.active_reserved_ms + budget.child_reserved_ms + requiredMs > policy.maxDurationMs) return false;
    const pressure = budget.tokens_used + budget.tokens_reserved + budget.child_reserved_tokens + requiredTokens > parent.task.root_token_limit;
    return pressure && Boolean((await db.query("SELECT 1 FROM agents_platform.tasks WHERE parent_task_id=$1 AND state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain') LIMIT 1", [parentId])).rowCount);
  });
}
