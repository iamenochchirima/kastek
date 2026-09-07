import type { ExecutionScope } from "../runtime/execution-scope";

export type ToolRiskClass = "read" | "draft" | "controlled-write" | "external-effect" | "privileged";

export type CapabilityExecution = "immediate" | "durable";
export type CapabilityAvailability = "available" | "not_granted" | "not_configured" | "unhealthy";

export type CapabilityPresentationMetadata = {
  projection: "workspace_connections" | "content_posts" | "workspace_report" | "content_insights";
  mode: "inline" | "expanded";
  channels: Array<"platform" | "website">;
  fallback: string;
  workspace?: "connections" | "content" | "report" | "agent_creation";
  actions?: Array<{
    id: string;
    label: string;
    kind: "navigate";
    href: string;
  }>;
};

export interface CapabilityManifestMetadata {
  ownerService: string;
  requiredScope: string;
  resourceSelector?: { type: string; argument?: string };
  execution: CapabilityExecution;
  idempotency: "not_applicable" | "optional" | "required";
  approval: "none" | "policy" | "always";
  auditClassification: "access" | "full" | "restricted";
  redaction: string[];
  availability?: CapabilityAvailability;
  presentation?: CapabilityPresentationMetadata;
}

export interface ToolInvocationContext {
  /** Canonical runtime identity; the other identity fields are capability projections. */
  scope: ExecutionScope;
  organizationId: string;
  agentId: string;
  agentVersionId: string;
  installationId: string;
  runId: string;
  /** Operation identity propagated from the capability runtime to adapters. */
  operationId?: string;
  conversationId?: string;
  actorId?: string;
  correlationId: string;
  /** Cancellation propagated from the enclosing durable activity when available. */
  signal?: AbortSignal;
  /** Normalized policy snapshot used by scoped platform capabilities. */
  memoryPolicy?: Record<string, unknown>;
  /** Snapshot hash approved for the resumed external effect, when applicable. */
  approvalSnapshotHash?: string;
}

/**
 * Durable operation hooks at the capability boundary. The runtime owns the
 * ordering: admission, prepare/replay, handler invocation, then completion or
 * failure evidence. Hosts supply persistence and receipt implementations.
 */
export interface ToolInvocationLifecycle {
  propose(input: {
    request: ToolInvocationRequest;
    manifest: Omit<ToolDefinition, "handler">;
  }): Promise<void>;
  prepare(input: {
    request: ToolInvocationRequest;
    manifest: Omit<ToolDefinition, "handler">;
  }): Promise<{ status: "new" | "completed" | "unknown"; result?: ToolInvocationResult }>;
  complete(input: {
    request: ToolInvocationRequest;
    manifest: Omit<ToolDefinition, "handler">;
    result: ToolInvocationResult;
    redactedOutput: unknown;
  }): Promise<void>;
  fail(input: {
    request: ToolInvocationRequest;
    manifest: Omit<ToolDefinition, "handler">;
    error: { code: string; message: string };
  }): Promise<void>;
}

export function toolInvocationContextFromScope(
  scope: ExecutionScope,
  extras: Pick<ToolInvocationContext, "memoryPolicy" | "approvalSnapshotHash" | "signal" | "operationId"> = {},
): ToolInvocationContext {
  return {
    scope,
    organizationId: scope.organizationId,
    agentId: scope.agentDefinitionId,
    agentVersionId: scope.agentVersionId,
    installationId: scope.installationId,
    runId: scope.runId,
    operationId: extras.operationId,
    conversationId: scope.conversationId,
    actorId: scope.actorId,
    correlationId: scope.correlationId,
    ...extras,
  };
}

export function approvalSnapshotHashFromResource(snapshot?: Record<string, unknown>): string | undefined {
  const resource = snapshot?.resource;
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) return undefined;
  const preflight = (resource as Record<string, unknown>).batchPreflight;
  if (!preflight || typeof preflight !== "object" || Array.isArray(preflight)) return undefined;
  const value = (preflight as Record<string, unknown>).snapshotHash;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface ToolApproval {
  approvedBy: string;
  argumentsHash: string;
  expiresAt: string;
  /** The exact resource projection the approver reviewed, when available. */
  resourceSnapshot?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  version: string;
  description: string;
  riskClass: ToolRiskClass;
  requiresApproval: boolean;
  timeoutMs: number;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  handler: (context: ToolInvocationContext, argumentsValue: Record<string, unknown>) => Promise<unknown>;
  manifest?: CapabilityManifestMetadata;
}

export interface CapabilityManifest extends Omit<ToolDefinition, "handler" | "manifest"> {
  manifest: CapabilityManifestMetadata;
}

export interface ToolInvocationRequest {
  name: string;
  arguments: Record<string, unknown>;
  context: ToolInvocationContext;
  grantedTools: ReadonlySet<string>;
  /** Durable identity for this capability operation. */
  operationId?: string;
  /** Stable ordering within the current agent turn. */
  sequenceNumber?: number;
  approval?: ToolApproval;
  signal?: AbortSignal;
  /** Runs after all validation/approval checks and immediately before a real effect handler. */
  beforeEffect?: () => Promise<void> | void;
  /** Optional durable operation kernel supplied by the host composition root. */
  lifecycle?: ToolInvocationLifecycle;
}

export interface ToolInvocationResult {
  name: string;
  version: string;
  argumentsHash: string;
  output: unknown;
  control?: "awaiting_human" | "final_response";
  effectId?: string;
  latencyMs: number;
}

export class ToolPolicyError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ToolPolicyError";
  }
}
