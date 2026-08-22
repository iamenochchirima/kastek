import { buildEvent, type AnalyticsOutboxRecord, type JsonObject } from "./producer";

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
