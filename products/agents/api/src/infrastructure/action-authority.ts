import type { Pool,PoolClient } from "pg";
import type { ActionScope } from "../contracts/connections";
import { PlatformError } from "../contracts/contracts";
export const actionMissing=()=>new PlatformError("ACTION_NOT_FOUND",404,"Action not found");
export async function requireActionMember(db:Pool|PoolClient,scope:ActionScope){
 if(!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE account_id=$1 AND organization_id=$2 AND revoked_at IS NULL FOR SHARE",[scope.accountId,scope.organizationId])).rowCount)throw new PlatformError("ACCESS_DENIED",403,"Workspace access is unavailable");
}
export async function notifyActionTask(db:PoolClient,taskId:string){
 const row=(await db.query("UPDATE agents_platform.tasks SET control_generation=control_generation+1,updated_at=now() WHERE id=$1 RETURNING control_generation-1 AS generation",[taskId])).rows[0];
 if(row)await db.query("INSERT INTO agents_platform.task_controls(task_id,generation,kind) VALUES($1,$2,'review') ON CONFLICT DO NOTHING",[taskId,row.generation]);
}
