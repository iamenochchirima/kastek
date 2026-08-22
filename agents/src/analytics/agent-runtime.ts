import { buildEvent, canonicalJsonSha256, type AnalyticsOutboxRecord, type JsonObject } from "./producer";

export type AgentExecutionMode = "system_hosted" | "kasitek_hosted" | "external_connected";
export type AgentCreationProfile = "general" | "custom" | "system";
export type AgentAudience = "personal" | "customer_service";
export type AgentDeploymentSurface = "conversation" | "external_operation" | "direct";

export interface AgentRunTerminalInput {
  runId: string;
  organizationId: string;
  agentDefinitionId: string;
  agentVersionId: string;
  installationId: string;
  conversationId: string | null;
  triggerType: "message" | "schedule" | "webhook" | "manual";
  executionMode: AgentExecutionMode;
  creationProfile: AgentCreationProfile;
  agentAudience: AgentAudience;
  input: Record<string, unknown>;
  correlationId: string;
  causationId: string | null;
  createdAt: Date | string;
  startedAt: Date | string | null;
  finishedAt: Date | string;
}

export interface CompletedAgentRunInput extends AgentRunTerminalInput {
  output: Record<string, unknown>;
}

export interface FailedAgentRunInput extends AgentRunTerminalInput {
  error: Record<string, unknown>;
}

export interface ModelCallAnalyticsInput {
  modelCallId: string;
  organizationId: string;
  runId: string | null;
  provider: string;
  model: string;
  fundingSource: "kasitek" | "user";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number | null;
  latencyMs?: number | null;
  finishReason?: string | null;
  occurredAt: Date | string;
  correlationId?: string | null;
}

export interface AgentRuntimeFactInput {
  organizationId: string;
  runId: string;
  agentDefinitionId: string;
  agentVersionId: string;
  installationId: string;
  correlationId?: string | null;
}

export interface ToolInvocationAnalyticsInput extends AgentRuntimeFactInput {
  toolInvocationId: string;
  providerToolCallId: string;
  toolName: string;
  toolVersion: string;
  riskClass: "read" | "draft" | "controlled-write" | "external-effect" | "privileged";
  action: "proposed" | "completed" | "failed";
  status: "proposed" | "awaiting_approval" | "approved" | "rejected" | "executing" | "completed" | "failed";
  sequenceNumber: number;
  requiresApproval: boolean;
  latencyMs?: number | null;
  effectId?: string | null;
  failureClass?: ReturnType<typeof classifyAgentFailure> | null;
  occurredAt: Date | string;
}

export interface ApprovalAnalyticsInput extends AgentRuntimeFactInput {
  approvalId: string;
  providerToolCallId: string;
  capability: string;
  capabilityVersion: string;
  action: "requested" | "approved" | "denied" | "cancelled" | "expired" | "consumed";
  status: "pending" | "approved" | "denied" | "expired" | "consumed" | "cancelled";
  actorType: "human" | "system";
  actorRef?: string | null;
  expiresAt?: Date | string | null;
  occurredAt: Date | string;
}

export interface EffectAnalyticsInput extends AgentRuntimeFactInput {
  effectId: string;
  providerToolCallId: string;
  capability: string;
  capabilityVersion: string;
  action: "reserved" | "executing" | "succeeded" | "failed" | "unknown" | "reconciled";
  status: "reserved" | "executing" | "succeeded" | "failed" | "unknown";
  reconciliationRequired: boolean;
  failureClass?: ReturnType<typeof classifyAgentFailure> | null;
  occurredAt: Date | string;
  completedAt?: Date | string | null;
}

export interface ScheduleAnalyticsInput {
  scheduleId: string;
  organizationId: string;
  agentDefinitionId: string;
  agentVersionId: string;
  installationId: string;
  action: "created" | "activated" | "paused" | "disabled";
  status: "active" | "paused" | "disabled";
  previousStatus: "active" | "paused" | "disabled" | null;
  timezone: string;
  nextRunAt: Date | string | null;
  actorType: "human" | "system";
  occurredAt: Date | string;
  correlationId?: string | null;
}

export interface InstallationLifecycleAnalyticsInput {
  installationId: string;
  organizationId: string;
  agentDefinitionId: string;
  agentVersionId: string;
  executionMode: AgentExecutionMode;
  creationProfile: AgentCreationProfile;
  agentAudience: AgentAudience;
  scopeType: "organization" | "user" | "business";
  action: "created" | "activated" | "paused" | "disabled";
  status: "active" | "paused" | "disabled";
  previousStatus: "active" | "paused" | "disabled" | null;
  actorType: "human" | "system";
  occurredAt: Date | string;
  correlationId?: string | null;
}

