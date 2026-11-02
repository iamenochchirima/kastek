import type { Pool, PoolClient } from "pg";
import { supportStatus } from "./support-status";
import { nextSupportOpening } from "../product/inbox/support-waiting";
import { aggregateSupportPresence } from "../product/inbox/support-presence";

/** Live presence is independent of configured hours and never includes staff identities. */
export async function supportStatusV2(db:Pool|PoolClient,organizationId:string,hours:unknown,now:Date=new Date()) {
  const status=supportStatus(hours,now);
  const candidate=status.hours.state==="closed" ? nextSupportOpening(hours,now) : null;
  const nextOpening=candidate && supportStatus(hours,candidate).hours.state==="open" ? candidate.toISOString() : null;
  return { ...status, nextOpening, staffAvailability:await aggregateSupportPresence(db,organizationId) };
}
