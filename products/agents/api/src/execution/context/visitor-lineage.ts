import type { Pool, PoolClient } from "pg";
import type { Execution } from "../../contracts/execution";
import { requestDigest } from "../../contracts/contracts";
import { channelPorts } from "../../infrastructure/channel-ports";

export async function historyPrincipalAllowed(db: Pool | PoolClient, current: Execution, origin: Execution): Promise<boolean> {
  if (requestDigest(current.task.principal) === requestDigest(origin.task.principal)) return true;
  const consumer = current.task, prior = origin.task;
  if (consumer.product !== "agents" || prior.product !== "agents" || consumer.principal.kind !== "visitor" || prior.principal.kind !== "visitor" ||
    consumer.parent_task_id || prior.parent_task_id || !consumer.channel_binding || !prior.channel_binding ||
    consumer.organization_id !== prior.organization_id || consumer.conversation_id !== prior.conversation_id || current.agentId !== origin.agentId ||
    consumer.channel_binding.customerConversationId !== prior.channel_binding.customerConversationId) return false;
  return await channelPorts(db).visitorLineage?.(db, { organizationId: consumer.organization_id, agentId: current.agentId,
    executionConversationId: consumer.conversation_id, customerConversationId: consumer.channel_binding.customerConversationId,
    current: consumer.principal, origin: prior.principal, originTaskId: prior.id }) ?? false;
}

export async function currentVisitorLineageAllowed(db: Pool | PoolClient, execution: Execution): Promise<boolean> {
  const task = execution.task;
  if (task.product !== "agents" || task.principal.kind !== "visitor" || !task.channel_binding) return true;
  const original = (await db.query("SELECT principal FROM agents_platform.conversations WHERE id=$1 AND organization_id=$2 AND agent_id=$3 AND deleted_at IS NULL", [task.conversation_id,task.organization_id,execution.agentId])).rows[0]?.principal;
  if (requestDigest(original ?? null) === requestDigest(task.principal)) return true;
  if (original?.kind !== "visitor") return false;
  return await channelPorts(db).visitorLineage?.(db, { organizationId: task.organization_id, agentId: execution.agentId,
    executionConversationId: task.conversation_id, customerConversationId: task.channel_binding.customerConversationId,
    current: task.principal, origin: original }) ?? false;
}
