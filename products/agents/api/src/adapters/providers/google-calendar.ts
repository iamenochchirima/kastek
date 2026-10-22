import {calendarApiBase} from "./calendar-contracts";
import {googleCalendarConnector} from "./connector-registry";
import { createHash } from "node:crypto";
import { z } from "zod";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { createBoundedFetch, type NetworkAttempt } from "../../infrastructure/connected-network";

export interface GoogleCalendarSummary { id:string; name:string; timeZone:string; role:"owner"|"writer" }
export interface GoogleBookingIntent { organizationId:string; bookingId:string; calendarId:string; start:string; end:string; timeZone:string; summary:string; requestDigest:string }
export type GoogleBookingResult = {state:"confirmed";eventId:string;start:string;end:string;receiptDigest:string;htmlLink?:string}
  | {state:"uncertain";eventId:string;reason:string;receiptDigest?:string};
export interface GoogleCalendarOptions {
  deadlineAt:number;signal?:AbortSignal;testBaseUrl?:string;apiBaseUrl?:string;
  beforeAttempt?(operation:"calendars"|"freebusy"|"insert"|"reconcile"):Promise<void>;
  onAttempt?(attempt:NetworkAttempt):Promise<void>;
}
const timestamp=z.iso.datetime({offset:true}), calendarId=z.string().min(1).max(1024).refine(v=>!/[\x00-\x1f\x7f]/.test(v));
const timeZone=z.string().min(1).max(128).refine(value=>{try{new Intl.DateTimeFormat("en",{timeZone:value});return true;}catch{return false;}});
const intentSchema=z.strictObject({organizationId:z.uuid(),bookingId:z.uuid(),calendarId,start:timestamp,end:timestamp,timeZone,
  summary:z.string().trim().min(1).max(256).refine(v=>!/[\x00-\x1f\x7f]/.test(v)),requestDigest:z.string().regex(/^[a-f0-9]{64}$/)})
  .refine(v=>Date.parse(v.end)>Date.parse(v.start)&&Date.parse(v.end)-Date.parse(v.start)<=86400000,"Booking interval must be positive and at most one day");
