import type { Pool, PoolClient } from "pg";
import type { Execution } from "../../contracts/execution";
import { canonicalJson } from "../../contracts/contracts";

/** Root continuations and specialist follow-ups retain separate immutable prior-link contracts. */
export async function continuationBranchTaskIds(db:Pool|PoolClient,current:Execution):Promise<string[]> {
  const recursive=current.task.harness_release==="product-capabilities-v15";
  return (await db.query(`WITH RECURSIVE branch AS (
      SELECT t.id,t.prior_task_id,d.prior_task_id AS specialist_prior_task_id,ARRAY[t.id] AS path
      FROM agents_platform.tasks t LEFT JOIN agents_platform.delegations d ON d.child_task_id=t.id WHERE t.id=$1
      UNION ALL SELECT p.id,p.prior_task_id,pd.prior_task_id,b.path||p.id
      FROM branch b JOIN agents_platform.tasks p ON p.id=coalesce(b.prior_task_id,CASE WHEN $2 THEN b.specialist_prior_task_id END)
      JOIN agents_platform.tasks head ON head.id=$1
      LEFT JOIN agents_platform.delegations pd ON pd.child_task_id=p.id
      WHERE NOT p.id=ANY(b.path) AND p.organization_id=head.organization_id AND p.work_id=head.work_id
        AND p.version_id=head.version_id AND p.conversation_id=head.conversation_id AND p.principal=head.principal
        AND p.product=head.product AND p.resource_id=head.resource_id AND p.caller_client_id=head.caller_client_id
        AND p.parent_task_id IS NOT DISTINCT FROM head.parent_task_id AND p.depth=head.depth
        AND (head.parent_task_id IS NULL OR p.root_task_id=head.root_task_id)
        AND p.state IN ('completed','incomplete','refused','failed','cancelled','uncertain')
        AND (p.parent_task_id IS NOT NULL OR p.state IN ('incomplete','failed'))
    ) SELECT id FROM branch`,[current.task.id,recursive])).rows.map(row=>row.id);
}

/** Reading a prior branch's selected child never grants control over that child. */
export async function continuationChildAllowed(db: Pool | PoolClient, current: Execution, origin: Execution): Promise<boolean> {
  const task=current.task,child=origin.task;
  if(!child.parent_task_id||child.parent_task_id===task.id||task.work_id!==child.work_id||task.organization_id!==child.organization_id||
    task.product!==child.product||canonicalJson(task.principal)!==canonicalJson(child.principal)||!current.configuration.capabilities.delegation.enabled)return false;
  if(task.harness_release!=="product-capabilities-v15"&&(task.parent_task_id||!task.prior_task_id||child.parent_task_id!==child.root_task_id))return false;
  if(!(await continuationBranchTaskIds(db,current)).includes(child.parent_task_id))return false;
  const delegation=(await db.query("SELECT binding_id FROM agents_platform.delegations WHERE child_task_id=$1 AND parent_task_id=$2",[child.id,child.parent_task_id])).rows[0];
  return Boolean(delegation&&current.configuration.capabilities.delegation.bindings.some(binding=>binding.id===delegation.binding_id&&binding.versionId===child.version_id));
}
