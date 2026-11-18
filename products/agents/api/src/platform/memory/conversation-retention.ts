import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { transaction } from "../../infrastructure/database";
import { requestTreeCancellationInTransaction } from "../../execution/lifecycle/execution";
import { forgetConversationMemoriesInTransaction } from "./retention";

/** Maintenance-only configuration; absence of a policy means no automatic expiry. */
export async function configureConversationRetention(pool: Pool, organizationId: string, days: 90 | null, operator: string): Promise<void> {
  if (days !== null && days !== 90) throw new Error("Conversation inactivity must be 90 days or disabled");
  if(!/^[a-zA-Z0-9@_.:-]{1,128}$/.test(operator))throw new Error("Named maintenance operator required");
  await transaction(pool,async db=>{
    await db.query(`INSERT INTO agents_platform.conversation_retention_policies(organization_id,inactivity_days) VALUES($1,$2)
      ON CONFLICT(organization_id) DO UPDATE SET inactivity_days=excluded.inactivity_days,updated_at=now()`,[organizationId,days]);
    await db.query("INSERT INTO agents_platform.conversation_retention_policy_events(id,organization_id,inactivity_days,operator) VALUES($1,$2,$3,$4)",[randomUUID(),organizationId,days,operator]);
  });
}

export async function expireInactiveConversations(pool: Pool, limit = 20): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid retention batch");
  const candidates=(await pool.query(`SELECT c.id,c.organization_id FROM agents_platform.conversations c
    JOIN agents_platform.conversation_retention_policies p ON p.organization_id=c.organization_id AND p.inactivity_days=90
    WHERE c.deleted_at IS NULL AND NOT c.retention_hold
      AND greatest(c.created_at,coalesce((SELECT max(greatest(t.created_at,t.updated_at)) FROM agents_platform.tasks t WHERE t.conversation_id=c.id),c.created_at))<now()-interval '90 days'
      AND NOT EXISTS(SELECT 1 FROM agents_platform.customer_conversations customer WHERE customer.execution_conversation_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM agents_platform.tasks t WHERE t.root_task_id IN
        (SELECT root_task_id FROM agents_platform.tasks WHERE conversation_id=c.id)
        AND t.state NOT IN ('completed','incomplete','failed','cancelled','refused'))
      AND NOT EXISTS(SELECT 1 FROM agents_platform.operations o JOIN agents_platform.tasks t ON t.id=o.task_id
        WHERE t.root_task_id IN (SELECT root_task_id FROM agents_platform.tasks WHERE conversation_id=c.id)
          AND o.state IN ('started','uncertain'))
    ORDER BY c.created_at,c.id LIMIT $1`,[limit])).rows;
  let changed=0;
  for(const candidate of candidates)await transaction(pool,async db=>{
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR NO KEY UPDATE",[candidate.organization_id]);
    const tasks=(await db.query("SELECT id,state FROM agents_platform.tasks WHERE conversation_id=$1 ORDER BY id FOR NO KEY UPDATE",[candidate.id])).rows;
    const current=(await db.query(`SELECT c.id FROM agents_platform.conversations c
      JOIN agents_platform.conversation_retention_policies p ON p.organization_id=c.organization_id AND p.inactivity_days=90
      WHERE c.id=$1 AND c.deleted_at IS NULL AND NOT c.retention_hold
      AND greatest(c.created_at,coalesce((SELECT max(greatest(t.created_at,t.updated_at)) FROM agents_platform.tasks t WHERE t.conversation_id=c.id),c.created_at))<now()-interval '90 days'
      AND NOT EXISTS(SELECT 1 FROM agents_platform.customer_conversations customer WHERE customer.execution_conversation_id=c.id)
      FOR UPDATE OF c`,[candidate.id])).rows[0];
    if(!current||tasks.some(task=>!["completed","incomplete","failed","cancelled","refused"].includes(task.state)))return;
    if((await db.query(`SELECT 1 FROM agents_platform.operations o JOIN agents_platform.tasks t ON t.id=o.task_id
      WHERE t.root_task_id IN (SELECT root_task_id FROM agents_platform.tasks WHERE conversation_id=$1)
        AND o.state IN ('started','uncertain') LIMIT 1`,[candidate.id])).rowCount)return;
    if((await db.query(`SELECT 1 FROM agents_platform.tasks WHERE root_task_id IN
      (SELECT root_task_id FROM agents_platform.tasks WHERE conversation_id=$1)
      AND state NOT IN ('completed','incomplete','failed','cancelled','refused') LIMIT 1`,[candidate.id])).rowCount)return;
    for(const task of tasks)await requestTreeCancellationInTransaction(db,task.id);
    await db.query("UPDATE agents_platform.conversations SET deleted_at=now() WHERE id=$1",[candidate.id]);
    await forgetConversationMemoriesInTransaction(db,candidate.id);
    changed++;
  });
  return changed;
}