export function googleBookingEventId(organizationId:string,selectedCalendarId:string,bookingId:string):string {
  z.uuid().parse(organizationId);z.uuid().parse(bookingId);calendarId.parse(selectedCalendarId);
  return `k${createHash("sha256").update(JSON.stringify([organizationId,selectedCalendarId,bookingId])).digest("hex")}`;
}
const failure=(code:string,message:string)=>new PlatformError(code,502,message);
/** Fixed provider endpoints. The caller supplies current trusted authority before each physical request. */
export class GoogleCalendarClient {
  private readonly base:string;
  constructor(private readonly token:string,private readonly options:GoogleCalendarOptions) {
    if(!token||token.length>8192||/[\x00-\x20\x7f]/.test(token))throw failure("GOOGLE_TOKEN_INVALID","Google credentials are unavailable");
    this.base=options.testBaseUrl??calendarApiBase(options.apiBaseUrl??googleCalendarConnector.apiBaseUrl);
    if(options.testBaseUrl){const url=new URL(options.testBaseUrl);if(url.protocol!=="http:"||!["localhost","127.0.0.1","[::1]"].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw failure("GOOGLE_ENDPOINT_INVALID","Invalid provider test endpoint");}
  }
  private async request(operation:"calendars"|"freebusy"|"insert"|"reconcile",path:string,body?:unknown,admitted?:()=>void):Promise<{status:number;data:any;digest:string}> {
    const url=`${this.base}${path}`;
    const fetcher=createBoundedFetch({authorizeUrl:value=>value.href===url,headers:{authorization:`Bearer ${this.token}`},
      maxRequestBytes:16384,maxResponseBytes:262144,deadlineAt:this.options.deadlineAt,maxAttempts:1,maxRequests:1,
      testLoopback:!!this.options.testBaseUrl,signal:this.options.signal,returnProviderErrorResponses:true,
      beforeAttempt:async()=>{await this.options.beforeAttempt?.(operation);admitted?.();},onAttempt:this.options.onAttempt});
    const response=await fetcher(url,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const text=await response.text();if(text.includes(this.token))throw failure("GOOGLE_CREDENTIAL_REFLECTION","Provider reflected private credentials");
    let data:any;try{data=text?JSON.parse(text):{};}catch{throw failure("GOOGLE_RESPONSE_INVALID","Google returned an invalid response");}
    if(!data||typeof data!=="object"||Array.isArray(data))throw failure("GOOGLE_RESPONSE_INVALID","Google returned an invalid response");
    return {status:response.status,data,digest:requestDigest({status:response.status,data})};
  }
  async listCalendars():Promise<{items:GoogleCalendarSummary[]}> {
    const items:GoogleCalendarSummary[]=[],tokens=new Set<string>();let page:string|undefined;
    for(let index=0;index<10;index++){
      const query=new URLSearchParams({minAccessRole:"writer",maxResults:"100",showDeleted:"false",showHidden:"false",...(page?{pageToken:page}:{})});
      const response=await this.request("calendars",`/users/me/calendarList?${query}`);
      if(response.status!==200)throw failure("GOOGLE_CALENDAR_LIST_FAILED","Google calendars could not be loaded");
      const parsed=z.object({items:z.array(z.object({id:calendarId,summary:z.string().max(1024).optional(),timeZone,accessRole:z.string().max(64),deleted:z.boolean().optional()})).max(100).default([]),nextPageToken:z.string().min(1).max(4096).optional()}).parse(response.data);
      for(const item of parsed.items)if(!item.deleted&&(item.accessRole==="writer"||item.accessRole==="owner"))items.push({id:item.id,name:item.summary??item.id,timeZone:item.timeZone,role:item.accessRole});
      if(!parsed.nextPageToken)return {items};
      page=parsed.nextPageToken;if(tokens.has(page))break;tokens.add(page);
    }
    throw failure("GOOGLE_CALENDAR_LIST_LIMIT","Calendar list exceeds supported limits");
  }
  async freeBusy(selectedCalendarId:string,range:{start:string;end:string}):Promise<{start:string;end:string;busy:{start:string;end:string}[]}> {
    calendarId.parse(selectedCalendarId);timestamp.parse(range.start);timestamp.parse(range.end);
    if(Date.parse(range.end)<=Date.parse(range.start)||Date.parse(range.end)-Date.parse(range.start)>31*86400000)throw failure("GOOGLE_RANGE_INVALID","Availability range must be positive and at most 31 days");
    const response=await this.request("freebusy","/freeBusy",{timeMin:range.start,timeMax:range.end,calendarExpansionMax:1,groupExpansionMax:1,items:[{id:selectedCalendarId}]});
    if(response.status!==200)throw failure("GOOGLE_AVAILABILITY_FAILED","Google availability could not be checked");
    const calendar=response.data.calendars?.[selectedCalendarId];
    if(!calendar||!Array.isArray(calendar.busy)||calendar.errors?.length)throw failure("GOOGLE_AVAILABILITY_FAILED","Selected calendar availability could not be checked");
    const busy=z.array(z.object({start:timestamp,end:timestamp}).refine(v=>Date.parse(v.end)>Date.parse(v.start))).max(2000).parse(calendar.busy);
    return {...range,busy};
  }
  private confirmed(intent:GoogleBookingIntent,event:any,digest:string):GoogleBookingResult {
    const eventId=googleBookingEventId(intent.organizationId,intent.calendarId,intent.bookingId),metadata=event.extendedProperties?.private;
    const matches=event.id===eventId&&event.status==="confirmed"&&metadata?.kasitekOrganization===intent.organizationId&&metadata?.kasitekBooking===intent.bookingId&&metadata?.kasitekRequest===intent.requestDigest&&
      metadata?.kasitekIntent===requestDigest(intent)&&event.summary===intent.summary&&Date.parse(event.start?.dateTime)===Date.parse(intent.start)&&Date.parse(event.end?.dateTime)===Date.parse(intent.end)&&
      event.start?.timeZone===intent.timeZone&&event.end?.timeZone===intent.timeZone&&(!event.attendees||Array.isArray(event.attendees)&&event.attendees.length===0);
    if(!matches)return {state:"uncertain",eventId,reason:"EVENT_INTENT_MISMATCH",receiptDigest:digest};
    const link=typeof event.htmlLink==="string"&&event.htmlLink.startsWith("https://www.google.com/calendar/")?event.htmlLink:undefined;
    return {state:"confirmed",eventId,start:intent.start,end:intent.end,receiptDigest:digest,...(link?{htmlLink:link}:{})};
  }
  async reconcileBooking(raw:GoogleBookingIntent):Promise<GoogleBookingResult> {
    const intent=intentSchema.parse(raw),eventId=googleBookingEventId(intent.organizationId,intent.calendarId,intent.bookingId);
    try{const response=await this.request("reconcile",`/calendars/${encodeURIComponent(intent.calendarId)}/events/${eventId}`);
      return response.status===200?this.confirmed(intent,response.data,response.digest):{state:"uncertain",eventId,reason:response.status===404?"EVENT_NOT_OBSERVED":"RECONCILIATION_FAILED",receiptDigest:response.digest};
    }catch{return {state:"uncertain",eventId,reason:"RECONCILIATION_UNAVAILABLE"};}
  }
  async createBooking(raw:GoogleBookingIntent):Promise<GoogleBookingResult> {
    const intent=intentSchema.parse(raw),eventId=googleBookingEventId(intent.organizationId,intent.calendarId,intent.bookingId);
    const body={id:eventId,summary:intent.summary,start:{dateTime:intent.start,timeZone:intent.timeZone},end:{dateTime:intent.end,timeZone:intent.timeZone},
      extendedProperties:{private:{kasitekOrganization:intent.organizationId,kasitekBooking:intent.bookingId,kasitekRequest:intent.requestDigest,kasitekIntent:requestDigest(intent)}}};
    // A caller must durably record its single-send claim before invoking this method. Replays use reconcileBooking.
    let admitted=false;
    try{const response=await this.request("insert",`/calendars/${encodeURIComponent(intent.calendarId)}/events?sendUpdates=none`,body,()=>{admitted=true;});
      if(response.status===200||response.status===201)return this.confirmed(intent,response.data,response.digest);
      if(response.status!==409)return {state:"uncertain",eventId,reason:`INSERT_HTTP_${response.status}`,receiptDigest:response.digest};
    }catch(error){if(!admitted)throw error;}
    return this.reconcileBooking(intent);
  }
}
