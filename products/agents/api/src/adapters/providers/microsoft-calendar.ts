import { createHash } from "node:crypto";
import { z } from "zod";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { createBoundedFetch } from "../../infrastructure/connected-network";
import type { CalendarSummary, BookingIntent, BookingResult, CalendarOptions } from "./calendar-contracts";

const timestamp = z.iso.datetime({ offset: true });
const identifier = z.string().min(1).max(1024).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const intentSchema = z.strictObject({
  organizationId: z.uuid(), bookingId: z.uuid(), calendarId: identifier,
  start: timestamp, end: timestamp,
  timeZone: z.string().min(1).max(128).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }),
  summary: z.string().trim().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).refine(value => Date.parse(value.end) > Date.parse(value.start) && Date.parse(value.end) - Date.parse(value.start) <= 86400000);
const propertyId = "String {85cfd2c9-48cf-4394-bcf5-c557d096f9d4} Name KasitekBookingIntent";
const eventFields = "id,subject,start,end,isCancelled,showAs,attendees,transactionId,webLink";
const failure = (code: string, message: string) => new PlatformError(code, 502, message);
const utc = (value: string) => new Date(value).toISOString();

export function microsoftBookingTransactionId(organizationId: string, calendarId: string, bookingId: string): string {
  z.uuid().parse(organizationId); z.uuid().parse(bookingId); identifier.parse(calendarId);
  return createHash("sha256").update(JSON.stringify([organizationId, calendarId, bookingId])).digest("hex");
}
function graphInstant(raw: unknown): string {
  const value = z.object({ dateTime: z.string().min(1).max(64), timeZone: z.literal("UTC") }).parse(raw);
  // Graph returns offset-free dateTime values in the explicitly requested UTC zone.
  const instant = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value.dateTime) ? value.dateTime : `${value.dateTime}Z`;
  if (!Number.isFinite(Date.parse(instant))) throw failure("MICROSOFT_RESPONSE_INVALID", "Microsoft returned an invalid event time");
  return utc(instant);
}

