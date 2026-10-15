import { z } from "zod";
import { createAgentEvent, type AgentEventEnvelope } from "../events/envelope";
import type { ExecutionScope } from "./execution-scope";

const identifier = z.string().trim().min(1).max(240);

/**
 * The identity attached to every durable execution event. Keeping this as a
 * nested, versioned value means projections can correlate events without
 * trusting arbitrary payload fields or reconstructing tenant scope later.
 */
export const executionEventIdentitySchema = z.object({
  organizationId: identifier,
  installationId: identifier,
  agentDefinitionId: identifier,
  agentVersionId: identifier,
  sessionId: identifier.optional(),
  conversationId: identifier.optional(),
  runId: identifier,
  operationId: identifier.optional(),
  actorId: identifier.optional(),
  actorType: z.enum(["user", "system", "service", "external"]).optional(),
  correlationId: identifier,
  causationId: identifier.optional(),
  releaseId: identifier,
}).strict();

export type ExecutionEventIdentity = z.infer<typeof executionEventIdentitySchema>;

export function executionEventIdentityFromScope(
  scope: ExecutionScope,
  input: { operationId?: string; releaseId?: string } = {},
): ExecutionEventIdentity {
  return executionEventIdentitySchema.parse({
    organizationId: scope.organizationId,
    installationId: scope.installationId,
    agentDefinitionId: scope.agentDefinitionId,
    agentVersionId: scope.agentVersionId,
    ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
    ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
    runId: scope.runId,
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(scope.actorId ? { actorId: scope.actorId } : {}),
    ...(scope.actorType ? { actorType: scope.actorType } : {}),
    correlationId: scope.correlationId,
    ...(scope.causationId ? { causationId: scope.causationId } : {}),
    releaseId: input.releaseId?.trim() || process.env.KASITEK_RELEASE_ID?.trim() || "local",
  });
}

export function createScopedAgentEvent(input: {
  scope: ExecutionScope;
  type: string;
  operationId?: string;
  releaseId?: string;
  data?: Record<string, unknown>;
}): AgentEventEnvelope {
  const identity = executionEventIdentityFromScope(input.scope, input);
  return createAgentEvent({
    type: input.type,
    subject: `run:${input.scope.runId}`,
    data: {
      ...(input.data ?? {}),
      _execution: identity,
    },
  });
}
