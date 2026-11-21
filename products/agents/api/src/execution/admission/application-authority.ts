import type { Pool, PoolClient } from "pg";
import { PlatformError, type AdmissionAuthority } from "../../contracts/contracts";

/** The application owns the conversation; the initiating key authorizes the run. */
export async function assertApplicationAuthority(db: Pool | PoolClient, authority: AdmissionAuthority, agentId: string, credentialId: string | null): Promise<void> {
  const principal = authority.principal;
  if (authority.product !== "agents" || authority.callerClientId !== "agents-application" ||
      principal.kind !== "application" || authority.resourceId !== agentId) {
    throw new PlatformError("ACCESS_DENIED", 403, "Application access is unavailable");
  }
  const result = await db.query(`SELECT 1 FROM agents_platform.applications a
    JOIN agents_platform.application_credentials k ON k.application_id=a.id AND k.organization_id=a.organization_id
    JOIN agents_platform.agents agent ON agent.organization_id=a.organization_id AND agent.id=$4 AND agent.deleted_at IS NULL
    WHERE a.organization_id=$1 AND a.id=$2 AND k.id=$3 AND a.revoked_at IS NULL AND k.revoked_at IS NULL
      AND $4::uuid=ANY(a.agent_ids) AND 'runs:start'=ANY(k.scopes) FOR SHARE OF a,k,agent`,
  [authority.organizationId, principal.applicationId, credentialId, agentId]);
  if (!result.rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Application access is unavailable");
}

/** Historical turns belong to the application, not to a key that may later be rotated. */
export async function assertApplicationHistoryAccess(db: Pool | PoolClient, authority: AdmissionAuthority, agentId: string): Promise<void> {
  const principal = authority.principal;
  if (authority.product !== "agents" || authority.callerClientId !== "agents-application" ||
      principal.kind !== "application" || authority.resourceId !== agentId) throw new PlatformError("ACCESS_DENIED", 403, "Application access is unavailable");
  const result = await db.query(`SELECT 1 FROM agents_platform.applications a JOIN agents_platform.agents agent
    ON agent.organization_id=a.organization_id AND agent.id=$3 AND agent.deleted_at IS NULL
    WHERE a.organization_id=$1 AND a.id=$2 AND a.revoked_at IS NULL AND $3::uuid=ANY(a.agent_ids) FOR SHARE OF a,agent`,
  [authority.organizationId, principal.applicationId, agentId]);
  if (!result.rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Application access is unavailable");
}
