import { z } from "zod";
import {
  agentEnvironmentSchema,
  environmentFromInstallationSettings,
  parseAgentEnvironment,
  type AgentEnvironment,
} from "./execution-environment";

const identifier = z.string().trim().min(1).max(240);

/**
 * The immutable identity envelope for one admitted agent run.
 *
 * This is runtime metadata, not model context or tool arguments. Host
 * adapters, context assembly, capability handlers, and execution evidence
 * receive it from the runtime; the model never chooses it.
 */
export const executionScopeSchema = z.object({
  organizationId: identifier,
  installationId: identifier,
  agentDefinitionId: identifier,
  agentVersionId: identifier,
  sessionId: identifier.optional(),
  conversationId: identifier.optional(),
  /** Durable session identity and lease epoch, never selected by the model. */
  sessionKey: identifier.optional(),
  sessionFencingToken: identifier.optional(),
  /** Present for an admitted runtime scope; journal-only legacy scopes may omit it. */
  environment: agentEnvironmentSchema.optional(),
  runId: identifier,
  actorId: identifier.optional(),
  actorType: z.enum(["user", "system", "service", "external"]).optional(),
  extensionSnapshotId: identifier.optional(),
  correlationId: identifier,
  causationId: identifier.optional(),
  capabilityGrants: z.array(identifier).max(500).optional(),
  resourceGrants: z.array(identifier).max(500).optional(),
}).strict();

export type ExecutionScope = z.infer<typeof executionScopeSchema>;

export function createExecutionScope(input: unknown): ExecutionScope {
  return executionScopeSchema.parse(input);
}

export interface ExecutionScopeRunRecord {
  organization_id: string;
  installation_id: string;
  agent_definition_id: string;
  agent_version_id: string;
  conversation_id?: string | null;
  id: string;
  created_by?: string | null;
  correlation_id: string;
  causation_id?: string | null;
  extension_snapshot_id?: string | null;
  session_key?: string | null;
  session_fencing_token?: string | null;
  environment?: unknown;
  installation_settings?: unknown;
}

function runEnvironment(input: ExecutionScopeRunRecord): AgentEnvironment | undefined {
  if (input.environment !== undefined && input.environment !== null) return parseAgentEnvironment(input.environment);
  if (input.installation_settings !== undefined) return environmentFromInstallationSettings(input.installation_settings);
  return undefined;
}

export function executionScopeFromRun(input: ExecutionScopeRunRecord, lease?: { sessionKey?: string; fencingToken?: string }, environment?: AgentEnvironment): ExecutionScope {
  const resolvedEnvironment = environment ?? runEnvironment(input);
  return createExecutionScope({
    organizationId: input.organization_id,
    installationId: input.installation_id,
    agentDefinitionId: input.agent_definition_id,
    agentVersionId: input.agent_version_id,
    ...(input.conversation_id ? { sessionId: input.conversation_id, conversationId: input.conversation_id } : {}),
    ...((lease?.sessionKey ?? input.session_key) ? { sessionKey: lease?.sessionKey ?? input.session_key } : {}),
    ...((lease?.fencingToken ?? input.session_fencing_token) ? { sessionFencingToken: lease?.fencingToken ?? input.session_fencing_token } : {}),
    ...(resolvedEnvironment ? { environment: resolvedEnvironment } : {}),
    runId: input.id,
    ...(input.created_by ? { actorId: input.created_by } : {}),
    actorType: "service",
    ...(input.extension_snapshot_id ? { extensionSnapshotId: input.extension_snapshot_id } : {}),
    correlationId: input.correlation_id,
    ...(input.causation_id ? { causationId: input.causation_id } : {}),
  });
}

export type RuntimeExecutionScope = ExecutionScope & { environment: AgentEnvironment };

export function runtimeExecutionScopeFromRun(
  input: ExecutionScopeRunRecord,
  lease?: { sessionKey?: string; fencingToken?: string },
): RuntimeExecutionScope {
  const environment = environmentFromInstallationSettings(input.installation_settings ?? { environment: input.environment });
  return {
    ...executionScopeFromRun(input, lease, environment),
    environment,
  };
}

/** Prevent a nested operation from escaping its admitted run scope. */
export function assertExecutionScopeContained(parent: ExecutionScope, child: ExecutionScope): void {
  const requiredKeys: Array<keyof ExecutionScope> = [
    "organizationId",
    "installationId",
    "agentDefinitionId",
    "agentVersionId",
    "runId",
    "correlationId",
    "environment",
  ];
  for (const key of requiredKeys) {
    if (parent[key] !== child[key]) throw new Error(`EXECUTION_SCOPE_ESCAPED:${String(key)}`);
  }
  for (const key of ["sessionId", "conversationId", "sessionKey", "sessionFencingToken", "extensionSnapshotId"] as const) {
    if (parent[key] !== undefined && child[key] !== undefined && parent[key] !== child[key]) {
      throw new Error(`EXECUTION_SCOPE_ESCAPED:${key}`);
    }
  }
}
