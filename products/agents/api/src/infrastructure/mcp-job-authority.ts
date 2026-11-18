import type {Pool,PoolClient} from "pg";
import {PlatformError} from "../contracts/contracts";

export async function assertMcpJobAuthority(db:Pool|PoolClient, row:{mcp_connection_id?:string|null;organization_id:string;account_id?:string|null;importer_account_id?:string|null}) {
 if(!row.mcp_connection_id)return;
 const accountId=row.account_id??row.importer_account_id;
 const found=await db.query(`SELECT 1 FROM agents_platform.mcp_oauth_connections c JOIN agents_platform.memberships m ON m.account_id=c.account_id AND m.organization_id=c.organization_id
 WHERE c.id=$1 AND c.organization_id=$2 AND c.account_id=$3 AND c.revoked_at IS NULL AND 'agents:manage'=ANY(c.scopes) AND m.revoked_at IS NULL FOR SHARE OF c,m`,[row.mcp_connection_id,row.organization_id,accountId]);
 if(!found.rowCount)throw new PlatformError("ACCESS_DENIED",403,"Connection access is unavailable");
}

export async function assertMcpTaskAuthority(db:Pool|PoolClient,taskId:string) {
 const row=(await db.query<{mcp_connection_id:string;organization_id:string;account_id:string}>("SELECT connection_id mcp_connection_id,organization_id,account_id FROM agents_platform.mcp_run_provenance WHERE task_id=$1",[taskId])).rows[0];
 if(row)await assertMcpJobAuthority(db,row);
}
