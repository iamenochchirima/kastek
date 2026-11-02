import { createServer,type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,it } from "vitest";
import { GoogleCalendarClient,googleBookingEventId,type GoogleBookingIntent } from "../src/adapters/providers/google-calendar";

describe("bounded Google Calendar provider",()=>{
  let server:Server,base:string,requests:{url:string;method:string;body:any}[]=[],event:any,mode="ok";
  const intent:GoogleBookingIntent={organizationId:randomUUID(),bookingId:randomUUID(),calendarId:"owner@example.test",start:"2026-10-20T10:00:00+02:00",end:"2026-10-20T10:30:00+02:00",timeZone:"Africa/Johannesburg",summary:"Consultation",requestDigest:"a".repeat(64)};
  beforeAll(async()=>{server=createServer(async(req,res)=>{let text="";for await(const part of req)text+=part;const body=text?JSON.parse(text):undefined;requests.push({url:req.url!,method:req.method!,body});res.setHeader("content-type","application/json");
    if(req.headers.authorization!=="Bearer fixture-private-token")throw Error("missing trusted token");
    if(req.url!.includes("calendarList")){res.end(JSON.stringify({items:[{id:intent.calendarId,summary:"Bookings",timeZone:intent.timeZone,accessRole:"owner"},{id:"read-only",summary:"Read",timeZone:"UTC",accessRole:"reader"}],...(mode==="pages"?{nextPageToken:"repeat"}:{})}));return;}
    if(req.url!.includes("freeBusy")){res.end(JSON.stringify({calendars:{[intent.calendarId]:mode==="denied"?{errors:[{reason:"notFound"}]}:{busy:[{start:intent.start,end:intent.end}]}}}));return;}
    if(req.method==="POST"){event={...body,status:"confirmed"};if(mode==="lost"){req.socket.destroy();return;}if(mode==="collision"){event={...body,status:"confirmed",summary:"Foreign booking"};res.statusCode=409;res.end("{}");return;}if(mode==="rate"){res.statusCode=429;res.end("{}");return;}res.statusCode=201;}
    if(mode==="missing"){res.statusCode=404;res.end("{}");return;}res.end(JSON.stringify(event??{}));
  });await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));base=`http://127.0.0.1:${(server.address() as any).port}/calendar/v3`;});
  afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});beforeEach(()=>{requests=[];event=undefined;mode="ok";});
  const client=(beforeAttempt?:ConstructorParameters<typeof GoogleCalendarClient>[1]["beforeAttempt"])=>new GoogleCalendarClient("fixture-private-token",{testBaseUrl:base,deadlineAt:Date.now()+5000,beforeAttempt});
  it("lists writable calendars and sends bounded provider query",async()=>{expect((await client().listCalendars()).items).toEqual([{id:intent.calendarId,name:"Bookings",timeZone:intent.timeZone,role:"owner"}]);expect(requests[0]!.url).toContain("minAccessRole=writer");});
  it("rejects cycling pagination",async()=>{mode="pages";await expect(client().listCalendars()).rejects.toMatchObject({code:"GOOGLE_CALENDAR_LIST_LIMIT"});expect(requests).toHaveLength(2);});
  it("queries only selected calendar and refuses calendar errors",async()=>{expect((await client().freeBusy(intent.calendarId,intent)).busy).toHaveLength(1);expect(requests[0]!.body.items).toEqual([{id:intent.calendarId}]);mode="denied";await expect(client().freeBusy(intent.calendarId,intent)).rejects.toMatchObject({code:"GOOGLE_AVAILABILITY_FAILED"});});
  it("rejects unbounded ranges and invalid input before any send",async()=>{await expect(client().freeBusy(intent.calendarId,{start:intent.start,end:"2027-01-01T00:00:00Z"})).rejects.toMatchObject({code:"GOOGLE_RANGE_INVALID"});await expect(client().createBooking({...intent,timeZone:"invalid"})).rejects.toThrow();expect(requests).toHaveLength(0);});
  it("creates one deterministic event with exact metadata and no invitations",async()=>{expect(await client().createBooking(intent)).toMatchObject({state:"confirmed",eventId:googleBookingEventId(intent.organizationId,intent.calendarId,intent.bookingId)});expect(requests).toHaveLength(1);expect(requests[0]!.url).toContain("sendUpdates=none");expect(event.attendees).toBeUndefined();expect(event.extendedProperties.private.kasitekRequest).toBe(intent.requestDigest);expect(event.id).toMatch(/^[a-v0-9]{5,1024}$/);});
  it("reconciles lost acknowledgement without a second insert",async()=>{mode="lost";expect(await client().createBooking(intent)).toMatchObject({state:"confirmed"});expect(requests.map(r=>r.method)).toEqual(["POST","GET"]);});
  it("refuses mismatching colliding events",async()=>{mode="collision";expect(await client().createBooking(intent)).toMatchObject({state:"uncertain",reason:"EVENT_INTENT_MISMATCH"});expect(requests.map(r=>r.method)).toEqual(["POST","GET"]);});
  it("never resends after rate limit or an absent reconciliation",async()=>{mode="rate";expect(await client().createBooking(intent)).toMatchObject({state:"uncertain",reason:"INSERT_HTTP_429"});expect(requests).toHaveLength(1);mode="missing";expect(await client().reconcileBooking(intent)).toMatchObject({state:"uncertain",reason:"EVENT_NOT_OBSERVED"});expect(requests.filter(r=>r.method==="POST")).toHaveLength(1);});
  it("checks authority before physical insertion and propagates rejection",async()=>{await expect(client(async()=>{throw Error("authority revoked");}).createBooking(intent)).rejects.toThrow("authority revoked");expect(requests).toHaveLength(0);});
  it("does not treat changed exact intent as confirmed",async()=>{await client().createBooking(intent);expect(await client().reconcileBooking({...intent,summary:"Changed"})).toMatchObject({state:"uncertain",reason:"EVENT_INTENT_MISMATCH"});});
});
