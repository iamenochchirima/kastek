import { z } from "zod";
import type { CapabilityPresentationMetadata } from "../tools/types";
import { getProductWorkflow, type ProductWorkflowId } from "../workflows/product-workflows";

const UI_MAX_BYTES = 32_000;
const uiText = z.string().trim().min(1).max(500);
const uiStatus = z.enum(["success", "warning", "danger", "neutral"]);

export const uiActionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  kind: z.enum(["navigate", "follow_up", "refresh", "submit", "resume"]),
  href: z.string().trim().regex(/^\/(?!\/)/).max(240).optional(),
  prompt: z.string().trim().min(1).max(500).optional(),
  targetId: z.string().trim().min(1).max(80).optional(),
  eventKey: z.string().trim().min(1).max(160).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === "navigate" && !value.href) {
    context.addIssue({ code: "custom", path: ["href"], message: "Navigation actions require an internal href" });
  }
  if (value.kind === "follow_up" && !value.prompt) {
    context.addIssue({ code: "custom", path: ["prompt"], message: "Follow-up actions require a prompt" });
  }
  if (["navigate", "refresh", "submit", "resume"].includes(value.kind) && value.prompt) {
    context.addIssue({ code: "custom", path: ["prompt"], message: `${value.kind} actions cannot carry prompt` });
  }
  if (value.kind !== "navigate" && value.href) {
    context.addIssue({ code: "custom", path: ["href"], message: "Only navigation actions can carry href" });
  }
  if (["navigate", "follow_up", "refresh", "resume"].includes(value.kind) && value.targetId) {
    context.addIssue({ code: "custom", path: ["targetId"], message: `${value.kind} actions cannot carry targetId` });
  }
  if (value.kind === "submit" && !value.targetId) {
    context.addIssue({ code: "custom", path: ["targetId"], message: "Submit actions require a target block" });
  }
  if (value.kind === "resume" && !value.eventKey) {
    context.addIssue({ code: "custom", path: ["eventKey"], message: "Resume actions require an event key" });
  }
  if (value.kind !== "resume" && value.eventKey) {
    context.addIssue({ code: "custom", path: ["eventKey"], message: "Only resume actions can carry an event key" });
  }
});
export type UiAction = z.infer<typeof uiActionSchema>;

const uiSummaryBlockSchema = z.object({
  type: z.literal("summary"),
  id: z.string().trim().min(1).max(80),
  title: uiText.optional(),
  items: z.array(z.object({
    label: uiText,
    value: z.string().trim().min(1).max(240),
    status: uiStatus.optional(),
  }).strict()).min(1).max(8),
}).strict();

const uiListBlockSchema = z.object({
  type: z.literal("list"),
  id: z.string().trim().min(1).max(80),
  title: uiText.optional(),
  items: z.array(z.object({
    id: z.string().trim().min(1).max(160).optional(),
    title: uiText,
    description: z.string().trim().min(1).max(320).optional(),
    meta: z.string().trim().min(1).max(240).optional(),
    status: uiStatus.optional(),
  }).strict()).max(24),
  emptyText: z.string().trim().min(1).max(160).optional(),
  actions: z.array(uiActionSchema).max(2).optional(),
}).strict();

const uiProgressBlockSchema = z.object({
  type: z.literal("progress"),
  id: z.string().trim().min(1).max(80),
  title: uiText.optional(),
  steps: z.array(z.object({
    label: uiText,
    status: z.enum(["pending", "active", "complete", "error"]),
    detail: z.string().trim().min(1).max(240).optional(),
  }).strict()).min(1).max(12),
}).strict();

const uiWorkspaceBlockSchema = z.object({
  type: z.literal("workspace"),
  id: z.string().trim().min(1).max(80),
  workspace: z.enum(["connections", "content", "report", "agent_creation"]),
  title: uiText,
  description: z.string().trim().min(1).max(320),
  href: z.string().trim().regex(/^\/(?!\/)/).max(240),
  actions: z.array(uiActionSchema).max(2).optional(),
}).strict().superRefine((value, context) => {
  for (const action of value.actions ?? []) {
    if (action.kind !== "navigate") context.addIssue({ code: "custom", path: ["actions"], message: "Workspace actions must be navigation links" });
  }
});

const uiFormTextFieldSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: uiText,
  type: z.enum(["text", "textarea"]),
  description: z.string().trim().min(1).max(240).optional(),
  placeholder: z.string().trim().min(1).max(160).optional(),
  required: z.boolean().default(false),
  maxLength: z.number().int().min(1).max(2_000).default(500),
}).strict();

const uiFormSelectFieldSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: uiText,
  type: z.literal("select"),
  description: z.string().trim().min(1).max(240).optional(),
  required: z.boolean().default(false),
  options: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    label: uiText,
    value: z.string().trim().min(1).max(160).optional(),
  }).strict()).min(1).max(20),
}).strict();

const uiFormCheckboxFieldSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: uiText,
  type: z.literal("checkbox"),
  description: z.string().trim().min(1).max(240).optional(),
  required: z.boolean().default(false),
}).strict();

const uiFormFieldSchema = z.union([
  uiFormTextFieldSchema,
  uiFormSelectFieldSchema,
  uiFormCheckboxFieldSchema,
]);

const uiFormBlockSchema = z.object({
  type: z.literal("form"),
  id: z.string().trim().min(1).max(80),
  title: uiText.optional(),
  description: z.string().trim().min(1).max(320).optional(),
  fields: z.array(uiFormFieldSchema).min(1).max(8),
  actions: z.array(uiActionSchema).min(1).max(2),
}).strict().superRefine((value, context) => {
  const fieldIds = new Set<string>();
  for (const field of value.fields) {
    if (fieldIds.has(field.id)) context.addIssue({ code: "custom", path: ["fields"], message: "Form field IDs must be unique" });
    fieldIds.add(field.id);
  }
  for (const action of value.actions) {
    if (action.kind !== "submit" || action.targetId !== value.id) {
      context.addIssue({ code: "custom", path: ["actions"], message: "Form actions must submit this form" });
    }
  }
});

const uiChoiceBlockSchema = z.object({
  type: z.literal("choice"),
  id: z.string().trim().min(1).max(80),
  title: uiText.optional(),
  description: z.string().trim().min(1).max(320).optional(),
  options: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    label: uiText,
    description: z.string().trim().min(1).max(240).optional(),
    value: z.string().trim().min(1).max(240).optional(),
  }).strict()).min(1).max(8),
}).strict().superRefine((value, context) => {
  const optionIds = new Set<string>();
  for (const option of value.options) {
    if (optionIds.has(option.id)) context.addIssue({ code: "custom", path: ["options"], message: "Choice option IDs must be unique" });
    optionIds.add(option.id);
  }
});

export const uiBlockSchema = z.discriminatedUnion("type", [
  uiSummaryBlockSchema,
  uiListBlockSchema,
  uiProgressBlockSchema,
  uiWorkspaceBlockSchema,
  uiFormBlockSchema,
  uiChoiceBlockSchema,
]);
export type UiBlock = z.infer<typeof uiBlockSchema>;

export const agentUiSchema = z.object({
  version: z.literal("1"),
  mode: z.enum(["inline", "expanded"]).default("inline"),
  blocks: z.array(uiBlockSchema).min(1).max(4),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const block of value.blocks) {
    if (ids.has(block.id)) context.addIssue({ code: "custom", path: ["blocks"], message: "UI block IDs must be unique" });
    ids.add(block.id);
    if ("actions" in block) {
      const actionIds = new Set<string>();
      for (const action of block.actions ?? []) {
        if (actionIds.has(action.id)) context.addIssue({ code: "custom", path: ["blocks"], message: "UI action IDs must be unique within a block" });
        actionIds.add(action.id);
        if (action.kind === "submit" && block.type !== "form") {
          context.addIssue({ code: "custom", path: ["blocks"], message: "Submit actions are only valid on form blocks" });
        }
        if (action.kind === "submit" && action.targetId !== block.id) {
          context.addIssue({ code: "custom", path: ["blocks"], message: "Submit actions must target their containing form" });
        }
      }
    }
  }
  if (JSON.stringify(value).length > UI_MAX_BYTES) {
    context.addIssue({ code: "custom", path: ["blocks"], message: `UI payload cannot exceed ${UI_MAX_BYTES} bytes` });
  }
});
export type AgentUi = z.infer<typeof agentUiSchema>;

