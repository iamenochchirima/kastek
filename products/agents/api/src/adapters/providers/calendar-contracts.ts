import type { NetworkAttempt } from "../../infrastructure/connected-network";

export interface CalendarSummary { id:string; name:string; timeZone:string; role:"owner"|"writer" }
export interface BookingIntent { organizationId:string; bookingId:string; calendarId:string; start:string; end:string; timeZone:string; summary:string; requestDigest:string }
export type BookingResult = {state:"confirmed";eventId:string;start:string;end:string;receiptDigest:string;htmlLink?:string}
  | {state:"uncertain";eventId:string;reason:string;receiptDigest?:string};
export interface CalendarOptions {
  deadlineAt:number;signal?:AbortSignal;testBaseUrl?:string;
  beforeAttempt?(operation:"calendars"|"freebusy"|"insert"|"reconcile"):Promise<void>;
  onAttempt?(attempt:NetworkAttempt):Promise<void>;
}
export interface CalendarClient {
  listCalendars():Promise<{items:CalendarSummary[]}>;
  freeBusy(calendarId:string,range:{start:string;end:string}):Promise<{start:string;end:string;busy:{start:string;end:string}[]}>;
  createBooking(intent:BookingIntent):Promise<BookingResult>;
  reconcileBooking(intent:BookingIntent):Promise<BookingResult>;
}
