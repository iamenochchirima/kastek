import { z } from "zod";

const identifier = z.string().min(1).max(256);
export const observationIdentitySchema = z.strictObject({
  product: z.enum(["agents", "growth", "agencies"]), organizationId: z.uuid(), agentId: z.uuid(), versionId: z.uuid(),
  programId: identifier, programVersion: identifier, runtimeRelease: identifier,
  conversationId: z.uuid(), rootTaskId: z.uuid(), parentTaskId: z.uuid().nullable(), taskId: z.uuid(),
  operationId: identifier.nullable(), attemptId: z.uuid().nullable(), customerConversationId: z.uuid().optional(),
});
export const observationMetadataSchema = z.strictObject({
  connectionId:z.uuid().optional(),bindingId:z.uuid().optional(),
  policyRevision:z.number().int().positive().optional(),authorizationGeneration:z.number().int().positive().optional(),
  outcome: z.enum(["started", "completed", "failed", "uncertain", "cancelled", "incomplete", "refused", "waiting", "suppressed"]).optional(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/).optional(),
  inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(), bytes: z.number().int().nonnegative().optional(),
  contextTokens: z.number().int().nonnegative().optional(), count: z.number().int().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(), queueMs: z.number().nonnegative().optional(),
});
export const observationSchema = z.strictObject({
  schemaVersion: z.literal("agent.observation.v1"), id: z.string().regex(/^[a-f0-9]{64}$/), eventKey: identifier,
  category: z.enum(["task", "model", "tool", "context", "memory", "delegation", "workflow", "review", "channel", "resource", "authority"]),
  kind: z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/), occurredAt: z.iso.datetime({ offset: true }),
  identity: observationIdentitySchema, metadata: observationMetadataSchema,
});
export type AgentObservation = z.infer<typeof observationSchema>;
export type ObservationIdentity = z.infer<typeof observationIdentitySchema>;
