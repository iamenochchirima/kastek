import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { PlatformError,requestDigest,calendarOperationsSchema } from "../../contracts/contracts";

export const bookingPolicySchema=z.strictObject({
  permittedOperations:calendarOperationsSchema,
  providerId:z.string().min(1).max(100),ownerAccountId:z.uuid(),connectionId:z.uuid(),connectionPolicyRevision:z.number().int().positive(),
  calendarId:z.string().min(1).max(1024),timeZone:z.string().min(1).max(128).refine(value=>{try{new Intl.DateTimeFormat("en",{timeZone:value});return true;}catch{return false;}}),
  title:z.string().trim().min(1).max(120),durationMinutes:z.number().int().min(5).max(240),
  minimumNoticeMinutes:z.number().int().min(0).max(10080),maximumAdvanceDays:z.number().int().min(1).max(90),
  days:z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(days=>new Set(days).size===days.length),
  opensAt:z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),closesAt:z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
}).refine(value=>value.opensAt<value.closesAt,"Opening time must precede closing time");
export type BookingPolicy=z.infer<typeof bookingPolicySchema>;
export interface BookingReference {enabled:true;profileId:"calendar-booking-v1";policyId:string;policyDigest:string;permittedOperations?:Array<"calendar.availability"|"calendar.book">}
export function bookingWindow(policy:BookingPolicy,start:string,now=Date.now()) {
  const startsAt=new Date(z.iso.datetime({offset:true}).parse(start)),endsAt=new Date(startsAt.getTime()+policy.durationMinutes*60000);
  if(startsAt.getTime()<now+policy.minimumNoticeMinutes*60000||endsAt.getTime()>now+policy.maximumAdvanceDays*86400000)
    throw new PlatformError("BOOKING_WINDOW_DENIED",409,"Choose a time within the booking window");
  const formatter=new Intl.DateTimeFormat("en-US",{timeZone:policy.timeZone,weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit"});
  const parts=(date:Date)=>Object.fromEntries(formatter.formatToParts(date).map(part=>[part.type,part.value]));
  const from=parts(startsAt),to=parts(endsAt),day=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(from.weekday!);
  const [openHour,openMinute]=policy.opensAt.split(":").map(Number);
  if(startsAt.getUTCSeconds()!==0||startsAt.getUTCMilliseconds()!==0||(Number(from.hour)*60+Number(from.minute)-openHour!*60-openMinute!)%policy.durationMinutes!==0)throw new PlatformError("BOOKING_SLOT_INVALID",409,"Choose an offered appointment time");
  if(!policy.days.includes(day)||`${from.hour}:${from.minute}`<policy.opensAt||`${to.hour}:${to.minute}`>policy.closesAt||from.day!==to.day||from.month!==to.month||from.year!==to.year)
    throw new PlatformError("BOOKING_HOURS_DENIED",409,"Choose a time during opening hours");
  return {start:startsAt.toISOString(),end:endsAt.toISOString()};
}

export async function loadBookingPolicy(db:Pool|PoolClient,organizationId:string,agentId:string,reference:BookingReference):Promise<BookingPolicy> {
  const row=(await db.query(`SELECT p.* FROM agents_platform.booking_policies p JOIN agents_platform.memberships m
    ON m.organization_id=p.organization_id AND m.account_id=p.owner_account_id AND m.revoked_at IS NULL AND m.role='owner'
    JOIN agents_platform.connections c ON c.id=(p.definition->>'connectionId')::uuid AND c.organization_id=p.organization_id AND c.account_id=p.owner_account_id
    JOIN agents_platform.native_provider_connections g ON g.connection_id=c.id
    WHERE p.id=$1 AND p.organization_id=$2 AND p.agent_id=$3 AND p.state='active' AND c.state='active' AND c.expires_at>now()
    AND c.policy_revision=(p.definition->>'connectionPolicyRevision')::integer AND g.status='ready' AND g.sharing='organization_service'
    AND g.selected_calendar->>'id'=p.definition->>'calendarId' AND g.provider_id=p.definition->>'providerId' FOR SHARE OF p,m,c,g`,[reference.policyId,organizationId,agentId])).rows[0];
  if(!row||row.digest!==reference.policyDigest||requestDigest(row.definition)!==row.digest)throw new PlatformError("BOOKING_POLICY_UNAVAILABLE",403,"The published booking permission is unavailable");
  const policy=bookingPolicySchema.parse(row.definition),requested=reference.permittedOperations??["calendar.availability","calendar.book"];
  if(requestDigest([...requested].sort())!==requestDigest([...policy.permittedOperations].sort()))throw new PlatformError("BOOKING_POLICY_UNAVAILABLE",403,"Calendar actions do not match the published policy");
  const current=(await db.query("SELECT selected_operations FROM agents_platform.native_provider_connections WHERE connection_id=$1 FOR SHARE",[policy.connectionId])).rows[0];
  if(!current||policy.permittedOperations.some(operation=>!current.selected_operations.includes(operation)&&!(operation==="calendar.availability"&&current.selected_operations.includes("calendar.book"))))throw new PlatformError("BOOKING_POLICY_UNAVAILABLE",403,"Calendar actions are no longer permitted");
  return policy;
}
