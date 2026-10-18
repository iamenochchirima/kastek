import type { Pool,PoolClient } from "pg";
import {
agentConfigurationSchema,
assertRuntimeAvailable,
PlatformError
} from "../../contracts/contracts";

import { capabilityBindingSchema } from "../../contracts/capability-catalog";
import { assertComposition } from "../programs/composition";
import { compilePublishedComposition } from "../programs/publication";
export { transaction } from "../../infrastructure/database";

import { HARNESS_RELEASE,type Execution } from "../../contracts/execution";
export async function loadExecution(db: Pool | PoolClient, taskId: string, lock = false): Promise<Execution> {
  const task = (await db.query(`SELECT t.*,v.configuration,v.agent_id,v.tool_bindings,v.effective_composition AS published_composition FROM agents_platform.tasks t
    JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.organization_id=t.organization_id
    WHERE t.id=$1 ${lock ? "FOR UPDATE OF t" : ""}`, [taskId])).rows[0];
  if (!task) throw new PlatformError("TASK_NOT_FOUND", 404, "Task not found");
  if (task.harness_release !== HARNESS_RELEASE) throw new PlatformError("HARNESS_RELEASE_UNAVAILABLE", 503, "Execution release is unavailable");
  const configuration = agentConfigurationSchema.parse(task.effective_configuration ?? task.configuration); assertRuntimeAvailable(configuration);
  const rows = configuration.connectedToolBindingIds.length ? (await db.query(`SELECT b.binding FROM agents_platform.version_connected_tools v
    JOIN agents_platform.capability_bindings b ON b.id=v.binding_id AND b.organization_id=v.organization_id
    WHERE v.organization_id=$1 AND v.version_id=$2 AND b.id=ANY($3::uuid[]) ORDER BY b.alias`, [task.organization_id, task.version_id, configuration.connectedToolBindingIds])).rows : [];
  if (rows.length !== configuration.connectedToolBindingIds.length) throw new PlatformError("CAPABILITY_BINDING_UNAVAILABLE", 409, "Published connected tools are unavailable");
  const connectedBindings = rows.map(row => capabilityBindingSchema.parse(row.binding));
  const current = compilePublishedComposition(configuration, connectedBindings);
  assertComposition(task.effective_composition, current);
  if (!task.parent_task_id) assertComposition(task.published_composition, current);
  return { task, configuration, agentId: task.agent_id,toolBindings:task.tool_bindings, connectedBindings };
}
