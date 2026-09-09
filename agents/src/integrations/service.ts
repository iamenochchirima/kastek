import type { AppConfig } from "../config";
import type { ToolInvocationContext } from "../tools/types";
import { CalendarRepository } from "./calendar-repository";
import { IntegrationRepository, type IntegrationConnectionRecord } from "./repository";
import { withProviderSpan } from "../telemetry/spans";

const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export class IntegrationToolError extends Error {
  public constructor(public readonly code: string, message = code) {
    super(message);
  }
}

type GoogleCredential = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  calendarId?: string;
};

function stringArg(args: Record<string, unknown>, key: string, fallback = ""): string {
  return typeof args[key] === "string" ? args[key].trim() : fallback;
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
  return Array.isArray(args[key]) ? args[key].filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean) : [];
}

function jsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export class IntegrationToolService {
  private readonly calendar: CalendarRepository;

  public constructor(private readonly repository: IntegrationRepository, private readonly config?: AppConfig) {
    this.calendar = new CalendarRepository(repository.database);
  }

  public async listCalendar(context: ToolInvocationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const start = stringArg(args, "start") || undefined;
    const end = stringArg(args, "end") || undefined;
    const limit = typeof args.limit === "number" ? args.limit : 50;
    const events: Array<Record<string, unknown>> = [];
    const internal = await this.calendar.list({ organizationId: context.organizationId, installationId: context.installationId, start, end, limit });
    events.push(...internal.map((event) => ({ id: event.id, source: "internal", title: event.title, description: event.description, start: event.start_at, end: event.end_at, timezone: event.timezone, location: event.location, attendees: event.attendees })));

    const google = await this.repository.getConnection(context.organizationId, context.installationId, "google.calendar");
    if (google?.status === "connected") {
      events.push(...await this.listGoogle(context.organizationId, google, { start, end, limit }));
    }
    const apple = await this.repository.getConnection(context.organizationId, context.installationId, "apple.tools");
    if (apple?.status === "connected") {
      events.push(...await this.callApple(context, apple, "calendar.list", { start, end, limit }));
    }
    events.sort((left, right) => String(left.start).localeCompare(String(right.start)));
    return { events: events.slice(0, Math.max(1, Math.min(limit, 200))), sources: ["KasiTek Calendar", ...(google?.status === "connected" ? ["Google Calendar"] : []), ...(apple?.status === "connected" ? ["Apple Calendar"] : [])] };
  }

  public async createCalendarEvent(context: ToolInvocationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = stringArg(args, "source", "internal");
    const title = stringArg(args, "title");
    const start = stringArg(args, "start");
    const end = stringArg(args, "end");
    if (!title || !start) throw new IntegrationToolError("INVALID_CALENDAR_EVENT", "title and start are required");
    if (source === "internal") {
      const event = await this.calendar.create({
        organizationId: context.organizationId,
        installationId: context.installationId,
        title,
        description: stringArg(args, "description"),
        start,
        end: end || new Date(new Date(start).getTime() + 3_600_000).toISOString(),
        timezone: stringArg(args, "timezone", "UTC"),
        location: stringArg(args, "location"),
        attendees: stringArrayArg(args, "attendees"),
        idempotencyKey: stringArg(args, "idempotencyKey") || undefined,
        createdBy: context.actorId ?? "agent",
      });
      return { event: { id: event.id, source, title: event.title, start: event.start_at, end: event.end_at, timezone: event.timezone, location: event.location, attendees: event.attendees }, status: "created" };
    }
    if (source === "google") {
      const connection = await this.requireConnection(context, "google.calendar");
      return { event: await this.googleRequest(context.organizationId, connection, "POST", `/calendars/${encodeURIComponent(this.googleCalendarId(connection))}/events`, {
        summary: title,
        description: stringArg(args, "description"),
        location: stringArg(args, "location"),
        start: { dateTime: start, timeZone: stringArg(args, "timezone", "UTC") },
        end: { dateTime: end || new Date(new Date(start).getTime() + 3_600_000).toISOString(), timeZone: stringArg(args, "timezone", "UTC") },
        attendees: stringArrayArg(args, "attendees").map((email) => ({ email })),
      }), status: "created" };
    }
    if (source === "apple") return { event: (await this.callApple(context, await this.requireConnection(context, "apple.tools"), "calendar.create", args))[0], status: "created" };
    throw new IntegrationToolError("UNKNOWN_CALENDAR_SOURCE", `Unsupported calendar source: ${source}`);
  }

  public async updateCalendarEvent(context: ToolInvocationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = stringArg(args, "source", "internal");
    const eventId = stringArg(args, "eventId");
    if (!eventId) throw new IntegrationToolError("INVALID_CALENDAR_EVENT", "eventId is required");
    if (source === "internal") {
      const event = await this.calendar.update({ organizationId: context.organizationId, installationId: context.installationId, eventId, title: stringArg(args, "title") || undefined, description: stringArg(args, "description") || undefined, start: stringArg(args, "start") || undefined, end: stringArg(args, "end") || undefined, timezone: stringArg(args, "timezone") || undefined, location: stringArg(args, "location") || undefined, attendees: args.attendees === undefined ? undefined : stringArrayArg(args, "attendees") });
      return { event: { id: event.id, source, title: event.title, start: event.start_at, end: event.end_at, timezone: event.timezone, location: event.location, attendees: event.attendees }, status: "updated" };
    }
    if (source === "google") {
      const connection = await this.requireConnection(context, "google.calendar");
      return { event: await this.googleRequest(context.organizationId, connection, "PATCH", `/calendars/${encodeURIComponent(this.googleCalendarId(connection))}/events/${encodeURIComponent(eventId)}`, this.googleEventPatch(args)), status: "updated" };
    }
    if (source === "apple") return { event: (await this.callApple(context, await this.requireConnection(context, "apple.tools"), "calendar.update", args))[0], status: "updated" };
    throw new IntegrationToolError("UNKNOWN_CALENDAR_SOURCE", `Unsupported calendar source: ${source}`);
  }

  public async deleteCalendarEvent(context: ToolInvocationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = stringArg(args, "source", "internal");
    const eventId = stringArg(args, "eventId");
    if (!eventId) throw new IntegrationToolError("INVALID_CALENDAR_EVENT", "eventId is required");
    if (source === "internal") await this.calendar.cancel({ organizationId: context.organizationId, installationId: context.installationId, eventId });
    else if (source === "google") {
      const connection = await this.requireConnection(context, "google.calendar");
      await this.googleRequest(context.organizationId, connection, "DELETE", `/calendars/${encodeURIComponent(this.googleCalendarId(connection))}/events/${encodeURIComponent(eventId)}`);
    }
    else if (source === "apple") await this.callApple(context, await this.requireConnection(context, "apple.tools"), "calendar.delete", args);
    else throw new IntegrationToolError("UNKNOWN_CALENDAR_SOURCE", `Unsupported calendar source: ${source}`);
    return { eventId, source, deleted: true };
  }

  public async searchWeb(context: ToolInvocationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const queryText = stringArg(args, "query");
    if (!queryText) throw new IntegrationToolError("INVALID_SEARCH", "query is required");
    const connection = await this.repository.getConnection(context.organizationId, context.installationId, "tavily.search");
    const apiKey = connection?.credential_id ? await this.repository.resolveCredential(context.organizationId, connection.credential_id) : this.config?.TAVILY_API_KEY;
    if (!apiKey) throw new IntegrationToolError("INTEGRATION_NOT_CONNECTED", "Tavily Search is not connected");
    const response = await withProviderSpan("tavily", "search", () => fetch("https://api.tavily.com/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: apiKey, query: queryText, search_depth: stringArg(args, "searchDepth", "basic"), max_results: Math.max(1, Math.min(typeof args.limit === "number" ? args.limit : 5, 10)), include_answer: true }), signal: AbortSignal.timeout(20_000) }));
    if (!response.ok) throw new IntegrationToolError("PROVIDER_ERROR", `Tavily returned HTTP ${response.status}`);
    const payload = await response.json() as { answer?: string; results?: Array<{ title?: string; url?: string; content?: string; score?: number }> };
    return { answer: payload.answer ?? "", results: (payload.results ?? []).map((item) => ({ title: item.title ?? "", url: item.url ?? "", content: item.content ?? "", score: item.score })) };
  }

  public async appleTool(context: ToolInvocationContext, operation: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const connection = await this.requireConnection(context, "apple.tools");
    return { results: await this.callApple(context, connection, operation, args) };
  }

  public async isAvailable(organizationId: string, installationId: string, integrationId: string): Promise<boolean> {
    if (integrationId === "internal.calendar") return true;
    if (integrationId === "tavily.search" && this.config?.TAVILY_API_KEY) return true;
    const connection = await this.repository.getConnection(organizationId, installationId, integrationId);
    return connection?.status === "connected";
  }

  private async requireConnection(context: ToolInvocationContext, integrationId: string): Promise<IntegrationConnectionRecord> {
    const connection = await this.repository.getConnection(context.organizationId, context.installationId, integrationId);
    if (!connection || connection.status !== "connected") throw new IntegrationToolError("INTEGRATION_NOT_CONNECTED", `${integrationId} is not connected`);
    return connection;
  }

  private async listGoogle(organizationId: string, connection: IntegrationConnectionRecord, input: { start?: string; end?: string; limit: number }): Promise<Array<Record<string, unknown>>> {
    const query = new URLSearchParams({ maxResults: String(Math.max(1, Math.min(input.limit, 100))), singleEvents: "true", orderBy: "startTime" });
    if (input.start) query.set("timeMin", new Date(input.start).toISOString());
    if (input.end) query.set("timeMax", new Date(input.end).toISOString());
    const response = await this.googleRequest(organizationId, connection, "GET", `/calendars/${encodeURIComponent(this.googleCalendarId(connection))}/events?${query.toString()}`) as { items?: Array<Record<string, unknown>> };
    return (response.items ?? []).map((item) => ({ id: item.id, source: "google", title: item.summary ?? "", description: item.description ?? "", start: (item.start as Record<string, unknown> | undefined)?.dateTime ?? (item.start as Record<string, unknown> | undefined)?.date, end: (item.end as Record<string, unknown> | undefined)?.dateTime ?? (item.end as Record<string, unknown> | undefined)?.date, location: item.location ?? "", attendees: Array.isArray(item.attendees) ? item.attendees.map((entry) => (entry as Record<string, unknown>).email).filter(Boolean) : [] }));
  }

  private googleCalendarId(connection: IntegrationConnectionRecord): string {
    return typeof connection.configuration.calendarId === "string" && connection.configuration.calendarId.trim() ? connection.configuration.calendarId : "primary";
  }

  private googleEventPatch(args: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries({ summary: stringArg(args, "title"), description: stringArg(args, "description"), location: stringArg(args, "location"), start: stringArg(args, "start") ? { dateTime: stringArg(args, "start"), timeZone: stringArg(args, "timezone", "UTC") } : undefined, end: stringArg(args, "end") ? { dateTime: stringArg(args, "end"), timeZone: stringArg(args, "timezone", "UTC") } : undefined }).filter(([, value]) => value !== undefined && value !== ""));
  }

  private async googleRequest(organizationId: string, connection: IntegrationConnectionRecord, method: string, path: string, body?: unknown): Promise<unknown> {
    if (!connection.credential_id) throw new IntegrationToolError("INTEGRATION_NOT_CONNECTED", "Google Calendar credential is missing");
    let credential = jsonRecord(await this.repository.resolveCredential(organizationId, connection.credential_id)) as GoogleCredential;
    if (!credential.accessToken) throw new IntegrationToolError("INTEGRATION_CREDENTIAL_INVALID", "Google Calendar access token is missing");
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now() + 30_000 && credential.refreshToken && this.config?.GOOGLE_OAUTH_CLIENT_ID && this.config.GOOGLE_OAUTH_CLIENT_SECRET) {
      const clientId = this.config.GOOGLE_OAUTH_CLIENT_ID;
      const clientSecret = this.config.GOOGLE_OAUTH_CLIENT_SECRET;
      const refreshToken = credential.refreshToken;
      const refreshed = await withProviderSpan("google-calendar", "oauth.refresh", () => fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }), signal: AbortSignal.timeout(20_000) }));
      if (!refreshed.ok) throw new IntegrationToolError("INTEGRATION_REAUTH_REQUIRED", "Google Calendar authorization has expired");
      const token = await refreshed.json() as { access_token?: string; expires_in?: number };
      if (!token.access_token) throw new IntegrationToolError("INTEGRATION_REAUTH_REQUIRED", "Google Calendar refresh did not return an access token");
      credential = { ...credential, accessToken: token.access_token, expiresAt: new Date(Date.now() + (token.expires_in ?? 3_600) * 1_000).toISOString() };
      await this.repository.replaceCredential(organizationId, connection.credential_id, JSON.stringify(credential));
    }
    const response = await withProviderSpan("google-calendar", "calendar.request", () => fetch(`${GOOGLE_CALENDAR_API}${path}`, { method, headers: { authorization: `Bearer ${credential.accessToken}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) }));
    if (!response.ok) throw new IntegrationToolError(response.status === 401 ? "INTEGRATION_REAUTH_REQUIRED" : "PROVIDER_ERROR", `Google Calendar returned HTTP ${response.status}`);
    if (response.status === 204) return {};
    return response.json();
  }

  private async callApple(context: ToolInvocationContext, connection: IntegrationConnectionRecord, operation: string, args: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    if (!connection.credential_id || typeof connection.configuration.endpoint !== "string") throw new IntegrationToolError("CONNECTOR_REQUIRED", "Apple Tools requires a paired local connector");
    const endpoint = connection.configuration.endpoint.trim().replace(/\/$/, "");
    if (!/^https?:\/\//i.test(endpoint)) throw new IntegrationToolError("CONNECTOR_INVALID", "Apple Tools connector endpoint is invalid");
    const secret = await this.repository.resolveCredential(context.organizationId, connection.credential_id);
    const response = await withProviderSpan("apple-connector", "tools.call", () => fetch(`${endpoint}/v1/tools/call`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ operation, arguments: args, requestId: context.runId, correlationId: context.correlationId }), signal: AbortSignal.timeout(30_000) }));
    if (!response.ok) throw new IntegrationToolError("CONNECTOR_ERROR", `Apple connector returned HTTP ${response.status}`);
    const payload = await response.json() as { results?: Array<Record<string, unknown>> };
    return payload.results ?? [];
  }

}
