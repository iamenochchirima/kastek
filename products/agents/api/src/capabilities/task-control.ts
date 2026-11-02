import type { Pool, PoolClient } from "pg";
import { PlatformError, agentConfigurationSchema, terminalTaskStates } from "../contracts/contracts";
import { loadExecution, assertCurrentAuthority, requestTreeCancellationInTransaction } from "../execution/lifecycle/execution";
import type { ToolDefinition } from "../execution/business/model";
import { transaction } from "../infrastructure/database";
import { validateBuiltinArguments } from "./tool-contracts";

type Execution = Awaited<ReturnType<typeof loadExecution>>;
type Name = "tasks.inspect" | "tasks.cancel";
const denied = () => new PlatformError("TASK_CONTROL_SCOPE_DENIED", 403, "Task control is unavailable");

async function authorize(db: Pool | PoolClient, execution: Execution, name: Name) {
  const { task } = execution;
  if (task.product !== "agents" || task.caller_client_id !== "agents-execution" || task.principal.kind !== "human" ||
      task.parent_task_id || task.root_task_id !== task.id || task.channel_binding || task.evaluation_trial_id ||
      task.resource_id !== execution.agentId || task.execution_purpose !== "business_v1") throw denied();
  await assertCurrentAuthority(db, execution);
  const current = (await db.query(`SELECT v.configuration FROM agents_platform.agents a
    JOIN LATERAL (SELECT configuration FROM agents_platform.agent_versions WHERE organization_id=a.organization_id AND agent_id=a.id ORDER BY number DESC LIMIT 1) v ON true
    WHERE a.organization_id=$1 AND a.id=$2 AND a.deleted_at IS NULL FOR SHARE OF a`, [task.organization_id, execution.agentId])).rows[0];
  const grant = (await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1 AND revoked_at IS NULL AND expires_at>now() FOR SHARE", [task.grant_id])).rows[0];
  if (!execution.configuration.tools.includes(name) || !current || !agentConfigurationSchema.parse(current.configuration).tools.includes(name) ||
      !grant?.operations.includes(name === "tasks.inspect" ? "tasks.read" : "tasks.cancel")) throw denied();
}

export async function visibleTaskControlTools(pool: Pool, execution: Execution, tools: ToolDefinition[]): Promise<ToolDefinition[]> {
  const permitted = new Set<string>();
  for (const [alias, name] of [["tasks_inspect", "tasks.inspect"], ["tasks_cancel", "tasks.cancel"]] as const) {
    if (!tools.some(tool => tool.function.name === alias)) continue;
    try { await authorize(pool, execution, name); permitted.add(alias); }
    catch (error) { if (!(error instanceof PlatformError)) throw error; }
  }
  return tools.filter(tool => !["tasks_inspect", "tasks_cancel"].includes(tool.function.name) || permitted.has(tool.function.name));
}

export async function executeTaskControlTool(pool: Pool, taskId: string, _operationId: string, name: Name, input: unknown) {
  const args = validateBuiltinArguments(name, input) as { taskId?: string; limit?: number };
  const initial = await loadExecution(pool, taskId);
  return transaction(pool, async db => {
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [initial.task.organization_id]);
    const execution = await loadExecution(db, taskId, true);
    await authorize(db, execution, name);
    const { task } = execution;
    const targets = (await db.query(`SELECT t.id,t.state,t.created_at,t.updated_at FROM agents_platform.tasks t
      JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.organization_id=t.organization_id
      JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.organization_id=t.organization_id
      WHERE t.organization_id=$1 AND v.agent_id=$2 AND t.principal=$3::jsonb AND t.product='agents' AND t.caller_client_id='agents-execution'
        AND t.resource_id=$2::text AND t.parent_task_id IS NULL AND t.root_task_id=t.id AND t.channel_binding IS NULL
        AND t.evaluation_trial_id IS NULL AND t.execution_purpose='business_v1' AND c.deleted_at IS NULL AND t.created_at<$4
        AND ($5::uuid IS NULL OR t.id=$5) ORDER BY t.created_at DESC,t.id DESC LIMIT $6 FOR NO KEY UPDATE OF t`,
    [task.organization_id, execution.agentId, JSON.stringify(task.principal), task.created_at, args.taskId ?? null, args.limit ?? 10])).rows;
    if (name === "tasks.inspect") return { tasks: targets.map(target => ({ id: target.id, state: target.state,
      createdAt: target.created_at.toISOString(), updatedAt: target.updated_at.toISOString() })) };
    const target = targets[0];
    if (!target) throw new PlatformError("TASK_NOT_FOUND", 404, "Task not found");
    if (terminalTaskStates.has(target.state)) return { taskId: target.id, state: "already_terminal", taskState:target.state };
    await requestTreeCancellationInTransaction(db, target.id);
    return { taskId: target.id, state: "cancel_requested", taskState:"cancel_requested" };
  });
}
