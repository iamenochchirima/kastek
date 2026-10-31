import type { Pool, PoolClient } from "pg";
import type { Execution } from "../../contracts/execution";
import { canonicalJson } from "../../contracts/contracts";

/** Reading a prior specialist result never grants control over that specialist. */
export async function continuationChildAllowed(db: Pool | PoolClient, current: Execution, origin: Execution): Promise<boolean> {
  const root = current.task, child = origin.task;
  if (root.parent_task_id || !root.prior_task_id || !child.parent_task_id || child.parent_task_id !== child.root_task_id ||
      root.work_id !== child.work_id || root.organization_id !== child.organization_id || root.product !== child.product ||
      canonicalJson(root.principal) !== canonicalJson(child.principal) || !current.configuration.capabilities.delegation.enabled) return false;
  const row = (await db.query(`WITH RECURSIVE ancestors AS (
      SELECT p.* FROM agents_platform.tasks p WHERE p.id=$1
      UNION ALL SELECT p.* FROM agents_platform.tasks p JOIN ancestors a ON p.id=a.prior_task_id
    ) SELECT a.id,d.binding_id FROM ancestors a JOIN agents_platform.delegations d ON d.parent_task_id=a.id
    WHERE d.child_task_id=$2 AND a.id=$3 AND a.parent_task_id IS NULL AND a.work_id=$4
      AND a.organization_id=$5 AND a.version_id=$6 AND a.conversation_id=$7
      AND a.principal=$8::jsonb AND a.product=$9 AND a.resource_id=$10 AND a.caller_client_id=$11
      AND a.state IN ('incomplete','failed')`, [root.prior_task_id, child.id, child.parent_task_id,
    root.work_id, root.organization_id, root.version_id, root.conversation_id, JSON.stringify(root.principal), root.product,
    root.resource_id, root.caller_client_id])).rows[0];
  return Boolean(row && current.configuration.capabilities.delegation.bindings.some(binding =>
    binding.id === row.binding_id && binding.versionId === child.version_id));
}
