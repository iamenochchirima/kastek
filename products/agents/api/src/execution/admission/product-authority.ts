import type { Pool, PoolClient } from "pg";
import { PlatformError, type AdmissionAuthority } from "../../contracts/contracts";

export async function assertProductAuthority(db: Pool | PoolClient, authority: AdmissionAuthority, versionId: string, grantId?: string): Promise<void> {
  if(authority.product === "agents") throw new PlatformError("PRODUCT_SCOPE_DENIED",403,"A delegated product identity is required");
  const allowed = await db.query(`SELECT 1 FROM agents_platform.product_execution_authorities a
    JOIN agents_platform.product_execution_tenants p ON p.product=a.product AND p.organization_id=a.organization_id AND p.client_id=a.client_id AND p.issuer=a.issuer
    JOIN agents_platform.execution_grants g ON g.id=a.grant_id
    WHERE a.product=$1 AND a.organization_id=$2 AND a.client_id=$3 AND p.revoked_at IS NULL
      AND g.resource_id=$4 AND g.principal=$5::jsonb AND g.version_id=$6 AND g.revoked_at IS NULL AND ($7::uuid IS NULL OR g.expires_at>now())
      AND ($7::uuid IS NULL OR g.id=$7) FOR SHARE OF a,p,g`,
  [authority.product,authority.organizationId,authority.callerClientId,authority.resourceId,JSON.stringify(authority.principal),versionId,grantId??null]);
  if(!allowed.rowCount) throw new PlatformError("PRODUCT_AUTHORITY_INACTIVE",403,"Delegated product authority is unavailable");
}