export type AgentReadinessBlockerCode =
  | "installation_inactive"
  | "workflow_invalid"
  | "capability_not_available"
  | "connection_not_configured"
  | "model_credential_missing";

export interface AgentReadinessAnalyticsInput {
  organizationId: string;
  installationId: string;
  agentDefinitionId: string;
  agentVersionId: string;
  executionMode: AgentExecutionMode;
  status: "ready" | "blocked";
  workflowStatus: "ready" | "blocked";
  credentialStatus: "ready" | "blocked" | "not_required";
  blockerCodes: readonly AgentReadinessBlockerCode[];
  requiredCapabilityCount: number;
  missingCapabilityCount: number;
  requiredConnectionCount: number;
  missingConnectionCount: number;
  evaluationSource: "readiness_route" | "readiness_sweep";
  observedAt: Date | string;
  correlationId?: string | null;
}

export function buildCompletedAgentRunEvent(input: CompletedAgentRunInput): AnalyticsOutboxRecord {
  const attributes: JsonObject = {
    run_id: input.runId,
    installation_id: input.installationId,
    agent_definition_id: input.agentDefinitionId,
    agent_version_id: input.agentVersionId,
    status: "completed",
    outcome: completedOutcome(input.output),
    occurred_at: input.finishedAt instanceof Date ? input.finishedAt.toISOString() : input.finishedAt,
    duration_ms: durationMilliseconds(input.startedAt, input.finishedAt, input.createdAt),
    trigger_type: input.triggerType,
    execution_mode: input.executionMode,
    creation_profile: input.creationProfile,
    agent_audience: input.agentAudience,
    deployment_surface: deploymentSurface(input),
  };
  return buildTerminalEvent(input, "agent.run.completed@1", "completed", attributes);
}

export function buildFailedAgentRunEvent(input: FailedAgentRunInput): AnalyticsOutboxRecord {
  const attributes: JsonObject = {
    run_id: input.runId,
    installation_id: input.installationId,
    agent_definition_id: input.agentDefinitionId,
    agent_version_id: input.agentVersionId,
    status: "failed",
    failure_class: classifyAgentFailure(input.error),
    occurred_at: input.finishedAt instanceof Date ? input.finishedAt.toISOString() : input.finishedAt,
    duration_ms: durationMilliseconds(input.startedAt, input.finishedAt, input.createdAt),
    trigger_type: input.triggerType,
    execution_mode: input.executionMode,
    creation_profile: input.creationProfile,
    agent_audience: input.agentAudience,
    deployment_surface: deploymentSurface(input),
  };
  return buildTerminalEvent(input, "agent.run.failed@1", "failed", attributes);
}

export function buildCompletedModelCallEvent(input: ModelCallAnalyticsInput): AnalyticsOutboxRecord {
  const attributes: JsonObject = {
    model_call_id: input.modelCallId,
    run_id: input.runId,
    provider: input.provider,
    model: input.model,
    funding_source: input.fundingSource,
    input_tokens: nonNegativeInteger(input.inputTokens),
    output_tokens: nonNegativeInteger(input.outputTokens),
    total_tokens: nonNegativeInteger(input.totalTokens),
    estimated_cost_usd: input.estimatedCostUsd ?? null,
    latency_ms: input.latencyMs ?? null,
    finish_reason: input.finishReason ?? null,
    status: "completed",
    occurred_at: input.occurredAt instanceof Date ? input.occurredAt.toISOString() : input.occurredAt,
  };
  return buildModelCallEvent(input, "agent.model_call.completed@1", "completed", attributes);
}

export function buildFailedModelCallEvent(
  input: ModelCallAnalyticsInput & { error: Record<string, unknown> },
): AnalyticsOutboxRecord {
  const attributes: JsonObject = {
    model_call_id: input.modelCallId,
    run_id: input.runId,
    provider: input.provider,
    model: input.model,
    funding_source: input.fundingSource,
    failure_class: classifyAgentFailure(input.error),
    status: "failed",
    occurred_at: input.occurredAt instanceof Date ? input.occurredAt.toISOString() : input.occurredAt,
  };
  return buildModelCallEvent(input, "agent.model_call.failed@1", "failed", attributes);
}

