import { z } from "zod";

export const agentStatusSchema = z.enum(["active", "paused", "archived"]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const versionStatusSchema = z.enum(["draft", "published", "retired"]);
export type VersionStatus = z.infer<typeof versionStatusSchema>;

export const installationStatusSchema = z.enum(["active", "paused", "disabled"]);
export type InstallationStatus = z.infer<typeof installationStatusSchema>;

export const agentReleaseModeSchema = z.enum(["pinned", "follow_published", "staged"]);
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

export const createVersionInputSchema = z.object({
  instructions: z.string().min(1).max(200_000),
  configuration: z.record(z.string(), z.unknown()).default({}),
  policy: z.record(z.string(), z.unknown()).default({}),
});
export type CreateVersionInput = z.infer<typeof createVersionInputSchema>;

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
