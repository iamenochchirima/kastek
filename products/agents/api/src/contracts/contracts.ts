import { createHash } from "node:crypto";
import { z } from "zod";
import { programReferenceSchema } from "./programs";

export const executionKindSchema = z.enum(["business", "workspace"]);
export type AgentExecutionKind = z.infer<typeof executionKindSchema>;
export const productSchema = z.enum(["agents", "growth", "agencies"]);
export type Product = z.infer<typeof productSchema>;

export const initialLimits = Object.freeze({
  maxInputBytes: 16_384,
  maxOutputTokens: 1_024,
  maxDurationSeconds: 120,
  maxConcurrentTasks: 2,
  dailyTokenAllowance: 100_000,
});

export const modelSchema = z.strictObject({
  provider: z.literal("openrouter"),
  model: z.literal("nvidia/nemotron-3-super-120b-a12b:free"),
  maxInputBytes: z.number().int().min(512).max(initialLimits.maxInputBytes),
  maxOutputTokens: z.number().int().min(1).max(initialLimits.maxOutputTokens),
  maxDurationSeconds: z.number().int().min(10).max(initialLimits.maxDurationSeconds),
});

const unavailableCapability = z.strictObject({ enabled: z.literal(false) });
export const baseToolNameSchema = z.enum(["knowledge.search", "knowledge.read", "memory.search", "memory.propose"]);
export const toolNameSchema = z.enum(["knowledge.search", "knowledge.read", "memory.search", "memory.propose", "agents.delegate", "sandbox.analyze", "channel.request_handoff"]);
export const delegationBindingSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), versionId: z.uuid(),
  sourceRevisionIds: z.array(z.uuid()).max(20).default([]), connectedToolBindingIds: z.array(z.uuid()).max(8).default([]),
  label: z.string().min(1).max(120).optional(), description: z.string().max(512).optional(), versionNumber: z.number().int().positive().optional(),
  tools: z.array(z.enum(["knowledge.search", "knowledge.read"])).max(2),
  maxTokens: z.number().int().min(2048).max(12000), maxActiveMs: z.number().int().min(1000).max(300000),
});
export const businessCapabilitiesSchema = z.strictObject({
  delegation: z.discriminatedUnion("enabled", [unavailableCapability, z.strictObject({ enabled: z.literal(true),
    bindings: z.array(delegationBindingSchema).min(1).max(2).refine(bindings => new Set(bindings.map(binding => binding.id)).size === bindings.length, "Duplicate specialist binding"),
    maxChildren: z.literal(2), maxDepth: z.literal(1) })]),
  sandbox: z.discriminatedUnion("enabled", [unavailableCapability, z.strictObject({ enabled: z.literal(true), profileId: z.literal("python-analysis-v1") })]),
  businessActions: z.discriminatedUnion("enabled",[unavailableCapability,z.strictObject({enabled:z.literal(true),profileId:z.literal("google-calendar-booking-v1"),policyId:z.uuid(),policyDigest:z.string().regex(/^[a-f0-9]{64}$/)})]),
  workflows: z.discriminatedUnion("enabled", [unavailableCapability, z.strictObject({enabled:z.literal(true),profileId:z.literal("report-delivery-v1"),
    connectionId:z.uuid(),reportArtifactName:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/).default("report.md"),title:z.string().trim().min(1).max(120).default("Report")})]),
  schedules: unavailableCapability,
});

function collectConnectedToolAuthorityIds(configuration: { connectedToolBindingIds: string[];
  capabilities: { delegation: { enabled: boolean; bindings?: { connectedToolBindingIds: string[] }[] } } }): string[] {
  return [...new Set([...configuration.connectedToolBindingIds,
    ...(configuration.capabilities.delegation.enabled ? configuration.capabilities.delegation.bindings!.flatMap(binding => binding.connectedToolBindingIds) : [])])];
}

export const agentConfigurationSchema = z.strictObject({
  program: programReferenceSchema.default({ id: "tool-directed", version: "1" }),
  executionKind: executionKindSchema,
  instructions: z.string().trim().min(1).max(8_000),
  model: modelSchema,
  sourceRevisionIds: z.array(z.uuid()).max(20).refine(ids => new Set(ids).size === ids.length, "Duplicate source revision").default([]),
  connectedToolBindingIds: z.array(z.uuid()).max(8).refine(ids => new Set(ids).size === ids.length, "Duplicate connected tool").default([]),
  retrievalProfile: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("lexical-v1") }),
    z.strictObject({ kind: z.literal("hybrid-v1"), embeddingRelease: z.string().min(1).max(256) })]).default({ kind: "lexical-v1" }),
  capabilities: businessCapabilitiesSchema,
  memory: z.strictObject({ enabled: z.boolean() }).default({ enabled: false }),
  context: z.strictObject({ maxInputTokens: z.number().int().min(2048).max(8192),
    compactAtTokens: z.number().int().min(1024).max(6144) }).default({ maxInputTokens: 8192, compactAtTokens: 6144 }),
  tools: z.array(toolNameSchema).max(7).refine(tools => new Set(tools).size === tools.length, "Duplicate tool").default([]),
  skillIds: z.array(z.uuid()).max(8).default([]),
}).refine(configuration => collectConnectedToolAuthorityIds(configuration).length <= 8, "At most eight connected tools may be authorized across the agent and its specialists");
export type AgentConfiguration = z.infer<typeof agentConfigurationSchema>;