export class MicrosoftCalendarClient {
  private readonly base: string;
  constructor(private readonly token: string, private readonly options: CalendarOptions) {
    if (!token || token.length > 8192 || /[\x00-\x20\x7f]/.test(token)) throw failure("MICROSOFT_TOKEN_INVALID", "Microsoft credentials are unavailable");
    this.base = (options.testBaseUrl ?? "https://graph.microsoft.com/v1.0").replace(/\/$/, "");
    if (options.testBaseUrl) {
      const url = new URL(options.testBaseUrl);
      if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash)
        throw failure("MICROSOFT_ENDPOINT_INVALID", "Invalid provider test endpoint");
    }
  }
  private async request(operation: "calendars" | "freebusy" | "insert" | "reconcile", url: string, body?: unknown, admitted?: () => void) {
    const fetcher = createBoundedFetch({ authorizeUrl: value => value.href === url, headers: { authorization: `Bearer ${this.token}`, prefer: 'outlook.timezone="UTC"' },
      maxRequestBytes: 16384, maxResponseBytes: 262144, deadlineAt: this.options.deadlineAt, maxAttempts: 1, maxRequests: 1,
      testLoopback: !!this.options.testBaseUrl, signal: this.options.signal, returnProviderErrorResponses: true,
      beforeAttempt: async () => { await this.options.beforeAttempt?.(operation); admitted?.(); }, onAttempt: this.options.onAttempt });
    const response = await fetcher(url, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    if (text.includes(this.token)) throw failure("MICROSOFT_CREDENTIAL_REFLECTION", "Provider reflected private credentials");
    let data: any;
    try { data = text ? JSON.parse(text) : {}; } catch { throw failure("MICROSOFT_RESPONSE_INVALID", "Microsoft returned an invalid response"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw failure("MICROSOFT_RESPONSE_INVALID", "Microsoft returned an invalid response");
    return { status: response.status, data, digest: requestDigest({ status: response.status, data }) };
  }
  private async collection(operation: "calendars" | "freebusy" | "reconcile", path: string, query: URLSearchParams): Promise<{ items: any[]; digest: string }> {
    let url = `${this.base}${path}?${query}`;
    const seen = new Set<string>(), items: any[] = [], receipts: string[] = [];
    for (let page = 0; page < 10; page++) {
      if (seen.has(url)) break;
      seen.add(url);
      const response = await this.request(operation, url);
      if (response.status !== 200) throw failure("MICROSOFT_READ_FAILED", "Microsoft calendar data could not be loaded");
      const parsed = z.object({ value: z.array(z.record(z.string(), z.unknown())).max(100), "@odata.nextLink": z.string().max(16384).optional() }).parse(response.data);
      items.push(...parsed.value); receipts.push(response.digest);
      if (!parsed["@odata.nextLink"]) return { items, digest: requestDigest(receipts) };
      const next = new URL(parsed["@odata.nextLink"]!);
      const first = new URL(`${this.base}${path}`);
      if (next.origin !== first.origin || next.pathname !== first.pathname || next.username || next.password || next.hash)
        throw failure("MICROSOFT_PAGINATION_INVALID", "Microsoft returned an invalid continuation");
      // Continuations may add a skip token, but cannot widen the resource, interval or field projection.
      for (const [key, value] of query) if (next.searchParams.getAll(key).length !== 1 || next.searchParams.get(key) !== value)
        throw failure("MICROSOFT_PAGINATION_INVALID", "Microsoft changed the requested calendar query");
      for (const key of next.searchParams.keys()) if (!query.has(key) && !["$skiptoken", "$skip"].includes(key))
        throw failure("MICROSOFT_PAGINATION_INVALID", "Microsoft returned an unsupported continuation");
      url = next.href;
    }
    throw failure("MICROSOFT_CALENDAR_LIST_LIMIT", "Calendar data exceeds supported limits");
  }
  async listCalendars(): Promise<{ items: CalendarSummary[] }> {
    const response = await this.collection("calendars", "/me/calendars", new URLSearchParams({ "$select": "id,name,canEdit,isDefaultCalendar", "$top": "100" }));
    const items: CalendarSummary[] = [], seen = new Set<string>();
    for (const raw of response.items) {
      const item = z.object({ id: identifier, name: z.string().max(1024), canEdit: z.boolean(), isDefaultCalendar: z.boolean().optional() }).parse(raw);
      // Graph calendars have no timezone property. All adapter instants use UTC; booking intents retain the user's IANA zone.
      if (item.canEdit && !seen.has(item.id)) { items.push({ id: item.id, name: item.name, timeZone: "UTC", role: "writer" }); seen.add(item.id); }
    }
    return { items };
  }
  private async view(operation: "freebusy" | "reconcile", calendarId: string, range: { start: string; end: string }, expand = false) {
    identifier.parse(calendarId); timestamp.parse(range.start); timestamp.parse(range.end);
    if (Date.parse(range.end) <= Date.parse(range.start) || Date.parse(range.end) - Date.parse(range.start) > 31 * 86400000)
      throw failure("MICROSOFT_RANGE_INVALID", "Availability range must be positive and at most 31 days");
    return this.collection(operation, `/me/calendars/${encodeURIComponent(calendarId)}/calendarView`, new URLSearchParams({
      startDateTime: utc(range.start), endDateTime: utc(range.end), "$select": expand ? eventFields : "id,start,end,isCancelled,showAs", "$top": "100",
      ...(expand ? { "$expand": `singleValueExtendedProperties($filter=id eq '${propertyId}')` } : {}),
    }));
  }
  async freeBusy(calendarId: string, range: { start: string; end: string }): Promise<{ start: string; end: string; busy: { start: string; end: string }[] }> {
    const response = await this.view("freebusy", calendarId, range);
    const busy: { start: string; end: string }[] = [];
    for (const event of response.items) {
      const flags = z.object({ isCancelled: z.boolean(), showAs: z.enum(["free", "tentative", "busy", "oof", "workingElsewhere", "unknown"]) }).parse(event);
      if (!flags.isCancelled && flags.showAs !== "free") {
        const start = graphInstant(event.start), end = graphInstant(event.end);
        if (Date.parse(end) <= Date.parse(start)) throw failure("MICROSOFT_RESPONSE_INVALID", "Microsoft returned an invalid event interval");
        busy.push({ start, end });
      }
    }
    return { ...range, busy };
  }
  private confirmed(intent: BookingIntent, event: any, digest: string): BookingResult {
    const transactionId = microsoftBookingTransactionId(intent.organizationId, intent.calendarId, intent.bookingId);
    const eventId = typeof event.id === "string" && event.id.length <= 1024 ? event.id : transactionId;
    let matches = false;
    try {
      matches = identifier.safeParse(event.id).success && event.transactionId === transactionId && event.isCancelled === false && event.showAs === "busy" &&
        event.subject === intent.summary && graphInstant(event.start) === utc(intent.start) && graphInstant(event.end) === utc(intent.end) &&
        Array.isArray(event.attendees) && event.attendees.length === 0 && Array.isArray(event.singleValueExtendedProperties) &&
        event.singleValueExtendedProperties.filter((value: any) => value.id === propertyId && value.value === requestDigest(intent)).length === 1;
    } catch { matches = false; }
    if (!matches) return { state: "uncertain", eventId, reason: "EVENT_INTENT_MISMATCH", receiptDigest: digest };
    let htmlLink: string | undefined;
    try { const link = new URL(event.webLink); if (link.protocol === "https:" && ["outlook.office.com", "outlook.office365.com", "outlook.live.com"].includes(link.hostname) && !link.username && !link.password) htmlLink = link.href; } catch { /* Optional provider link. */ }
    return { state: "confirmed", eventId, start: intent.start, end: intent.end, receiptDigest: digest, ...(htmlLink ? { htmlLink } : {}) };
  }
  async reconcileBooking(raw: BookingIntent): Promise<BookingResult> {
    const intent = intentSchema.parse(raw), transactionId = microsoftBookingTransactionId(intent.organizationId, intent.calendarId, intent.bookingId);
    try {
      const response = await this.view("reconcile", intent.calendarId, intent, true);
      const matches = response.items.filter(event => event.transactionId === transactionId || event.singleValueExtendedProperties?.some((value: any) => value.id === propertyId && value.value === requestDigest(intent)));
      if (matches.length !== 1) return { state: "uncertain", eventId: transactionId, reason: matches.length ? "DUPLICATE_EVENTS_OBSERVED" : "EVENT_NOT_OBSERVED", receiptDigest: response.digest };
      return this.confirmed(intent, matches[0], response.digest);
    } catch { return { state: "uncertain", eventId: transactionId, reason: "RECONCILIATION_UNAVAILABLE" }; }
  }
  async createBooking(raw: BookingIntent): Promise<BookingResult> {
    const intent = intentSchema.parse(raw), transactionId = microsoftBookingTransactionId(intent.organizationId, intent.calendarId, intent.bookingId);
    const body = { subject: intent.summary, start: { dateTime: utc(intent.start), timeZone: "UTC" }, end: { dateTime: utc(intent.end), timeZone: "UTC" },
      transactionId, showAs: "busy", attendees: [], singleValueExtendedProperties: [{ id: propertyId, value: requestDigest(intent) }] };
    // The workflow must persist a single-send claim before calling; recovery only reconciles.
    let admitted = false;
    try {
      const response = await this.request("insert", `${this.base}/me/calendars/${encodeURIComponent(intent.calendarId)}/events`, body, () => { admitted = true; });
      if (response.status === 201 || response.status === 200) {
        const result = this.confirmed(intent, response.data, response.digest);
        return result.state === "confirmed" ? result : this.reconcileBooking(intent);
      }
      if (response.status !== 409) return { state: "uncertain", eventId: transactionId, reason: `INSERT_HTTP_${response.status}`, receiptDigest: response.digest };
    } catch (error) { if (!admitted) throw error; }
    return this.reconcileBooking(intent);
  }
}
