import type { AppConfig } from "../config";
import type { ToolInvocationContext } from "../tools/types";
import { CalendarRepository } from "./calendar-repository";
import { IntegrationRepository, type IntegrationConnectionRecord } from "./repository";
import { withProviderSpan } from "../telemetry/spans";
import type { KasitekCoreReadClient } from "../core/client";

const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const MICROSOFT_GRAPH_API = "https://graph.microsoft.com/v1.0";
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

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

type MicrosoftCredential = GoogleCredential;

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

  public constructor(
    private readonly repository: IntegrationRepository,
    private readonly config?: AppConfig,
    private readonly coreClient?: KasitekCoreReadClient,
  ) {
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

  public async searchGmail(context: ToolInvocationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.coreClient) throw new IntegrationToolError("CORE_UNAVAILABLE", "Email capabilities require the kasitek-core connection boundary");
    return this.coreClient.executeEmail(context, "search", await this.prepareCoreEmailInput(context, { ...args, provider: "google" })) as Promise<Record<string, unknown>>;
  }

  /** Provider-neutral email surface. Provider/account identity is selected by
   * the runtime metadata, never guessed from a free-form tool name. */
  public async searchEmail(context: ToolInvocationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.coreClient) return this.coreClient.executeEmail(context, "search", await this.prepareCoreEmailInput(context, args)) as Promise<Record<string, unknown>>;
    const queryText = stringArg(args, "query");
    if (!queryText) throw new IntegrationToolError("INVALID_EMAIL_SEARCH", "query is required");
    const limit = Math.max(1, Math.min(typeof args.limit === "number" ? args.limit : 10, 50));
    const requested = stringArg(args, "provider").toLowerCase();
    const providers = requested ? [requested] : ["google", "microsoft"];
    const messages: Array<Record<string, unknown>> = [];
    const accounts: Array<Record<string, unknown>> = [];
    for (const provider of providers) {
      const integrationId = provider === "microsoft" ? "microsoft.email" : "google.email";
      const connection = await this.repository.getConnection(context.organizationId, context.installationId, integrationId);
      if (connection?.status !== "connected") continue;
      accounts.push({ provider, label: this.emailAccountLabel(connection, provider), integrationId });
      if (provider === "microsoft") messages.push(...await this.searchMicrosoftEmail(context.organizationId, connection, queryText, limit));
      else messages.push(...await this.searchGoogleEmail(context.organizationId, connection, queryText, limit));
    }
    if (!accounts.length) throw new IntegrationToolError("INTEGRATION_NOT_CONNECTED", requested ? `${requested} email is not connected` : "No Google or Microsoft email account is connected");
    return { messages: messages.slice(0, limit), accounts, nextPageToken: null };
  }

  public async readEmail(context: ToolInvocationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.coreClient) return this.coreClient.executeEmail(context, "read", await this.prepareCoreEmailInput(context, args)) as Promise<Record<string, unknown>>;
    const messageId = stringArg(args, "messageId");
    if (!messageId) throw new IntegrationToolError("INVALID_EMAIL_MESSAGE", "messageId is required");
    const { provider, connection } = await this.requireEmailConnection(context, stringArg(args, "provider"));
    const message = provider === "microsoft"
      ? await this.microsoftProviderRequest(context.organizationId, connection, "GET", `/me/messages/${encodeURIComponent(messageId)}?$select=id,conversationId,subject,from,toRecipients,body,receivedDateTime,isRead`)
      : await this.googleProviderRequest(context.organizationId, connection, "google-gmail", "Gmail", GOOGLE_GMAIL_API, "GET", `/users/me/messages/${encodeURIComponent(messageId)}?format=full`);
    return { message: { provider, account: this.emailAccountLabel(connection, provider), ...jsonRecord(JSON.stringify(message)) } };
  }

  public async sendEmail(context: ToolInvocationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.coreClient) return this.coreClient.executeEmail(context, "send", await this.prepareCoreEmailInput(context, args)) as Promise<Record<string, unknown>>;
    const to = stringArrayArg(args, "to");
    const subject = stringArg(args, "subject");
    const body = stringArg(args, "body");
    if (!to.length || !subject || !body) throw new IntegrationToolError("INVALID_EMAIL_MESSAGE", "to, subject, and body are required");
    const { provider, connection } = await this.requireEmailConnection(context, stringArg(args, "provider"));
    if (provider === "microsoft") {
      const response = await this.microsoftProviderRequest(context.organizationId, connection, "POST", "/me/sendMail", { message: { subject, body: { contentType: "Text", content: body }, toRecipients: to.map((address) => ({ emailAddress: { address } })) }, saveToSentItems: true });
      return { status: "sent", provider, messageId: jsonRecord(JSON.stringify(response)).id ?? null };
    }
    const raw = [`To: ${to.join(", ")}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=UTF-8", "", body].join("\r\n");
    const response = await this.googleProviderRequest(context.organizationId, connection, "google-gmail", "Gmail", GOOGLE_GMAIL_API, "POST", "/users/me/messages/send", { raw: Buffer.from(raw, "utf8").toString("base64url") });
    return { status: "sent", provider, messageId: jsonRecord(JSON.stringify(response)).id ?? null };
  }

  public async replyEmail(context: ToolInvocationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.coreClient) return this.coreClient.executeEmail(context, "reply", await this.prepareCoreEmailInput(context, args)) as Promise<Record<string, unknown>>;
    const messageId = stringArg(args, "messageId");
    const body = stringArg(args, "body");
    if (!messageId || !body) throw new IntegrationToolError("INVALID_EMAIL_REPLY", "messageId and body are required");
    const { provider, connection } = await this.requireEmailConnection(context, stringArg(args, "provider"));
    if (provider === "microsoft") {
      await this.microsoftProviderRequest(context.organizationId, connection, "POST", `/me/messages/${encodeURIComponent(messageId)}/reply`, { comment: body });
    } else {
      const original = await this.googleProviderRequest(context.organizationId, connection, "google-gmail", "Gmail", GOOGLE_GMAIL_API, "GET", `/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Message-ID&metadataHeaders=References`) as { threadId?: string; payload?: { headers?: Array<{ name?: string; value?: string }> } };
      const headers = new Map((original.payload?.headers ?? []).filter((header): header is { name: string; value?: string } => Boolean(header.name)).map((header) => [header.name.toLowerCase(), header.value ?? ""]));
      const subject = headers.get("subject") ?? "";
      const to = stringArg(args, "to") || headers.get("from") || "";
      const raw = [`To: ${to}`, `Subject: ${subject.startsWith("Re:") ? subject : `Re: ${subject}`}`, headers.get("message-id") ? `In-Reply-To: ${headers.get("message-id")}` : "", headers.get("references") ? `References: ${headers.get("references")}` : "", "Content-Type: text/plain; charset=UTF-8", "", body].filter(Boolean).join("\r\n");
      await this.googleProviderRequest(context.organizationId, connection, "google-gmail", "Gmail", GOOGLE_GMAIL_API, "POST", "/users/me/messages/send", { raw: Buffer.from(raw, "utf8").toString("base64url"), threadId: original.threadId });
    }
    return { status: "sent", provider, messageId };
  }

  private emailAccountLabel(connection: IntegrationConnectionRecord, provider: string): string {
    const label = typeof connection.configuration.accountLabel === "string" ? connection.configuration.accountLabel.trim() : "";
    return label || (provider === "microsoft" ? "Microsoft Mail" : "Google Mail");
  }

  /**
   * Core owns the workspace credential, but Agents still owns the explicit
   * installation binding. Resolve that binding before crossing the service
   * boundary so a tool can never silently select another mailbox in the same
   * workspace.
   */
  private async prepareCoreEmailInput(context: ToolInvocationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestedProvider = stringArg(args, "provider").toLowerCase();
    if (requestedProvider && requestedProvider !== "google" && requestedProvider !== "microsoft") {
      throw new IntegrationToolError("UNKNOWN_EMAIL_PROVIDER", "provider must be google or microsoft");
    }
    const candidates = (requestedProvider ? [requestedProvider] : ["google", "microsoft"])
      .map((provider) => ({
        provider: provider as "google" | "microsoft",
        integrationIds: provider === "microsoft" ? ["microsoft.email"] : ["google.email", "google.gmail"],
      }));
    const connected = (await Promise.all(candidates.map(async (candidate) => ({
      ...candidate,
      connection: (await Promise.all(candidate.integrationIds.map((integrationId) => this.repository.getConnection(context.organizationId, context.installationId, integrationId)))).find((connection) => connection?.status === "connected") ?? null,
    })))).filter((candidate) => candidate.connection?.status === "connected");
    if (!connected.length) throw new IntegrationToolError("INTEGRATION_NOT_CONNECTED", requestedProvider ? `${requestedProvider} email is not connected` : "No email account is connected");
    if (connected.length > 1 && !requestedProvider) throw new IntegrationToolError("EMAIL_ACCOUNT_AMBIGUOUS", "Specify Google or Microsoft when more than one mailbox is connected");
    const selected = connected[0]!;
    const configuration = selected.connection!.configuration;
    const account = typeof configuration.emailAddress === "string" ? configuration.emailAddress.trim() : "";
    if (!account) throw new IntegrationToolError("EMAIL_BINDING_INVALID", "The connected mailbox is missing its account label");
    const requestedAccount = stringArg(args, "account");
    if (requestedAccount && requestedAccount.toLowerCase() !== account.toLowerCase()) throw new IntegrationToolError("EMAIL_ACCOUNT_NOT_BOUND", "That mailbox is not bound to this agent");
    return { ...args, provider: selected.provider, account };
  }

  private async requireEmailConnection(context: ToolInvocationContext, requestedProvider: string): Promise<{ provider: "google" | "microsoft"; connection: IntegrationConnectionRecord }> {
    const normalized = requestedProvider.trim().toLowerCase();
    const candidates = normalized === "google" || normalized === "microsoft" ? [normalized] : ["google", "microsoft"];
    const found: Array<{ provider: "google" | "microsoft"; connection: IntegrationConnectionRecord }> = [];
    for (const provider of candidates) {
      const integrationId = provider === "microsoft" ? "microsoft.email" : "google.email";
      const connection = await this.repository.getConnection(context.organizationId, context.installationId, integrationId);
      if (connection?.status === "connected") found.push({ provider: provider as "google" | "microsoft", connection });
    }
    if (!found.length) throw new IntegrationToolError("INTEGRATION_NOT_CONNECTED", normalized ? `${normalized} email is not connected` : "No email account is connected");
    if (found.length > 1 && !normalized) throw new IntegrationToolError("EMAIL_ACCOUNT_AMBIGUOUS", "Specify Google or Microsoft when more than one mailbox is connected");
    return found[0]!;
  }

  private async searchGoogleEmail(organizationId: string, connection: IntegrationConnectionRecord, queryText: string, limit: number): Promise<Array<Record<string, unknown>>> {
    const listQuery = new URLSearchParams({ q: queryText, maxResults: String(limit), includeSpamTrash: "false" });
    const listing = await this.googleProviderRequest(organizationId, connection, "google-gmail", "Gmail", GOOGLE_GMAIL_API, "GET", `/users/me/messages?${listQuery.toString()}`) as { messages?: Array<{ id?: string; threadId?: string }> };
    return Promise.all((listing.messages ?? []).filter((message): message is { id: string; threadId?: string } => Boolean(message.id)).slice(0, limit).map(async (message) => {
      const detail = await this.googleProviderRequest(organizationId, connection, "google-gmail", "Gmail", GOOGLE_GMAIL_API, "GET", `/users/me/messages/${encodeURIComponent(message.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`) as { id?: string; threadId?: string; snippet?: string; internalDate?: string; payload?: { headers?: Array<{ name?: string; value?: string }> } };
      const headers = new Map((detail.payload?.headers ?? []).filter((header): header is { name: string; value?: string } => Boolean(header.name)).map((header) => [header.name.toLowerCase(), header.value ?? ""]));
      return { id: detail.id ?? message.id, threadId: detail.threadId ?? message.threadId ?? "", subject: headers.get("subject") ?? "", from: headers.get("from") ?? "", to: headers.get("to") ?? "", date: headers.get("date") ?? "", snippet: detail.snippet ?? "", provider: "google" };
    }));
  }

  private async searchMicrosoftEmail(organizationId: string, connection: IntegrationConnectionRecord, queryText: string, limit: number): Promise<Array<Record<string, unknown>>> {
    const escaped = queryText.replaceAll("'", "''");
    const path = `/me/messages?$top=${Math.min(limit, 50)}&$select=id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview&$filter=contains(subject,'${encodeURIComponent(escaped)}')`;
    const payload = await this.microsoftProviderRequest(organizationId, connection, "GET", path) as { value?: Array<Record<string, unknown>> };
    return (payload.value ?? []).map((message) => ({ id: message.id, threadId: message.conversationId ?? "", subject: message.subject ?? "", from: (message.from as Record<string, unknown> | undefined)?.emailAddress ?? message.from ?? "", to: message.toRecipients ?? [], date: message.receivedDateTime ?? "", snippet: message.bodyPreview ?? "", provider: "microsoft" }));
  }

  public async searchDrive(context: ToolInvocationContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const queryText = stringArg(args, "query");
    const limit = Math.max(1, Math.min(typeof args.limit === "number" ? args.limit : 20, 100));
    const connection = await this.requireConnection(context, "google.drive");
    const escapedQuery = queryText.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
    const query = queryText ? `trashed = false and (name contains '${escapedQuery}' or fullText contains '${escapedQuery}')` : "trashed = false";
    const driveQuery = new URLSearchParams({ q: query, pageSize: String(limit), orderBy: "modifiedTime desc", fields: "files(id,name,mimeType,webViewLink,modifiedTime,size,description),nextPageToken" });
    const payload = await this.googleProviderRequest(context.organizationId, connection, "google-drive", "Google Drive", GOOGLE_DRIVE_API, "GET", `/files?${driveQuery.toString()}`) as { files?: Array<Record<string, unknown>>; nextPageToken?: string };
    return { files: payload.files ?? [], nextPageToken: payload.nextPageToken ?? null };
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
    return this.googleProviderRequest(organizationId, connection, "google-calendar", "Google Calendar", GOOGLE_CALENDAR_API, method, path, body);
  }

  private async googleProviderRequest(organizationId: string, connection: IntegrationConnectionRecord, provider: string, providerLabel: string, apiBase: string, method: string, path: string, body?: unknown): Promise<unknown> {
    if (!connection.credential_id) throw new IntegrationToolError("INTEGRATION_NOT_CONNECTED", `${providerLabel} credential is missing`);
    let credential = jsonRecord(await this.repository.resolveCredential(organizationId, connection.credential_id)) as GoogleCredential;
    if (!credential.accessToken) throw new IntegrationToolError("INTEGRATION_CREDENTIAL_INVALID", `${providerLabel} access token is missing`);
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now() + 30_000 && credential.refreshToken && this.config?.GOOGLE_OAUTH_CLIENT_ID && this.config.GOOGLE_OAUTH_CLIENT_SECRET) {
      const clientId = this.config.GOOGLE_OAUTH_CLIENT_ID;
      const clientSecret = this.config.GOOGLE_OAUTH_CLIENT_SECRET;
      const refreshToken = credential.refreshToken;
      const refreshed = await withProviderSpan(provider, "oauth.refresh", () => fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }), signal: AbortSignal.timeout(20_000) }));
      if (!refreshed.ok) throw new IntegrationToolError("INTEGRATION_REAUTH_REQUIRED", `${providerLabel} authorization has expired`);
      const token = await refreshed.json() as { access_token?: string; expires_in?: number };
      if (!token.access_token) throw new IntegrationToolError("INTEGRATION_REAUTH_REQUIRED", `${providerLabel} refresh did not return an access token`);
      credential = { ...credential, accessToken: token.access_token, expiresAt: new Date(Date.now() + (token.expires_in ?? 3_600) * 1_000).toISOString() };
      await this.repository.replaceCredential(organizationId, connection.credential_id, JSON.stringify(credential));
    }
    const response = await withProviderSpan(provider, "request", () => fetch(`${apiBase}${path}`, { method, headers: { authorization: `Bearer ${credential.accessToken}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) }));
    if (!response.ok) throw new IntegrationToolError(response.status === 401 ? "INTEGRATION_REAUTH_REQUIRED" : "PROVIDER_ERROR", `${providerLabel} returned HTTP ${response.status}`);
    if (response.status === 204) return {};
    return response.json();
  }

  private async microsoftProviderRequest(organizationId: string, connection: IntegrationConnectionRecord, method: string, path: string, body?: unknown): Promise<unknown> {
    if (!connection.credential_id) throw new IntegrationToolError("INTEGRATION_NOT_CONNECTED", "Microsoft Mail credential is missing");
    let credential = jsonRecord(await this.repository.resolveCredential(organizationId, connection.credential_id)) as MicrosoftCredential;
    if (!credential.accessToken) throw new IntegrationToolError("INTEGRATION_CREDENTIAL_INVALID", "Microsoft Mail access token is missing");
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now() + 30_000 && credential.refreshToken && this.config?.MICROSOFT_OAUTH_CLIENT_ID && this.config.MICROSOFT_OAUTH_CLIENT_SECRET) {
      const refreshed = await withProviderSpan("microsoft-mail", "oauth.refresh", () => fetch(MICROSOFT_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.config!.MICROSOFT_OAUTH_CLIENT_ID!, client_secret: this.config!.MICROSOFT_OAUTH_CLIENT_SECRET!, grant_type: "refresh_token", refresh_token: credential.refreshToken!, scope: "openid profile email offline_access User.Read Mail.Read Mail.Send" }), signal: AbortSignal.timeout(20_000) }));
      if (!refreshed.ok) throw new IntegrationToolError("INTEGRATION_REAUTH_REQUIRED", "Microsoft Mail authorization has expired");
      const token = await refreshed.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!token.access_token) throw new IntegrationToolError("INTEGRATION_REAUTH_REQUIRED", "Microsoft Mail refresh did not return an access token");
      credential = { ...credential, accessToken: token.access_token, refreshToken: token.refresh_token ?? credential.refreshToken, expiresAt: new Date(Date.now() + (token.expires_in ?? 3_600) * 1_000).toISOString() };
      await this.repository.replaceCredential(organizationId, connection.credential_id, JSON.stringify(credential));
    }
    const response = await withProviderSpan("microsoft-mail", "request", () => fetch(`${MICROSOFT_GRAPH_API}${path}`, { method, headers: { authorization: `Bearer ${credential.accessToken}`, "content-type": "application/json", ...(path.includes("$filter") ? { ConsistencyLevel: "eventual" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) }));
    if (!response.ok) throw new IntegrationToolError(response.status === 401 ? "INTEGRATION_REAUTH_REQUIRED" : "PROVIDER_ERROR", `Microsoft Graph returned HTTP ${response.status}`);
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