export const capabilityPresentationMetadataSchema = z.object({
  projection: z.enum(["workspace_connections", "content_posts", "workspace_report", "content_insights"]),
  mode: z.enum(["inline", "expanded"]).default("inline"),
  channels: z.array(z.enum(["platform", "website"])).min(1).max(2).refine((channels) => new Set(channels).size === channels.length, "Presentation channels must be unique"),
  fallback: z.string().trim().min(1).max(240),
  workspace: z.enum(["connections", "content", "report", "agent_creation"]).optional(),
  actions: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(80),
    kind: z.literal("navigate"),
    href: z.string().trim().regex(/^\/(?!\/)/).max(240),
  }).strict()).max(2).optional(),
}).strict();

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function titleCase(value: string): string {
  return value
    .replace(/[._:-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function statusTone(value: unknown): "success" | "warning" | "danger" | "neutral" {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (["connected", "active", "healthy", "ready", "published", "complete", "completed"].includes(status)) return "success";
  if (["pending", "degraded", "warning", "scheduled", "processing", "paused"].includes(status)) return "warning";
  if (["disconnected", "revoked", "error", "failed", "unhealthy"].includes(status)) return "danger";
  return "neutral";
}

function actionsFor(presentation: CapabilityPresentationMetadata): UiAction[] | undefined {
  if (!presentation.actions?.length) return undefined;
  return presentation.actions.map((action) => ({
    id: action.id,
    label: action.label,
    kind: "navigate" as const,
    href: action.href,
  }));
}

function workspaceBlock(presentation: CapabilityPresentationMetadata): UiBlock | undefined {
  if (!presentation.workspace || presentation.mode !== "expanded") return undefined;
  const workflowId: ProductWorkflowId = presentation.workspace === "connections"
    ? "social_connections"
    : presentation.workspace === "content"
      ? "content_operations"
      : presentation.workspace === "report"
        ? "workspace_reporting"
        : "agent_creation";
  const detail = getProductWorkflow(workflowId);
  const actions = actionsFor(presentation);
  return {
    type: "workspace",
    id: `${presentation.workspace}-workspace`,
    workspace: presentation.workspace,
    title: detail.title,
    description: detail.description,
    href: detail.entryPath,
    ...(actions ? { actions } : {}),
  };
}

function projectConnections(output: unknown, presentation: CapabilityPresentationMetadata): AgentUi {
  const outputRecord = record(output);
  const connections = Array.isArray(outputRecord?.connections) ? outputRecord.connections : [];
  const items = connections.map((value, index) => {
    const connection = record(value) ?? {};
    const provider = text(connection.provider, 80);
    const displayName = text(connection.displayName, 240) ?? (provider ? titleCase(provider) : "Connected account");
    const handle = text(connection.handle, 160);
    const status = text(connection.status, 40) ?? "unknown";
    const healthStatus = text(connection.healthStatus, 40);
    return {
      id: `connection-${index + 1}`,
      title: displayName,
      ...(provider || handle ? { description: [provider ? titleCase(provider) : undefined, handle].filter(Boolean).join(" · ") } : {}),
      meta: healthStatus ? `${titleCase(status)} · ${titleCase(healthStatus)}` : titleCase(status),
      status: statusTone(healthStatus ?? status),
    };
  });
  const actions = actionsFor(presentation);
  const workspace = workspaceBlock(presentation);
  return agentUiSchema.parse({
    version: "1",
    mode: presentation.mode,
    blocks: [{
      type: "list",
      id: "connected-accounts",
      title: "Connected accounts",
      items,
      emptyText: "No connected accounts",
      ...(actions ? { actions } : {}),
    }, ...(workspace ? [workspace] : [])],
  });
}

function projectContentPosts(output: unknown, presentation: CapabilityPresentationMetadata): AgentUi {
  const outputRecord = record(output);
  const posts = Array.isArray(outputRecord?.posts) ? outputRecord.posts : [];
  const items = posts.map((value, index) => {
    const post = record(value) ?? {};
    const title = text(post.title, 240) ?? text(post.content, 240)?.split(/\r?\n/, 1)[0] ?? "Untitled post";
    const channels = Array.isArray(post.channels)
      ? post.channels.filter((channel): channel is string => typeof channel === "string").map((channel) => titleCase(channel)).slice(0, 4)
      : [];
    const status = text(post.status, 40) ?? "unknown";
    return {
      id: text(post.id, 160) ?? `post-${index + 1}`,
      title,
      ...(channels.length ? { description: channels.join(" · ") } : {}),
      meta: titleCase(status),
      status: statusTone(status),
    };
  });
  const actions = actionsFor(presentation);
  const workspace = workspaceBlock(presentation);
  return agentUiSchema.parse({
    version: "1",
    mode: presentation.mode,
    blocks: [{
      type: "list",
      id: "content-posts",
      title: "Content posts",
      items,
      emptyText: "No content posts",
      ...(actions ? { actions } : {}),
    }, ...(workspace ? [workspace] : [])],
  });
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function projectWorkspaceReport(output: unknown, presentation: CapabilityPresentationMetadata): AgentUi {
  const source = record(output) ?? {};
  const connections = record(source.connections) ?? {};
  const content = record(source.content) ?? {};
  const contacts = record(source.contacts) ?? {};
  const inbox = record(source.inbox) ?? {};
  const bookings = record(source.bookings) ?? {};
  const campaigns = record(source.campaigns) ?? {};
  const templates = record(source.templates) ?? {};
  const values: Array<{ label: string; value: string; status?: "success" | "warning" | "danger" | "neutral" }> = [];
  const add = (label: string, value: unknown, status?: "success" | "warning" | "danger" | "neutral") => {
    const number = numberValue(value);
    if (number === undefined) return;
    values.push({ label, value: number.toLocaleString("en-US"), ...(status ? { status } : {}) });
  };
  add("Connections", connections.total, "success");
  add("Content posts", content.postCount);
  add("Contacts", contacts.total);
  add("Unread inbox", inbox.unreadConversationCount, numberValue(inbox.unreadConversationCount) ? "warning" : "neutral");
  add("Bookings", bookings.total);
  add("Campaigns", campaigns.total);
  add("Templates", templates.total);
  const workspace = workspaceBlock(presentation);
  return agentUiSchema.parse({
    version: "1",
    mode: presentation.mode,
    blocks: [{ type: "summary", id: "workspace-report", title: "Workspace overview", items: values.length ? values.slice(0, 8) : [{ label: "Status", value: "No report data" }] }, ...(workspace ? [workspace] : [])],
  });
}

function projectContentInsights(output: unknown, presentation: CapabilityPresentationMetadata): AgentUi {
  const source = record(output) ?? {};
  const aggregates = Array.isArray(source.aggregates) ? source.aggregates : [];
  const items = aggregates.flatMap((value, index) => {
    const aggregate = record(value) ?? {};
    const platform = text(aggregate.platform, 80);
    const metric = text(aggregate.metricKey, 80);
    const total = numberValue(aggregate.totalValue);
    if (!platform || !metric || total === undefined) return [];
    return [{ id: `${platform}-${metric}-${index}`, title: `${titleCase(platform)} · ${titleCase(metric)}`, meta: total.toLocaleString("en-US"), status: "success" as const }];
  }).slice(0, 24);
  const workspace = workspaceBlock(presentation);
  return agentUiSchema.parse({
    version: "1",
    mode: presentation.mode,
    blocks: [{ type: "list", id: "content-insights", title: "Content performance", items, emptyText: "No performance data", ...(actionsFor(presentation) ? { actions: actionsFor(presentation) } : {}) }, ...(workspace ? [workspace] : [])],
  });
}

/** Projects trusted, redacted capability output into the host-owned UI response model. */
export function projectCapabilityResultUi(input: {
  presentation?: CapabilityPresentationMetadata;
  output: unknown;
  channel?: "platform" | "website";
}): AgentUi | undefined {
  if (!input.presentation) return undefined;
  if (input.channel && !input.presentation.channels.includes(input.channel)) return undefined;
  try {
    switch (input.presentation.projection) {
      case "workspace_connections":
        return projectConnections(input.output, input.presentation);
      case "content_posts":
        return projectContentPosts(input.output, input.presentation);
      case "workspace_report":
        return projectWorkspaceReport(input.output, input.presentation);
      case "content_insights":
        return projectContentInsights(input.output, input.presentation);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
