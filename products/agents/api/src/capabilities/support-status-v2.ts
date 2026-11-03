import type { Pool, PoolClient } from "pg";
import { supportStatus, nextSupportOpening } from "./support-status";

/** Live presence is independent of configured hours and never includes staff identities. */
export async function supportStatusV2(db:Pool|PoolClient,organizationId:string,hours:unknown,now:Date=new Date()) {
  const status=supportStatus(hours,now);
  const candidate=status.hours.state==="closed" ? nextSupportOpening(hours,now) : null;
  const nextOpening=candidate && supportStatus(hours,candidate).hours.state==="open" ? candidate.toISOString() : null;
  return { ...status, nextOpening, staffAvailability:await aggregateSupportPresence(db,organizationId) };
}

export type StaffAvailability = "available" | "away" | "unknown";
export async function aggregateSupportPresence(db: Pool | PoolClient, organizationId: string): Promise<StaffAvailability> {
  const row = (await db.query(`SELECT count(*)::int members,
    count(*) FILTER (WHERE p.expires_at>clock_timestamp() AND p.state='available')::int available,
    count(*) FILTER (WHERE p.expires_at>clock_timestamp() AND p.state='away')::int away
    FROM agents_platform.memberships m LEFT JOIN agents_platform.support_presence p
      ON p.organization_id=m.organization_id AND p.account_id=m.account_id
    WHERE m.organization_id=$1 AND m.revoked_at IS NULL`, [organizationId])).rows[0];
  if (row.available > 0) return "available";
  return row.members > 0 && row.away === row.members ? "away" : "unknown";
}
