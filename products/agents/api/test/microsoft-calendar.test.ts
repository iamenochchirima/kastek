import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MicrosoftCalendarClient, microsoftBookingTransactionId } from "../src/adapters/providers/microsoft-calendar";
import type { BookingIntent } from "../src/adapters/providers/calendar-contracts";

describe("bounded Microsoft Calendar provider", () => {
  let server: Server, base: string, event: any, mode = "ok", requests: { url: string; method: string; body: any }[] = [];
  const intent: BookingIntent = { organizationId: randomUUID(), bookingId: randomUUID(), calendarId: "selected/calendar=", start: "2026-10-20T10:00:00+02:00", end: "2026-10-20T10:30:00+02:00", timeZone: "Africa/Johannesburg", summary: "Consultation", requestDigest: "a".repeat(64) };
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let text = ""; for await (const part of req) text += part;
      const body = text ? JSON.parse(text) : undefined;
      requests.push({ url: req.url!, method: req.method!, body });
      expect(req.headers.authorization).toBe("Bearer fixture-private-token");
      expect(req.headers.prefer).toBe('outlook.timezone="UTC"');
      res.setHeader("content-type", "application/json");
      const url = new URL(req.url!, base);
      if (req.method === "POST") {
        event = { ...body, id: "graph-event-id", isCancelled: false };
        if (mode === "lost") { req.socket.destroy(); return; }
        if (mode === "collision") { event.subject = "Another event"; res.statusCode = 409; res.end("{}"); return; }
        if (mode === "rate") { res.statusCode = 429; res.end("{}"); return; }
        res.statusCode = 201; res.end(JSON.stringify(mode === "sparse" ? { id: event.id } : event)); return;
      }
      if (url.pathname.endsWith("/me/calendars")) {
        const next = new URL(`${base}/me/calendars${url.search}`);
        next.searchParams.set("$skiptoken", "page-two");
        if (mode === "host") next.hostname = "example.test";
        if (mode === "resource") next.pathname = "/v1.0/me/messages";
        if (mode === "projection") next.searchParams.set("$select", "*");
        res.end(JSON.stringify({ value: [{ id: intent.calendarId, name: "Bookings", canEdit: true }, { id: "read", name: "Read", canEdit: false }],
          ...(["pages", "cycle", "host", "resource", "projection"].includes(mode) && (!url.searchParams.has("$skiptoken") || mode === "cycle") ? { "@odata.nextLink": next.href } : {}) })); return;
      }
      if (url.pathname.endsWith("/calendarView")) {
        const initial = { id: "existing", isCancelled: false, showAs: "busy", start: { dateTime: "2026-10-20T08:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-20T08:30:00.0000000", timeZone: "UTC" } };
        const values = event ? [event] : url.searchParams.has("$expand") ? [] : [initial, { ...initial, id: "free", showAs: "free" }, { ...initial, id: "cancelled", isCancelled: true }];
        res.end(JSON.stringify({ value: mode === "duplicates" ? [...values, ...values] : values })); return;
      }
      res.statusCode = 404; res.end("{}");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as any).port}/v1.0`;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  beforeEach(() => { requests = []; event = undefined; mode = "ok"; });
  const client = (beforeAttempt?: ConstructorParameters<typeof MicrosoftCalendarClient>[1]["beforeAttempt"]) => new MicrosoftCalendarClient("fixture-private-token", { testBaseUrl: base, deadlineAt: Date.now() + 5000, beforeAttempt });
  it("lists writable calendars with deliberate UTC normalization and bounded fields", async () => {
    expect((await client().listCalendars()).items).toEqual([{ id: intent.calendarId, name: "Bookings", role: "writer", timeZone: "UTC" }]);
    expect(new URL(requests[0]!.url, base).searchParams.get("$select")).toBe("id,name,canEdit,isDefaultCalendar");
  });
  it("follows bounded pages and deduplicates calendars", async () => { mode = "pages"; expect((await client().listCalendars()).items).toHaveLength(1); expect(requests).toHaveLength(2); });
  it.each(["host", "resource", "projection"])("fences %s continuation before sending credentials", async value => {
    mode = value; await expect(client().listCalendars()).rejects.toMatchObject({ code: "MICROSOFT_PAGINATION_INVALID" }); expect(requests).toHaveLength(1);
  });
  it("rejects cycling pagination", async () => { mode = "cycle"; await expect(client().listCalendars()).rejects.toMatchObject({ code: "MICROSOFT_CALENDAR_LIST_LIMIT" }); expect(requests).toHaveLength(2); });
  it("checks only the selected calendar and normalizes UTC availability", async () => {
    expect((await client().freeBusy(intent.calendarId, intent)).busy).toEqual([{ start: "2026-10-20T08:00:00.000Z", end: "2026-10-20T08:30:00.000Z" }]);
    expect(requests[0]!.url).toContain(`/me/calendars/${encodeURIComponent(intent.calendarId)}/calendarView?`);
    expect(new URL(requests[0]!.url, base).searchParams.get("startDateTime")).toBe("2026-10-20T08:00:00.000Z");
  });
  it.each(["http://graph.microsoft.com/v1.0","https://localhost/v1.0","https://127.0.0.1/v1.0","https://user:secret@graph.microsoft.com/v1.0","https://graph.microsoft.com/v1.0?token=private"])("rejects unsafe reviewed base %s",apiBaseUrl=>{
    expect(()=>new MicrosoftCalendarClient("fixture-private-token",{deadlineAt:Date.now()+5000,apiBaseUrl})).toThrow();expect(requests).toHaveLength(0);
  });
  it("rejects invalid ranges and intents before sending", async () => {
    await expect(client().freeBusy(intent.calendarId, { start: intent.start, end: "2027-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "MICROSOFT_RANGE_INVALID" });
    await expect(client().createBooking({ ...intent, timeZone: "invalid" })).rejects.toThrow(); expect(requests).toHaveLength(0);
  });
  it("creates one selected-resource event with deterministic transaction and exact intent marker", async () => {
    expect(await client().createBooking(intent)).toMatchObject({ state: "confirmed", eventId: "graph-event-id" });
    expect(requests).toHaveLength(1); expect(requests[0]!.url).toContain(`/me/calendars/${encodeURIComponent(intent.calendarId)}/events`);
    expect(event.transactionId).toBe(microsoftBookingTransactionId(intent.organizationId, intent.calendarId, intent.bookingId));
    expect(event.attendees).toEqual([]); expect(event.start).toEqual({ dateTime: "2026-10-20T08:00:00.000Z", timeZone: "UTC" });
  });
  it("reconciles lost acknowledgement without a second insert", async () => {
    mode = "lost"; expect(await client().createBooking(intent)).toMatchObject({ state: "confirmed" });
    expect(requests.map(value => value.method)).toEqual(["POST", "GET"]); expect(new URL(requests[1]!.url, base).searchParams.get("$expand")).toContain("KasitekBookingIntent");
  });
  it("reads authoritative metadata when creation response omits extensions", async () => {
    mode = "sparse"; expect(await client().createBooking(intent)).toMatchObject({ state: "confirmed" });
    expect(requests.map(value => value.method)).toEqual(["POST", "GET"]);
  });
  it("refuses mismatched and duplicate events", async () => {
    mode = "collision"; expect(await client().createBooking(intent)).toMatchObject({ state: "uncertain", reason: "EVENT_INTENT_MISMATCH" });
    mode = "duplicates"; expect(await client().reconcileBooking(intent)).toMatchObject({ state: "uncertain", reason: "DUPLICATE_EVENTS_OBSERVED" });
  });
  it("does not confirm changed intent or replay a rate limited insert", async () => {
    await client().createBooking(intent);
    expect(await client().reconcileBooking({ ...intent, summary: "Changed" })).toMatchObject({ state: "uncertain", reason: "EVENT_INTENT_MISMATCH" });
    mode = "rate"; expect(await client().createBooking(intent)).toMatchObject({ state: "uncertain", reason: "INSERT_HTTP_429" });
    expect(requests.filter(value => value.method === "POST")).toHaveLength(2);
  });
  it("propagates rejected authority before sending", async () => {
    await expect(client(async () => { throw Error("revoked"); }).createBooking(intent)).rejects.toThrow("revoked"); expect(requests).toHaveLength(0);
  });
  it("reports absent reconciliation without writing", async () => {
    expect(await client().reconcileBooking(intent)).toMatchObject({ state: "uncertain", reason: "EVENT_NOT_OBSERVED" }); expect(requests.map(value => value.method)).toEqual(["GET"]);
  });
});
