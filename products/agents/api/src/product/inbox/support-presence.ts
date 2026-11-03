import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { PlatformError } from "../../contracts/contracts";

export { aggregateSupportPresence, type StaffAvailability } from "../../capabilities/support-status-v2";
export const PRESENCE_LEASE_SECONDS = 120;
export async function setSupportPresence(db: Pool | PoolClient, organizationId: string, accountId: string, state: "available" | "away") {
  const leaseId=randomUUID();
  const row=(await db.query(`INSERT INTO agents_platform.support_presence(organization_id,account_id,state,lease_id,expires_at,updated_at)
    SELECT m.organization_id,m.account_id,$3,$4,clock_timestamp()+$5*interval '1 second',clock_timestamp()
    FROM agents_platform.memberships m WHERE m.organization_id=$1 AND m.account_id=$2 AND m.revoked_at IS NULL
    ON CONFLICT(organization_id,account_id) DO UPDATE SET state=excluded.state,lease_id=excluded.lease_id,expires_at=excluded.expires_at,updated_at=excluded.updated_at
    RETURNING state,lease_id,expires_at`,[organizationId,accountId,state,leaseId,PRESENCE_LEASE_SECONDS])).rows[0];
  if(!row)throw new PlatformError("INBOX_ACCESS_DENIED",403,"Conversation access denied");
  return {state:row.state,leaseId:row.lease_id,expiresAt:row.expires_at};
}
export async function renewSupportPresence(db: Pool | PoolClient, organizationId: string, accountId: string, leaseId: string) {
  const row=(await db.query(`UPDATE agents_platform.support_presence p SET expires_at=clock_timestamp()+$4*interval '1 second',updated_at=clock_timestamp()
    WHERE p.organization_id=$1 AND p.account_id=$2 AND p.lease_id=$3 AND p.state='available' AND p.expires_at>clock_timestamp()
      AND EXISTS(SELECT 1 FROM agents_platform.memberships m WHERE m.organization_id=p.organization_id AND m.account_id=p.account_id AND m.revoked_at IS NULL)
    RETURNING state,lease_id,expires_at`,[organizationId,accountId,leaseId,PRESENCE_LEASE_SECONDS])).rows[0];
  if(!row)throw new PlatformError("PRESENCE_EXPIRED",409,"Availability expired");
  return {state:row.state,leaseId:row.lease_id,expiresAt:row.expires_at};
}
export async function readSupportPresence(db: Pool | PoolClient, organizationId:string, accountId:string) {
  const row=(await db.query(`SELECT p.state,p.expires_at FROM agents_platform.memberships m LEFT JOIN agents_platform.support_presence p
    ON p.organization_id=m.organization_id AND p.account_id=m.account_id AND p.expires_at>clock_timestamp()
    WHERE m.organization_id=$1 AND m.account_id=$2 AND m.revoked_at IS NULL`,[organizationId,accountId])).rows[0];
  if(!row)throw new PlatformError("INBOX_ACCESS_DENIED",403,"Conversation access denied");
  return {state:row.state ?? "unknown",expiresAt:row.expires_at ?? null};
}