/** Authority covers delegated tools; the agent's own tool list remains the direct configuration. */
export function connectedToolAuthorityIds(configuration: Pick<AgentConfiguration, "connectedToolBindingIds" | "capabilities">): string[] {
  const ids = collectConnectedToolAuthorityIds(configuration);
  if (ids.length > 8) throw new PlatformError("CAPABILITY_SCOPE_DENIED", 403, "At most eight connected tools may be authorized");
  return ids;
}

export function defaultBusinessConfiguration(): AgentConfiguration {
  return {
    program: { id: "tool-directed", version: "1" },
    executionKind: "business",
    instructions: "Answer questions using the approved knowledge. Cite each fact from approved knowledge with its provided evidence label in square brackets, exactly as supplied. Never invent a citation or a fact. If the sources do not answer a question, say so.",
    model: {
      provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free",
      maxInputBytes: initialLimits.maxInputBytes, maxOutputTokens: initialLimits.maxOutputTokens,
      maxDurationSeconds: initialLimits.maxDurationSeconds,
    },
    sourceRevisionIds: [], connectedToolBindingIds: [], retrievalProfile: { kind: "lexical-v1" },
    memory: { enabled: false }, context: { maxInputTokens: 8192, compactAtTokens: 6144 }, tools: [], skillIds: [],
    capabilities: {
      delegation: { enabled: false }, sandbox: { enabled: false }, businessActions: { enabled: false },
      workflows: { enabled: false }, schedules: { enabled: false },
    },
  };
}

export class PlatformError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number, message: string) {
    super(message);
    this.name = "PlatformError";
  }
}

export const taskStateSchema = z.enum([
  "accepted", "running", "waiting_children", "waiting_authority", "waiting_review", "reconciling", "cancel_requested", "completed", "incomplete", "refused", "failed", "cancelled", "uncertain",
]);
export type TaskState = z.infer<typeof taskStateSchema>;
export const terminalTaskStates: ReadonlySet<TaskState> = new Set(["completed", "incomplete", "refused", "failed", "cancelled", "uncertain"]);

const transitions: Record<TaskState, ReadonlySet<TaskState>> = {
  accepted: new Set(["running", "waiting_authority", "cancel_requested", "incomplete", "refused", "uncertain", "failed", "cancelled"]),
  running: new Set(["waiting_children", "waiting_authority", "waiting_review", "reconciling", "cancel_requested", "completed", "incomplete", "refused", "failed", "cancelled", "uncertain"]),
  waiting_children: new Set(["running", "waiting_authority", "cancel_requested", "completed", "incomplete", "failed", "cancelled", "uncertain"]),
  waiting_review: new Set(["running", "reconciling", "cancel_requested", "completed", "incomplete", "refused", "failed", "cancelled", "uncertain"]),
  reconciling: new Set(["running", "cancel_requested", "completed", "incomplete", "failed", "cancelled", "uncertain"]),
  waiting_authority: new Set(["running", "waiting_review", "reconciling", "cancel_requested", "failed", "cancelled", "incomplete", "uncertain", "refused"]),
  cancel_requested: new Set(["completed", "incomplete", "refused", "failed", "cancelled", "uncertain"]),
  completed: new Set(), incomplete: new Set(), refused: new Set(), failed: new Set(), cancelled: new Set(), uncertain: new Set(),
};

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (from !== to && !transitions[from].has(to)) {
    throw new PlatformError("INVALID_TASK_TRANSITION", 409, `Cannot move task from ${from} to ${to}`);
  }
}

export const principalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human"), issuer: z.url(), subject: z.string().min(1).max(512) }),
  z.strictObject({ kind: z.literal("automation"), id: z.uuid(), ownerAccountId: z.uuid() }),
  z.strictObject({ kind: z.literal("visitor"), deploymentId: z.uuid(), sessionId: z.uuid() }),
]);
export type InitiatingPrincipal = z.infer<typeof principalSchema>;

