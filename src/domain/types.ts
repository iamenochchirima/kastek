import { z } from "zod";
import { agentSpecSchema, compileAgentSpec } from "./agent-spec";

export const agentStatusSchema = z.enum(["active", "paused", "archived"]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const versionStatusSchema = z.enum(["draft", "published", "retired"]);
export type VersionStatus = z.infer<typeof versionStatusSchema>;

export const installationStatusSchema = z.enum(["active", "paused", "disabled"]);
export type InstallationStatus = z.infer<typeof installationStatusSchema>;

export const agentReleaseModeSchema = z.literal("pinned");
export type AgentReleaseMode = z.infer<typeof agentReleaseModeSchema>;

export const agentExecutionModeSchema = z.enum(["system_hosted", "kasitek_hosted", "external_connected"]);
export type AgentExecutionMode = z.infer<typeof agentExecutionModeSchema>;

export const hostedAgentCreationProfileSchema = z.enum(["general", "custom"]);
export type HostedAgentCreationProfile = z.infer<typeof hostedAgentCreationProfileSchema>;

export const agentAudienceSchema = z.enum(["personal", "customer_service"]);
export type AgentAudience = z.infer<typeof agentAudienceSchema>;

export const runStatusSchema = z.enum([
  "received",
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_human",
  "awaiting_external_event",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const transitionMap: Record<RunStatus, readonly RunStatus[]> = {
  received: ["queued", "failed", "cancelled"],
  queued: ["running", "failed", "cancelled", "expired"],
  running: [
    "awaiting_approval",
    "awaiting_human",
    "awaiting_external_event",
    "completed",
    "failed",
    "cancelled",
    "expired",
  ],
  awaiting_approval: ["running", "failed", "expired", "cancelled"],
  awaiting_human: ["running", "failed", "expired", "cancelled"],
  awaiting_external_event: ["running", "failed", "expired", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
};

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!transitionMap[from].includes(to)) {
    throw new Error(`Invalid run transition: ${from} -> ${to}`);
  }
}

export const createAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80)
    .optional(),
  description: z.string().trim().max(2000).optional(),
  creationProfile: hostedAgentCreationProfileSchema.default("custom"),
  agentAudience: agentAudienceSchema.default("personal"),
  protected: z.boolean().default(false),
});
export type CreateAgentInput = z.input<typeof createAgentInputSchema>;

export const studioAgentCreationInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional(),
  instructions: z.string().trim().min(1).max(200_000),
}).strict();
export type StudioAgentCreationInput = z.infer<typeof studioAgentCreationInputSchema>;

export const updateAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80)
    .optional(),
  description: z.string().trim().max(2000).nullable().optional(),
}).refine((value) => value.name !== undefined || value.slug !== undefined || value.description !== undefined, {
  message: "At least one agent field must be provided",
});
export type UpdateAgentInput = z.infer<typeof updateAgentInputSchema>;

const legacyCreateVersionInputSchema = z.object({
  instructions: z.string().min(1).max(200_000),
  configuration: z.record(z.string(), z.unknown()).default({}),
  policy: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((value, context) => {
  const record = (candidate: unknown): Record<string, unknown> => (
    candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : {}
  );
  const number = (candidate: unknown): number | undefined => (
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0
      ? candidate
      : undefined
  );
  const configuration = value.configuration;
  const policy = value.policy;
  const nestedRuntime = record(configuration.runtime);
  const modelPolicy = record(policy.modelPolicy);
  const runLimits = record(policy.runLimits);
  const contextTokens = number(configuration.maxContextTokens)
    ?? number(nestedRuntime.maxContextTokens)
    ?? 8_000;
  const totalTokenLimits = [
    number(configuration.maxTotalTokens),
    number(nestedRuntime.maxTotalTokens),
    number(modelPolicy.maxTokensPerRun),
    number(runLimits.maxTotalTokens),
  ].filter((candidate): candidate is number => candidate !== undefined);
  for (const totalTokens of totalTokenLimits) {
    if (totalTokens <= contextTokens) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["configuration", "maxTotalTokens"],
        message: "must be greater than maxContextTokens",
      });
      break;
    }
  }
});

const typedCreateVersionInputSchema = z.object({
  spec: agentSpecSchema,
}).strict().transform(({ spec }) => compileAgentSpec(spec));

/**
 * New API writes use `{ spec: AgentSpec }`; the legacy shape remains accepted
 * for existing clients, templates, and historical workflows.
 */
