import type { ModelMessage, ModelProvider, ModelResponse } from "../model/types";
import type { ToolApproval } from "../tools/types";
import type { ActivityScope, ApprovalSignal, ExternalEventSignal } from "./contracts";

/**
 * Versioned contract for the independently retryable activities used by eligible
 * ordinary runs. Activity payloads intentionally carry references to
 * durable run state, not prompts, model responses, tool arguments, or tool
 * output. Those values stay in Agents PostgreSQL and are addressed by IDs.
 */
export const DECOMPOSED_ACTIVITY_PROTOCOL_VERSION = 1 as const;

export type DecomposedActivityKind = "context" | "model" | "tool" | "checkpoint" | "completion";

export interface DecomposedActivityIdentity {
  runId: string;
  /** Monotonic logical operation number owned by the Temporal workflow. */
  step: number;
  /** Stable operation identity used by database ledgers and provider settlement. */
  operationKey: string;
}

export interface DecomposedContextActivityInput {
  protocolVersion: typeof DECOMPOSED_ACTIVITY_PROTOCOL_VERSION;
  runId: string;
}

export interface DecomposedContextActivityResult {
  protocolVersion: typeof DECOMPOSED_ACTIVITY_PROTOCOL_VERSION;
  stateRevision: number;
  nextPhase: "model" | "tool" | "completed" | "awaiting_approval" | "awaiting_human" | "awaiting_external_event" | "failed" | "unsupported";
  pendingToolCallIds?: string[];
  nextStep?: number;
  waitingFor?: string;
}

export interface DecomposedModelActivityInput extends DecomposedActivityIdentity {
  protocolVersion: typeof DECOMPOSED_ACTIVITY_PROTOCOL_VERSION;
  /** Revision of the durable loop state that the model activity must read. */
  inputStateRevision: number;
  /** Human or external event that resumes a previously paused tool outcome. */
  resumeExternalEvent?: ExternalEventSignal;
}

export interface DecomposedModelActivityResult {
  protocolVersion: typeof DECOMPOSED_ACTIVITY_PROTOCOL_VERSION;
  stateRevision: number;
  status: "tool_calls" | "completed" | "awaiting_approval" | "awaiting_human" | "awaiting_external_event" | "failed";
  /** Only durable invocation IDs cross the workflow boundary. */
  toolCallIds?: string[];
  errorCode?: string;
  waitingFor?: string;
  terminal?: boolean;
}

export interface DecomposedToolActivityInput extends DecomposedActivityIdentity {
  protocolVersion: typeof DECOMPOSED_ACTIVITY_PROTOCOL_VERSION;
  providerToolCallId: string;
  approval?: ToolApproval;
}

export interface DecomposedToolActivityResult {
  protocolVersion: typeof DECOMPOSED_ACTIVITY_PROTOCOL_VERSION;
  stateRevision: number;
  providerToolCallId: string;
  status: "completed" | "awaiting_approval" | "awaiting_human" | "awaiting_external_event" | "failed";
  errorCode?: string;
  waitingFor?: string;
  terminal?: boolean;
}

export interface DecomposedCheckpointActivityInput extends DecomposedActivityIdentity {
  protocolVersion: typeof DECOMPOSED_ACTIVITY_PROTOCOL_VERSION;
  stateRevision: number;
  phase: "model" | "tool" | "awaiting_approval" | "awaiting_human" | "awaiting_external_event" | "completed" | "failed";
}

export interface DecomposedCheckpointActivityResult {
  protocolVersion: typeof DECOMPOSED_ACTIVITY_PROTOCOL_VERSION;
  stateRevision: number;
}

export interface DecomposedCompletionActivityInput {
  protocolVersion: typeof DECOMPOSED_ACTIVITY_PROTOCOL_VERSION;
  runId: string;
  stateRevision: number;
}

export interface DecomposedActivityFailure {
  code: string;
  message: string;
}

export interface DecomposedCompletionActivityResult {
  protocolVersion: typeof DECOMPOSED_ACTIVITY_PROTOCOL_VERSION;
  stateRevision: number;
}

export interface DecomposedAgentRunActivities {
  buildLoopContext(input: ActivityScope & DecomposedContextActivityInput): Promise<DecomposedContextActivityResult>;
  executeModelStep(input: ActivityScope & DecomposedModelActivityInput): Promise<DecomposedModelActivityResult>;
  executeToolStep(input: ActivityScope & DecomposedToolActivityInput): Promise<DecomposedToolActivityResult>;
  checkpointLoop(input: ActivityScope & DecomposedCheckpointActivityInput): Promise<DecomposedCheckpointActivityResult>;
  completeRunFromCheckpoint(input: ActivityScope & DecomposedCompletionActivityInput): Promise<DecomposedCompletionActivityResult>;
}

export interface DecomposedApprovalWait {
  providerToolCallId: string;
  decision: ApprovalSignal;
}

export interface DecomposedExternalEventWait {
  event: ExternalEventSignal;
}

/**
 * Deterministic operation identity. Keep this function free of timestamps,
 * random IDs, and provider payloads so a replaying workflow derives the same
 * key on every worker.
 */
export function decomposedOperationKey(input: {
  runId: string;
  step: number;
  kind: DecomposedActivityKind;
  operationId?: string;
}): string {
  const runId = boundedSegment(input.runId, "runId");
  const step = boundedStep(input.step);
  const operationId = input.operationId ? `:${boundedSegment(input.operationId, "operationId")}` : "";
  return `agent:${DECOMPOSED_ACTIVITY_PROTOCOL_VERSION}:${runId}:${step}:${input.kind}${operationId}`;
}

/** Runtime-only type guards used by activity implementations before touching state. */
export function isDecomposedModelResponse(value: unknown): value is ModelResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Partial<ModelResponse>;
  return typeof response.provider === "string"
    && typeof response.model === "string"
    && Boolean(response.message && typeof response.message === "object")
    && Array.isArray(response.toolCalls)
    && Boolean(response.usage && typeof response.usage === "object");
}

export function isDecomposedMessage(value: unknown): value is ModelMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<ModelMessage>;
  return (message.role === "system" || message.role === "user" || message.role === "assistant" || message.role === "tool")
    && typeof message.content === "string";
}

function boundedSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240 || /[\r\n]/.test(normalized)) throw new Error(`DECOMPOSED_${label.toUpperCase()}_INVALID`);
  return normalized;
}

function boundedStep(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) throw new Error("DECOMPOSED_STEP_INVALID");
  return value;
}
