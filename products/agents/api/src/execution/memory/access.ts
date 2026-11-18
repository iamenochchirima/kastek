import type { PoolClient } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import type { ManagementScope } from "../../contracts/memory";

const idSchema = z.uuid();
const schema = "agents_platform";
export async function requireMemoryAccess(db: PoolClient, scope: ManagementScope): Promise<void> {
  idSchema.parse(scope.accountId); idSchema.parse(scope.organizationId); idSchema.parse(scope.agentId);
  const access = await db.query(`SELECT 1 FROM ${schema}.memberships m JOIN ${schema}.agents a ON a.organization_id=m.organization_id
    WHERE m.organization_id=$1 AND m.account_id=$2 AND m.revoked_at IS NULL AND a.id=$3 FOR SHARE OF m`,
  [scope.organizationId, scope.accountId, scope.agentId]);
  if (!access.rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Access is unavailable");
}