export const createVersionInputSchema = z.union([
  legacyCreateVersionInputSchema,
  typedCreateVersionInputSchema,
]);
export type CreateVersionInput = z.output<typeof createVersionInputSchema>;

export const createInstallationInputSchema = z.object({
  agentVersionId: z.string().uuid(),
  scopeType: z.enum(["organization", "user", "business"]).default("organization"),
  scopeId: z.string().min(1).max(160).optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
  executionMode: agentExecutionModeSchema.optional(),
  releaseMode: agentReleaseModeSchema.optional(),
});
export type CreateInstallationInput = z.infer<typeof createInstallationInputSchema>;

export const deployInstallationInputSchema = z.object({
  versionId: z.string().uuid(),
  expectedVersionId: z.string().uuid().optional(),
});
export type DeployInstallationInput = z.infer<typeof deployInstallationInputSchema>;

/**
 * Read-only validation for moving an immutable candidate to a target
 * installation. The source installation is optional for callers that only
 * need to validate a published version; promotion requires it.
 */
export const installationDeploymentPreflightInputSchema = z.object({
  versionId: z.string().uuid(),
  sourceInstallationId: z.string().uuid().optional(),
  expectedVersionId: z.string().uuid().optional(),
}).strict();
export type InstallationDeploymentPreflightInput = z.infer<typeof installationDeploymentPreflightInputSchema>;

/**
 * Activation is deliberately separate from the existing deploy endpoint:
 * promotion names the tested Playground source and is idempotent against the
 * target Live pointer.
 */
export const installationPromotionInputSchema = z.object({
  versionId: z.string().uuid(),
  sourceInstallationId: z.string().uuid(),
  expectedVersionId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(8).max(240),
}).strict();
export type InstallationPromotionInput = z.infer<typeof installationPromotionInputSchema>;

export const installationRollbackInputSchema = z.object({
  expectedVersionId: z.string().uuid().optional(),
  targetVersionId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(8).max(240).optional(),
}).strict();
export type InstallationRollbackInput = z.infer<typeof installationRollbackInputSchema>;

const externalScopeSchema = z.object({
  resourceType: z.string().trim().min(1).max(120),
  resourceId: z.string().trim().min(1).max(240),
});

export const createExternalAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80)
    .optional(),
  description: z.string().trim().max(2000).optional(),
  agentAudience: agentAudienceSchema.default("personal"),
  runtime: z.string().trim().min(1).max(80).default("custom"),
  protocols: z.array(z.enum(["mcp", "rest"])).min(1).max(2),
  capabilities: z.array(z.string().trim().min(1).max(160)).max(200).default([]),
  resources: z.array(externalScopeSchema).max(200).default([]),
  connectors: z.array(z.string().trim().min(1).max(240)).max(100).default([]),
  instructions: z.string().trim().min(1).max(200_000).default("Operate as an external-connected KasiTek client."),
  credentialLabel: z.string().trim().min(1).max(160).default("External agent"),
  expiresAt: z.string().datetime().optional(),
  clientKeyId: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  clientPublicKey: z.string().trim().min(1).max(16_000).optional(),
  idempotencyKey: z.string().trim().min(8).max(240),
}).superRefine((value, context) => {
  if ((value.clientKeyId === undefined) !== (value.clientPublicKey === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [value.clientKeyId === undefined ? "clientKeyId" : "clientPublicKey"], message: "Client key id and public key must be provided together" });
  }
});
export type CreateExternalAgentInput = Omit<z.infer<typeof createExternalAgentInputSchema>, "agentAudience"> & { agentAudience?: AgentAudience };

export const createInstallationCredentialInputSchema = z.object({
  label: z.string().trim().min(1).max(160),
  expiresAt: z.string().datetime().optional(),
  clientKeyId: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  clientPublicKey: z.string().trim().min(1).max(16_000).optional(),
}).superRefine((value, context) => {
  if ((value.clientKeyId === undefined) !== (value.clientPublicKey === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [value.clientKeyId === undefined ? "clientKeyId" : "clientPublicKey"], message: "Client key id and public key must be provided together" });
  }
});

export const startRunInputSchema = z.object({
  installationId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  triggerType: z.enum(["message", "schedule", "webhook", "manual"]).default("manual"),
  idempotencyKey: z.string().trim().min(1).max(240).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
});
export type StartRunInput = z.infer<typeof startRunInputSchema>;
