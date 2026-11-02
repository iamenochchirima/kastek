import {isIP} from "node:net";
import {publicAddress} from "../../infrastructure/connected-network";
import {PlatformError} from "../../contracts/contracts";
import type { NetworkAttempt } from "../../infrastructure/connected-network";

export interface CalendarSummary { id:string; name:string; timeZone:string; role:"owner"|"writer" }
export interface BookingIntent { organizationId:string; bookingId:string; calendarId:string; start:string; end:string; timeZone:string; summary:string; requestDigest:string }
export type BookingResult = {state:"confirmed";eventId:string;start:string;end:string;receiptDigest:string;htmlLink?:string}
  | {state:"uncertain";eventId:string;reason:string;receiptDigest?:string};
export interface CalendarOptions {
  deadlineAt:number;signal?:AbortSignal;testBaseUrl?:string;apiBaseUrl?:string;
  beforeAttempt?(operation:"calendars"|"freebusy"|"insert"|"reconcile"):Promise<void>;
  onAttempt?(attempt:NetworkAttempt):Promise<void>;
}
export interface CalendarClient {
  listCalendars():Promise<{items:CalendarSummary[]}>;
  freeBusy(calendarId:string,range:{start:string;end:string}):Promise<{start:string;end:string;busy:{start:string;end:string}[]}>;
  createBooking(intent:BookingIntent):Promise<BookingResult>;
  reconcileBooking(intent:BookingIntent):Promise<BookingResult>;
}

/** Called only with operator-reviewed native-provider records, never model arguments. */
export function calendarApiBase(value:string):string {
  const url=new URL(value),hostname=url.hostname.replace(/^\[|\]$/g,"").replace(/\.$/,"").toLowerCase();
  if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||(url.port&&url.port!=="443")||hostname==="localhost"||/\.(localhost|local|internal)$/.test(hostname)||isIP(hostname)&&!publicAddress(hostname))throw new PlatformError("CALENDAR_ENDPOINT_INVALID",400,"Invalid reviewed calendar endpoint");
  return url.href.replace(/\/$/,"");
}