export function buildToolInvocationLifecycleEvent(input: ToolInvocationAnalyticsInput): AnalyticsOutboxRecord {
  const attributes: JsonObject = {
    tool_invocation_id: input.toolInvocationId,
    run_id: input.runId,
    agent_definition_id: input.agentDefinitionId,
    agent_version_id: input.agentVersionId,
    installation_id: input.installationId,
    provider_tool_call_id: input.providerToolCallId,
    tool_name: input.toolName,
    tool_version: input.toolVersion,
    risk_class: input.riskClass,
    action: input.action,
    status: input.status,
    sequence_number: input.sequenceNumber,
    requires_approval: input.requiresApproval,
    latency_ms: input.latencyMs ?? null,
    effect_id: input.effectId ?? null,
    failure_class: input.failureClass ?? null,
    occurred_at: timestampAttribute(input.occurredAt),
  };
  return buildEvent({
    recordId: `tool-invocation:${input.toolInvocationId}:${input.action}`,
    sourceDomain: "agents",
    sourceStreamKey: `organization:${input.organizationId}:tool-invocations`,
    contractName: "agent.tool_invocation.lifecycle@1",
    schemaVersion: 1,
    scopeKind: "core_organization",
    scopeExternalId: input.organizationId,
    subject: `tool-invocation:${input.toolInvocationId}`,
    occurredAt: input.occurredAt,
    attributes,
    correlationId: input.correlationId ?? undefined,
    idempotencyKey: `agent-platform:tool-invocation:${input.toolInvocationId}:${input.action}`,
  });
}

export function buildApprovalLifecycleEvent(input: ApprovalAnalyticsInput): AnalyticsOutboxRecord {
  const attributes: JsonObject = {
    approval_id: input.approvalId,
    run_id: input.runId,
    agent_definition_id: input.agentDefinitionId,
    agent_version_id: input.agentVersionId,
    installation_id: input.installationId,
    provider_tool_call_id: input.providerToolCallId,
    capability: input.capability,
    capability_version: input.capabilityVersion,
    action: input.action,
    status: input.status,
    actor_type: input.actorType,
    actor_ref: input.actorRef ?? null,
    expires_at: input.expiresAt == null ? null : timestampAttribute(input.expiresAt),
    occurred_at: timestampAttribute(input.occurredAt),
  };
  return buildEvent({
    recordId: `approval:${input.approvalId}:${input.action}`,
    sourceDomain: "agents",
    sourceStreamKey: `organization:${input.organizationId}:approvals`,
    contractName: "agent.approval.lifecycle@1",
    schemaVersion: 1,
    scopeKind: "core_organization",
    scopeExternalId: input.organizationId,
    subject: `approval:${input.approvalId}`,
    occurredAt: input.occurredAt,
    attributes,
    correlationId: input.correlationId ?? undefined,
    idempotencyKey: `agent-platform:approval:${input.approvalId}:${input.action}`,
  });
}

export function buildEffectLifecycleEvent(input: EffectAnalyticsInput): AnalyticsOutboxRecord {
  const attributes: JsonObject = {
    effect_id: input.effectId,
    run_id: input.runId,
    agent_definition_id: input.agentDefinitionId,
    agent_version_id: input.agentVersionId,
    installation_id: input.installationId,
    provider_tool_call_id: input.providerToolCallId,
    capability: input.capability,
    capability_version: input.capabilityVersion,
    action: input.action,
    status: input.status,
    reconciliation_required: input.reconciliationRequired,
    failure_class: input.failureClass ?? null,
    occurred_at: timestampAttribute(input.occurredAt),
    completed_at: input.completedAt == null ? null : timestampAttribute(input.completedAt),
  };
  return buildEvent({
    recordId: `effect:${input.effectId}:${input.action}`,
    sourceDomain: "agents",
    sourceStreamKey: `organization:${input.organizationId}:effects`,
    contractName: "agent.effect.lifecycle@1",
    schemaVersion: 1,
    scopeKind: "core_organization",
    scopeExternalId: input.organizationId,
    subject: `effect:${input.effectId}`,
    occurredAt: input.occurredAt,
    attributes,
    correlationId: input.correlationId ?? undefined,
    idempotencyKey: `agent-platform:effect:${input.effectId}:${input.action}`,
  });
}

