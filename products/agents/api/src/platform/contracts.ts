import { createHash } from "node:crypto";
import { z } from "zod";

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
export const faqCapabilitiesSchema = z.strictObject({
  delegation: unavailableCapability,
  sandbox: unavailableCapability,
  businessActions: unavailableCapability,
  workflows: unavailableCapability,
  schedules: unavailableCapability,
});

export const agentConfigurationSchema = z.strictObject({
  executionKind: executionKindSchema,
  instructions: z.string().trim().min(1).max(8_000),
  model: modelSchema,
  knowledgeIds: z.array(z.uuid()).max(20).refine((ids) => new Set(ids).size === ids.length, "Duplicate knowledge source"),
  capabilities: faqCapabilitiesSchema,
});
export type AgentConfiguration = z.infer<typeof agentConfigurationSchema>;

export function defaultFaqConfiguration(): AgentConfiguration {
  return {
    executionKind: "business",
    instructions: "Answer questions using the approved knowledge. If the sources do not answer a question, say so.",
    model: {
      provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free",
      maxInputBytes: initialLimits.maxInputBytes, maxOutputTokens: initialLimits.maxOutputTokens,
      maxDurationSeconds: initialLimits.maxDurationSeconds,
    },
    knowledgeIds: [],
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
  "accepted", "running", "cancel_requested", "completed", "failed", "cancelled", "uncertain",
]);
export type TaskState = z.infer<typeof taskStateSchema>;
export const terminalTaskStates: ReadonlySet<TaskState> = new Set(["completed", "failed", "cancelled", "uncertain"]);

const transitions: Record<TaskState, ReadonlySet<TaskState>> = {
  accepted: new Set(["running", "cancel_requested", "failed", "cancelled"]),
  running: new Set(["cancel_requested", "completed", "failed", "cancelled", "uncertain"]),
  cancel_requested: new Set(["completed", "failed", "cancelled", "uncertain"]),
  completed: new Set(), failed: new Set(), cancelled: new Set(), uncertain: new Set(),
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
  operations: z.array(z.enum(["knowledge.read", "model.reply"])).min(1).max(2),
  knowledgeIds: z.array(z.uuid()).max(20),
  maxInputBytes: z.number().int().positive().max(initialLimits.maxInputBytes),
  maxOutputTokens: z.number().int().positive().max(initialLimits.maxOutputTokens),
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
  if (grant.revokedAt !== null || new Date(grant.expiresAt).getTime() <= now.getTime()) {
    throw new PlatformError("GRANT_INACTIVE", 403, "Execution authorization has expired or was revoked");
  }
  if (grant.product !== authority.product || grant.organizationId !== authority.organizationId ||
      grant.resourceId !== authority.resourceId || grant.callerClientId !== authority.callerClientId ||
      canonicalJson(grant.principal) !== canonicalJson(authority.principal) || grant.versionId !== versionId) {
    throw new PlatformError("GRANT_SCOPE_DENIED", 403, "Execution authorization does not cover this request");
  }
  if (!grant.operations.includes("model.reply") ||
      (configuration.knowledgeIds.length > 0 && !grant.operations.includes("knowledge.read")) ||
      configuration.knowledgeIds.some((id) => !grant.knowledgeIds.includes(id)) ||
      configuration.model.maxInputBytes > grant.maxInputBytes || configuration.model.maxOutputTokens > grant.maxOutputTokens) {
    throw new PlatformError("GRANT_CAPABILITY_DENIED", 403, "Execution exceeds the authorized capabilities or limits");
  }
}

export function assertRuntimeAvailable(configuration: AgentConfiguration): void {
  if (configuration.executionKind === "workspace") {
    throw new PlatformError("RUNTIME_UNAVAILABLE", 503, "Workspace execution is unavailable");
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
