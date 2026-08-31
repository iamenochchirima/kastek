export type ToolRiskClass = "read" | "draft" | "controlled-write" | "external-effect" | "privileged";

export type CapabilityExecution = "immediate" | "durable";
export type CapabilityAvailability = "available" | "not_granted" | "not_configured" | "unhealthy";

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
}

export interface ToolInvocationContext {
  organizationId: string;
  agentId: string;
  agentVersionId: string;
  installationId: string;
  runId: string;
  conversationId?: string;
  actorId?: string;
  correlationId: string;
  /** Cancellation propagated from the enclosing durable activity when available. */
  signal?: AbortSignal;
  /** Normalized policy snapshot used by scoped platform capabilities. */
  memoryPolicy?: Record<string, unknown>;
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
  approval?: ToolApproval;
  signal?: AbortSignal;
  /** Runs after all validation/approval checks and immediately before a real effect handler. */
  beforeEffect?: () => Promise<void> | void;
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