export function buildScheduleLifecycleEvent(input: ScheduleAnalyticsInput): AnalyticsOutboxRecord {
  const occurredAt = timestampAttribute(input.occurredAt);
  const attributes: JsonObject = {
    schedule_id: input.scheduleId,
    agent_definition_id: input.agentDefinitionId,
    agent_version_id: input.agentVersionId,
    installation_id: input.installationId,
    action: input.action,
    status: input.status,
    previous_status: input.previousStatus,
    timezone: input.timezone,
    next_run_at: input.nextRunAt == null ? null : timestampAttribute(input.nextRunAt),
    actor_type: input.actorType,
    occurred_at: occurredAt,
  };
  const identity = `schedule:${input.scheduleId}:${input.action}:${input.status}:${occurredAt}`;
  return buildEvent({
    recordId: identity,
    sourceDomain: "agents",
    sourceStreamKey: `organization:${input.organizationId}:schedules`,
    contractName: "agent.schedule.lifecycle@1",
    schemaVersion: 1,
    scopeKind: "core_organization",
    scopeExternalId: input.organizationId,
    subject: `schedule:${input.scheduleId}`,
    occurredAt: input.occurredAt,
    attributes,
    correlationId: input.correlationId ?? undefined,
    idempotencyKey: `agent-platform:${identity}`,
  });
}

export function buildInstallationLifecycleEvent(input: InstallationLifecycleAnalyticsInput): AnalyticsOutboxRecord {
  const occurredAt = timestampAttribute(input.occurredAt);
  const attributes: JsonObject = {
    installation_id: input.installationId,
    agent_definition_id: input.agentDefinitionId,
    agent_version_id: input.agentVersionId,
    execution_mode: input.executionMode,
    creation_profile: input.creationProfile,
    agent_audience: input.agentAudience,
    scope_type: input.scopeType,
    action: input.action,
    status: input.status,
    previous_status: input.previousStatus,
    actor_type: input.actorType,
    occurred_at: occurredAt,
  };
  const identity = `installation:${input.installationId}:${input.action}:${input.status}:${occurredAt}`;
  return buildEvent({
    recordId: identity,
    sourceDomain: "agents",
    sourceStreamKey: `organization:${input.organizationId}:installations`,
    contractName: "agent.installation.lifecycle@1",
    schemaVersion: 1,
    scopeKind: "core_organization",
    scopeExternalId: input.organizationId,
    subject: `installation:${input.installationId}`,
    occurredAt: input.occurredAt,
    attributes,
    correlationId: input.correlationId ?? undefined,
    idempotencyKey: `agent-platform:${identity}`,
  });
}

export function readinessStateFingerprint(input: AgentReadinessAnalyticsInput): string {
  return canonicalStateFingerprint(input);
}

export function buildReadinessSnapshotEvent(input: AgentReadinessAnalyticsInput): AnalyticsOutboxRecord {
  const observedAt = timestampAttribute(input.observedAt);
  const blockerCodes = [...new Set(input.blockerCodes)].sort();
  const blockerSet = blockerCodes.length ? blockerCodes.join("|") : "none";
  const stateFingerprint = canonicalStateFingerprint(input);
  const attributes: JsonObject = {
    installation_id: input.installationId,
    agent_definition_id: input.agentDefinitionId,
    agent_version_id: input.agentVersionId,
    execution_mode: input.executionMode,
    status: input.status,
    workflow_status: input.workflowStatus,
    credential_status: input.credentialStatus,
    blocker_codes: blockerCodes,
    blocker_set: blockerSet,
    blocker_count: blockerCodes.length,
    required_capability_count: nonNegativeInteger(input.requiredCapabilityCount),
    missing_capability_count: nonNegativeInteger(input.missingCapabilityCount),
    required_connection_count: nonNegativeInteger(input.requiredConnectionCount),
    missing_connection_count: nonNegativeInteger(input.missingConnectionCount),
    evaluation_source: input.evaluationSource,
    state_fingerprint: stateFingerprint,
    observed_at: observedAt,
  };
  const identity = `readiness:${input.installationId}:${observedAt}:${stateFingerprint}`;
  return buildEvent({
    recordId: identity,
    sourceDomain: "agents",
    sourceStreamKey: `organization:${input.organizationId}:readiness`,
    contractName: "agent.readiness.snapshot@1",
    schemaVersion: 1,
    scopeKind: "core_organization",
    scopeExternalId: input.organizationId,
    subject: `installation:${input.installationId}`,
    occurredAt: input.observedAt,
    attributes,
    correlationId: input.correlationId ?? undefined,
    idempotencyKey: `agent-platform:${identity}`,
  });
}