export const executionGrantSchema = z.strictObject({
  id: z.uuid(),
  product: productSchema,
  organizationId: z.uuid(),
  resourceId: z.string().min(1).max(256),
  callerClientId: z.string().min(1).max(128),
  principal: principalSchema,
  versionId: z.uuid(),
  operations: z.array(z.enum(["knowledge.read", "model.reply", "memory.read", "memory.propose", "delegation.execute", "sandbox.execute", "artifact.read", "artifact.write", "effect.deliver", "connected.read", "connected.execute", "channel.handoff", "skill.read", "booking.read", "booking.execute"])).min(1).max(15),
  sourceRevisionIds: z.array(z.uuid()).max(20).default([]), connectedToolBindingIds: z.array(z.uuid()).max(8).default([]),
  maxInputBytes: z.number().int().positive().max(initialLimits.maxInputBytes),
  maxOutputTokens: z.number().int().positive().max(initialLimits.maxOutputTokens),
  maxContextTokens: z.number().int().min(2048).max(8192).default(8192),
  rootTokenLimit: z.number().int().min(2048).max(32000).default(32000),
  expiresAt: z.iso.datetime({ offset: true }),
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ExecutionGrant = z.infer<typeof executionGrantSchema>;

export interface AdmissionAuthority {
  product: Product;
  organizationId: string;
  resourceId: string;
  callerClientId: string;
  principal: InitiatingPrincipal;
}

export function assertGrantAuthority(
  grant: ExecutionGrant, authority: AdmissionAuthority, versionId: string, configuration: AgentConfiguration, now = new Date(),
): void {
  const connectedAuthority = connectedToolAuthorityIds(configuration);
  if (grant.revokedAt !== null || new Date(grant.expiresAt).getTime() <= now.getTime()) {
    throw new PlatformError("GRANT_INACTIVE", 403, "Execution authorization has expired or was revoked");
  }
  if (grant.product !== authority.product || grant.organizationId !== authority.organizationId ||
      grant.resourceId !== authority.resourceId || grant.callerClientId !== authority.callerClientId ||
      canonicalJson(grant.principal) !== canonicalJson(authority.principal) || grant.versionId !== versionId) {
    throw new PlatformError("GRANT_SCOPE_DENIED", 403, "Execution authorization does not cover this request");
  }
  if (!grant.operations.includes("model.reply") ||
      (configuration.skillIds.length > 0 && !grant.operations.includes("skill.read")) ||
      configuration.sourceRevisionIds.some(id => !grant.sourceRevisionIds.includes(id)) ||
      (configuration.sourceRevisionIds.length > 0 && !grant.operations.includes("knowledge.read")) ||
      connectedAuthority.some(id => !grant.connectedToolBindingIds.includes(id)) ||
      (connectedAuthority.length > 0 && !grant.operations.includes("connected.read")) ||
      configuration.model.maxInputBytes > grant.maxInputBytes || configuration.model.maxOutputTokens > grant.maxOutputTokens ||
      configuration.context.maxInputTokens > grant.maxContextTokens ||
      (configuration.capabilities.businessActions.enabled && (!grant.operations.includes("booking.read")||!grant.operations.includes("booking.execute"))) ||
      (configuration.capabilities.delegation.enabled && !grant.operations.includes("delegation.execute")) ||
      (configuration.capabilities.sandbox.enabled && (!grant.operations.includes("sandbox.execute") || !grant.operations.includes("artifact.read") || !grant.operations.includes("artifact.write"))) ||
      (configuration.capabilities.workflows.enabled && (!grant.operations.includes("effect.deliver") || !grant.operations.includes("artifact.read") || !grant.operations.includes("artifact.write"))) ||
      (configuration.tools.includes("channel.request_handoff") && !grant.operations.includes("channel.handoff")) ||
      (configuration.memory.enabled && (!grant.operations.includes("memory.read") || !grant.operations.includes("memory.propose")))) {
    throw new PlatformError("GRANT_CAPABILITY_DENIED", 403, "Execution exceeds the authorized capabilities or limits");
  }
}

export function assertRuntimeAvailable(configuration: AgentConfiguration): void {
  if (configuration.executionKind === "workspace") {
    throw new PlatformError("RUNTIME_UNAVAILABLE", 503, "Workspace execution is unavailable");
  }
  if ((configuration.tools.includes("agents.delegate") && !configuration.capabilities.delegation.enabled) ||
      (configuration.tools.includes("sandbox.analyze") && !configuration.capabilities.sandbox.enabled)) {
    throw new PlatformError("CAPABILITY_DENIED",403,"Tool requires its published capability");
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requestDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parseAllowedOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new PlatformError("INVALID_ORIGIN", 400, "Enter a valid website origin"); }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new PlatformError("INVALID_ORIGIN", 400, "Use an HTTPS origin or a local development origin");
  }
  return url.origin;
}
