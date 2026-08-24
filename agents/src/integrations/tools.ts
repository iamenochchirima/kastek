import type { ToolInvocationContext } from "../tools/types";
import { ToolRegistry } from "../tools/registry";
import { IntegrationToolService } from "./service";

const objectSchema = {
  type: "object",
  additionalProperties: true,
};

const calendarInput = {
  type: "object",
  properties: {
    source: { type: "string", enum: ["internal", "google", "apple"] },
    eventId: { type: "string", minLength: 1, maxLength: 240 },
    title: { type: "string", minLength: 1, maxLength: 500 },
    description: { type: "string", maxLength: 10_000 },
    start: { type: "string", minLength: 1, maxLength: 120 },
    end: { type: "string", minLength: 1, maxLength: 120 },
    timezone: { type: "string", maxLength: 80 },
    location: { type: "string", maxLength: 1_000 },
    attendees: { type: "array", items: { type: "string", maxLength: 320 }, maxItems: 100 },
    idempotencyKey: { type: "string", minLength: 1, maxLength: 240 },
  },
  additionalProperties: false,
};

const calendarListInput = {
  type: "object",
  properties: {
    start: { type: "string", maxLength: 120 },
    end: { type: "string", maxLength: 120 },
    limit: { type: "integer", minimum: 1, maximum: 200 },
  },
  additionalProperties: false,
};

function readManifest(requiredScope: string, redaction: string[] = []) {
  return { ownerService: "agents.integrations", requiredScope, execution: "immediate" as const, idempotency: "not_applicable" as const, approval: "none" as const, auditClassification: "restricted" as const, redaction };
}

function writeManifest(requiredScope: string, redaction: string[] = []) {
  return { ownerService: "agents.integrations", requiredScope, execution: "durable" as const, idempotency: "required" as const, approval: "always" as const, auditClassification: "restricted" as const, redaction };
}

function register(
  registry: ToolRegistry,
  definition: Parameters<ToolRegistry["register"]>[0],
): void {
  registry.register(definition);
}

export function registerIntegrationTools(registry: ToolRegistry, service: IntegrationToolService): void {
  register(registry, {
    name: "kasitek.calendar.list",
    version: "1.0.0",
    description: "List events from the calendars connected to this agent.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 20_000,
    inputSchema: calendarListInput,
    outputSchema: { type: "object", required: ["events", "sources"], properties: { events: { type: "array" }, sources: { type: "array", items: { type: "string" } } }, additionalProperties: false },
    manifest: readManifest("calendar.read", ["events.attendees"]),
    handler: (context, args) => service.listCalendar(context, args),
  });

  for (const [name, description, handler] of [
    ["kasitek.calendar.create", "Create an event in a connected calendar.", (context: ToolInvocationContext, args: Record<string, unknown>) => service.createCalendarEvent(context, args)],
    ["kasitek.calendar.update", "Update an event in a connected calendar.", (context: ToolInvocationContext, args: Record<string, unknown>) => service.updateCalendarEvent(context, args)],
  ] as const) {
    register(registry, {
      name,
      version: "1.0.0",
      description,
      riskClass: "external-effect",
      requiresApproval: true,
      timeoutMs: 30_000,
      inputSchema: calendarInput,
      outputSchema: objectSchema,
      manifest: writeManifest("calendar.write", ["event.attendees"]),
      handler,
    });
  }

  register(registry, {
    name: "kasitek.calendar.delete",
    version: "1.0.0",
    description: "Delete an event from a connected calendar.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 30_000,
    inputSchema: { type: "object", properties: { source: { type: "string", enum: ["internal", "google", "apple"] }, eventId: { type: "string", minLength: 1, maxLength: 240 } }, required: ["eventId"], additionalProperties: false },
    outputSchema: objectSchema,
    manifest: writeManifest("calendar.write"),
    handler: (context, args) => service.deleteCalendarEvent(context, args),
  });

  register(registry, {
    name: "kasitek.web.search",
    version: "1.0.0",
    description: "Search the web and return sourced results.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 25_000,
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 2_000 }, searchDepth: { type: "string", enum: ["basic", "advanced"] }, limit: { type: "integer", minimum: 1, maximum: 10 } }, required: ["query"], additionalProperties: false },
    outputSchema: { type: "object", required: ["answer", "results"], properties: { answer: { type: "string" }, results: { type: "array" } }, additionalProperties: false },
    manifest: readManifest("web.search"),
    handler: (context, args) => service.searchWeb(context, args),
  });

  for (const [name, description, operation] of [
    ["kasitek.apple.calendar.list", "List events from a connected Apple Tools bridge.", "calendar.list"],
    ["kasitek.apple.mail.list", "List messages from a connected Apple Tools bridge.", "mail.list"],
  ] as const) {
    register(registry, {
      name,
      version: "1.0.0",
      description,
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 35_000,
      inputSchema: objectSchema,
      outputSchema: { type: "object", required: ["results"], properties: { results: { type: "array" } }, additionalProperties: false },
      manifest: readManifest(operation === "calendar.list" ? "apple.calendar.read" : "apple.mail.read", ["results.body", "results.content"]),
      handler: (context, args) => service.appleTool(context, operation, args),
    });
  }

  for (const [name, description, operation] of [
    ["kasitek.apple.reminder.create", "Create a reminder through a connected Apple Tools bridge.", "reminder.create"],
    ["kasitek.apple.note.create", "Create a note through a connected Apple Tools bridge.", "note.create"],
  ] as const) {
    register(registry, {
      name,
      version: "1.0.0",
      description,
      riskClass: "external-effect",
      requiresApproval: true,
      timeoutMs: 35_000,
      inputSchema: objectSchema,
      outputSchema: { type: "object", required: ["results"], properties: { results: { type: "array" } }, additionalProperties: false },
      manifest: writeManifest(operation === "reminder.create" ? "apple.reminders.write" : "apple.notes.write", ["results.content"]),
      handler: (context, args) => service.appleTool(context, operation, args),
    });
  }
}