function buildTerminalEvent(
  input: AgentRunTerminalInput,
  contractName: "agent.run.completed@1" | "agent.run.failed@1",
  terminalStatus: "completed" | "failed",
  attributes: JsonObject,
): AnalyticsOutboxRecord {
  return buildEvent({
    recordId: `run:${input.runId}:${terminalStatus}`,
    sourceDomain: "agents",
    sourceStreamKey: `organization:${input.organizationId}:agent-runs`,
    contractName,
    schemaVersion: 1,
    scopeKind: "core_organization",
    scopeExternalId: input.organizationId,
    subject: `run:${input.runId}`,
    occurredAt: input.finishedAt,
    attributes,
    correlationId: input.correlationId,
    causationId: input.causationId ?? undefined,
    idempotencyKey: `agent-platform:run:${input.runId}:${terminalStatus}`,
  });
}

function buildModelCallEvent(
  input: ModelCallAnalyticsInput,
  contractName: "agent.model_call.completed@1" | "agent.model_call.failed@1",
  terminalStatus: "completed" | "failed",
  attributes: JsonObject,
): AnalyticsOutboxRecord {
  return buildEvent({
    recordId: `model-call:${input.modelCallId}:${terminalStatus}`,
    sourceDomain: "agents",
    sourceStreamKey: `organization:${input.organizationId}:model-calls`,
    contractName,
    schemaVersion: 1,
    scopeKind: "core_organization",
    scopeExternalId: input.organizationId,
    subject: `model-call:${input.modelCallId}`,
    occurredAt: input.occurredAt,
    attributes,
    correlationId: input.correlationId ?? undefined,
    idempotencyKey: `agent-platform:model-call:${input.modelCallId}:${terminalStatus}`,
  });
}

function completedOutcome(output: Record<string, unknown>): "success" | "partial" | "no_effect" {
  return output.outcome === "partial" || output.outcome === "no_effect" || output.outcome === "success"
    ? output.outcome
    : "success";
}

export function classifyAgentFailure(error: Record<string, unknown>): "validation" | "provider" | "tool" | "timeout" | "policy" | "unknown" {
  const code = typeof error.code === "string" ? error.code.toUpperCase() : "";
  if (/TIMEOUT|DEADLINE|TTL|EXPIRED/.test(code)) return "timeout";
  if (/PROVIDER|MODEL|CREDENTIAL/.test(code)) return "provider";
  if (/TOOL|MCP|EXTERNAL|CONNECTOR/.test(code)) return "tool";
  if (/POLICY|APPROVAL|PERMISSION|AUTH|CONCURRENCY|HOLD/.test(code)) return "policy";
  if (/VALID|INPUT|SCHEMA|ARGUMENT/.test(code)) return "validation";
  return "unknown";
}

function nonNegativeInteger(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 0 ? value : 0;
}

function timestampAttribute(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function deploymentSurface(input: AgentRunTerminalInput): AgentDeploymentSurface {
  if (input.conversationId) return "conversation";
  if (isMcpToolInput(input.input)) return "external_operation";
  return "direct";
}

function isMcpToolInput(input: Record<string, unknown>): boolean {
  return input.mcpTool !== null && typeof input.mcpTool === "object" && !Array.isArray(input.mcpTool);
}

function durationMilliseconds(
  startedAt: Date | string | null,
  finishedAt: Date | string,
  createdAt: Date | string,
): number {
  const start = Date.parse(startedAt instanceof Date ? startedAt.toISOString() : startedAt ?? (createdAt instanceof Date ? createdAt.toISOString() : createdAt));
  const finish = Date.parse(finishedAt instanceof Date ? finishedAt.toISOString() : finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return 0;
  return Math.max(0, Math.round(finish - start));
}

function canonicalStateFingerprint(input: AgentReadinessAnalyticsInput): string {
  const blockerCodes = [...new Set(input.blockerCodes)].sort();
  return canonicalJsonSha256({
    installation_id: input.installationId,
    agent_definition_id: input.agentDefinitionId,
    agent_version_id: input.agentVersionId,
    execution_mode: input.executionMode,
    status: input.status,
    workflow_status: input.workflowStatus,
    credential_status: input.credentialStatus,
    blocker_codes: blockerCodes,
    required_capability_count: nonNegativeInteger(input.requiredCapabilityCount),
    missing_capability_count: nonNegativeInteger(input.missingCapabilityCount),
    required_connection_count: nonNegativeInteger(input.requiredConnectionCount),
    missing_connection_count: nonNegativeInteger(input.missingConnectionCount),
    evaluation_source: input.evaluationSource,
  });
}
