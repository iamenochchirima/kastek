import type { ModelMessage } from "../model/types";
import { agentUiSchema, type AgentUi } from "../media/dynamic-ui";
import type { AgentLoopResult } from "./loop";
import type { TranscriptSourceIdentity } from "./tool-transcript";
import { transcriptDigest, validateModelTranscript } from "./transcript";

export const AGENT_LOOP_CHECKPOINT_VERSION = 2;
const LEGACY_AGENT_LOOP_CHECKPOINT_VERSION = 1;

export interface DurableAgentLoopCheckpoint {
  version: typeof AGENT_LOOP_CHECKPOINT_VERSION;
  messages: ModelMessage[];
  iterations: number;
  toolCalls: number;
  /** The workflow input step that produced this checkpoint. */
  stepIndex?: number;
  /** Stable logical turn owning this checkpoint. */
  turnId?: string;
  /** Ordered transcript cursor represented by messages. */
  transcriptCursor: number;
  /** Digest of the exact ordered transcript represented by messages. */
  transcriptDigest: string;
  /** Context projection generation used for the model request. */
  compactionGeneration: number;
  /** The activity result needed if the worker is lost before the result is acknowledged. */
  status?: "limited" | "awaiting_approval" | "awaiting_human" | "awaiting_external_event";
  pendingToolCalls?: Array<{ id: string; providerToolCallId?: string; name: string; arguments: Record<string, unknown>; argumentsHash: string; approvalGroupId?: string; approvalPlanDigest?: string }>;
  toolBatchPending?: boolean;
  authorizedToolNames?: string[];
  capabilitySnapshotDigest?: string;
  /** Canonical transcript identity used by the deferred model request. */
  transcriptSource?: TranscriptSourceIdentity;
  waitingFor?: string;
  ui?: AgentUi;
}

// A checkpoint must retain the complete tool-result transcript for one
// deferred batch. The approval contract is verified through 256-operation
// barriers, and the run may already contain several model turns, so the limit
// needs room for the batch and its surrounding messages.
const MAX_CHECKPOINT_MESSAGES = 2_048;
const MAX_CHECKPOINT_CHARACTERS = 256_000;

/**
 * The activity boundary stores only the model conversation needed to continue a run. Invalid or
 * oversized state is rejected instead of letting a corrupted checkpoint reach a provider.
 */
export function readDurableAgentLoopCheckpoint(value: unknown): DurableAgentLoopCheckpoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const legacy = record.version === LEGACY_AGENT_LOOP_CHECKPOINT_VERSION;
  if ((!legacy && record.version !== AGENT_LOOP_CHECKPOINT_VERSION) || !Array.isArray(record.messages)) return undefined;
  const messages = record.messages.filter(isModelMessage);
  if (messages.length !== record.messages.length || messages.length > MAX_CHECKPOINT_MESSAGES) return undefined;
  if (messages.reduce((total, message) => total + message.content.length, 0) > MAX_CHECKPOINT_CHARACTERS) return undefined;
  const iterations = boundedCounter(record.iterations);
  const toolCalls = boundedCounter(record.toolCalls);
  if (iterations === undefined || toolCalls === undefined) return undefined;
  const stepIndex = record.stepIndex === undefined ? undefined : boundedCounter(record.stepIndex);
  if (record.stepIndex !== undefined && stepIndex === undefined) return undefined;
  const status = checkpointStatus(record.status);
  if (record.status !== undefined && !status) return undefined;
  const transcriptIssues = validateModelTranscript(messages);
  const allowsPendingApprovalRound = status === "awaiting_approval"
    && transcriptIssues.length > 0
    && transcriptIssues.every((issue) => issue.code === "missing_tool_result");
  const allowsPendingToolBatch = record.toolBatchPending === true
    && Array.isArray(record.pendingToolCalls)
    && record.pendingToolCalls.length > 0
    && Array.isArray(record.authorizedToolNames)
    && record.authorizedToolNames.length > 0
    && transcriptIssues.length > 0
    && transcriptIssues.every((issue) => issue.code === "missing_tool_result");
  if (transcriptIssues.length > 0 && !allowsPendingApprovalRound && !allowsPendingToolBatch) return undefined;
  const transcriptCursor = legacy
    ? messages.length
    : boundedCounter(record.transcriptCursor);
  if (transcriptCursor === undefined || transcriptCursor !== messages.length) return undefined;
  const digest = transcriptDigest(messages);
  if (!legacy && record.transcriptDigest !== digest) return undefined;
  const compactionGeneration = legacy
    ? 0
    : boundedCounter(record.compactionGeneration);
  if (compactionGeneration === undefined) return undefined;
  if (record.turnId !== undefined && typeof record.turnId !== "string") return undefined;
  const pendingToolCalls = readPendingToolCalls(record.pendingToolCalls);
  if (record.pendingToolCalls !== undefined && !pendingToolCalls) return undefined;
  const authorizedToolNames = readAuthorizedToolNames(record.authorizedToolNames);
  if (record.toolBatchPending === true && !authorizedToolNames) return undefined;
  if (record.authorizedToolNames !== undefined && !authorizedToolNames) return undefined;
  if (record.capabilitySnapshotDigest !== undefined && typeof record.capabilitySnapshotDigest !== "string") return undefined;
  const transcriptSource = readTranscriptSource(record.transcriptSource);
  if (record.transcriptSource !== undefined && !transcriptSource) return undefined;
  if (record.waitingFor !== undefined && typeof record.waitingFor !== "string") return undefined;
  const ui = record.ui === undefined ? undefined : agentUiSchema.safeParse(record.ui);
  if (record.ui !== undefined && (!ui || !ui.success)) return undefined;
  return {
    version: AGENT_LOOP_CHECKPOINT_VERSION,
    messages,
    iterations,
    toolCalls,
    transcriptCursor,
    transcriptDigest: digest,
    compactionGeneration,
    ...(typeof record.turnId === "string" ? { turnId: record.turnId } : {}),
    ...(stepIndex === undefined ? {} : { stepIndex }),
    ...(status === undefined ? {} : { status }),
    ...(pendingToolCalls === undefined ? {} : { pendingToolCalls }),
    ...(record.toolBatchPending === true ? { toolBatchPending: true } : {}),
    ...(authorizedToolNames === undefined ? {} : { authorizedToolNames }),
    ...(typeof record.capabilitySnapshotDigest === "string" ? { capabilitySnapshotDigest: record.capabilitySnapshotDigest } : {}),
    ...(transcriptSource === undefined ? {} : { transcriptSource }),
    ...(typeof record.waitingFor === "string" ? { waitingFor: record.waitingFor } : {}),
    ...(ui?.success ? { ui: ui.data } : {}),
  };
}

export function durableAgentLoopCheckpoint(
  result: Pick<AgentLoopResult, "messages" | "iterations" | "toolCalls">
    & Partial<Pick<AgentLoopResult, "status" | "pendingToolCalls" | "toolBatchPending" | "authorizedToolNames" | "capabilitySnapshotDigest" | "transcriptSource" | "waitingFor" | "ui">>,
  previous?: DurableAgentLoopCheckpoint,
  options: { stepIndex?: number; turnId?: string; compactionGeneration?: number } = {},
): DurableAgentLoopCheckpoint {
  const checkpoint = {
    version: AGENT_LOOP_CHECKPOINT_VERSION as typeof AGENT_LOOP_CHECKPOINT_VERSION,
    messages: result.messages,
    iterations: (previous?.iterations ?? 0) + Math.max(0, Math.trunc(result.iterations)),
    toolCalls: (previous?.toolCalls ?? 0) + Math.max(0, Math.trunc(result.toolCalls)),
    transcriptCursor: result.messages.length,
    transcriptDigest: transcriptDigest(result.messages),
    compactionGeneration: options.compactionGeneration ?? previous?.compactionGeneration ?? 0,
    ...(options.stepIndex === undefined ? {} : { stepIndex: options.stepIndex }),
    ...(options.turnId === undefined ? (previous?.turnId === undefined ? {} : { turnId: previous.turnId }) : { turnId: options.turnId }),
    ...(result.status === "limited" || result.status === "awaiting_approval" || result.status === "awaiting_human" || result.status === "awaiting_external_event" ? { status: result.status } : {}),
    ...(result.pendingToolCalls ? { pendingToolCalls: result.pendingToolCalls } : {}),
    ...(result.toolBatchPending ? { toolBatchPending: true } : {}),
    ...(result.authorizedToolNames ? { authorizedToolNames: [...new Set(result.authorizedToolNames)].sort() } : {}),
    ...(result.capabilitySnapshotDigest ? { capabilitySnapshotDigest: result.capabilitySnapshotDigest } : {}),
    ...(result.transcriptSource === undefined ? {} : { transcriptSource: result.transcriptSource }),
    ...(result.waitingFor ? { waitingFor: result.waitingFor } : {}),
    ...(result.ui ? { ui: result.ui } : {}),
  } satisfies DurableAgentLoopCheckpoint;
  if (checkpoint.messages.length > MAX_CHECKPOINT_MESSAGES || checkpoint.messages.reduce((total, message) => total + message.content.length, 0) > MAX_CHECKPOINT_CHARACTERS) {
    throw new Error("AGENT_LOOP_CHECKPOINT_TOO_LARGE");
  }
  const transcriptIssues = validateModelTranscript(checkpoint.messages);
  const allowsPendingToolBatch = checkpoint.toolBatchPending === true
    && checkpoint.pendingToolCalls !== undefined
    && checkpoint.pendingToolCalls.length > 0
    && checkpoint.authorizedToolNames !== undefined
    && checkpoint.authorizedToolNames.length > 0
    && transcriptIssues.length > 0
    && transcriptIssues.every((issue) => issue.code === "missing_tool_result");
  const allowsPendingApprovalRound = checkpoint.status === "awaiting_approval"
    && transcriptIssues.length > 0
    && transcriptIssues.every((issue) => issue.code === "missing_tool_result");
  if (transcriptIssues.length > 0 && !allowsPendingApprovalRound && !allowsPendingToolBatch) throw new Error("AGENT_LOOP_CHECKPOINT_TRANSCRIPT_INVALID");
  return checkpoint;
}

function readAuthorizedToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_000) return undefined;
  const names = value.filter((name): name is string => typeof name === "string" && name.trim().length > 0 && name.length <= 240);
  if (names.length !== value.length) return undefined;
  const unique = [...new Set(names)].sort();
  return unique.length === names.length ? unique : undefined;
}

function boundedCounter(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function checkpointStatus(value: unknown): DurableAgentLoopCheckpoint["status"] {
  return value === "limited" || value === "awaiting_approval" || value === "awaiting_human" || value === "awaiting_external_event"
    ? value
    : undefined;
}

function readPendingToolCalls(value: unknown): DurableAgentLoopCheckpoint["pendingToolCalls"] {
  if (!Array.isArray(value)) return undefined;
  const pending = value.filter((toolCall): toolCall is NonNullable<DurableAgentLoopCheckpoint["pendingToolCalls"]>[number] => {
    if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return false;
    const record = toolCall as Record<string, unknown>;
    return typeof record.id === "string"
      && (record.providerToolCallId === undefined || typeof record.providerToolCallId === "string")
      && typeof record.name === "string"
      && typeof record.argumentsHash === "string"
      && (record.approvalGroupId === undefined || typeof record.approvalGroupId === "string")
      && (record.approvalPlanDigest === undefined || typeof record.approvalPlanDigest === "string")
      && Boolean(record.arguments)
      && typeof record.arguments === "object"
      && !Array.isArray(record.arguments);
  });
  return pending.length === value.length ? pending : undefined;
}

function readTranscriptSource(value: unknown): TranscriptSourceIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const generation = boundedCounter(source.generation);
  const cursor = boundedCounter(source.cursor);
  if (generation === undefined || cursor === undefined) return undefined;
  if (typeof source.headDigest !== "string" || !/^[0-9a-f]{64}$/iu.test(source.headDigest)) return undefined;
  if (typeof source.projectionDigest !== "string" || !/^[0-9a-f]{64}$/iu.test(source.projectionDigest)) return undefined;
  return {
    generation,
    cursor,
    headDigest: source.headDigest,
    projectionDigest: source.projectionDigest,
  };
}

function isModelMessage(value: unknown): value is ModelMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (!["system", "user", "assistant", "tool"].includes(String(message.role)) || typeof message.content !== "string") return false;
  if (message.toolCallId !== undefined && typeof message.toolCallId !== "string") return false;
  if (message.runtimeOperationId !== undefined && typeof message.runtimeOperationId !== "string") return false;
  if (message.name !== undefined && typeof message.name !== "string") return false;
  if (message.toolCalls !== undefined && (!Array.isArray(message.toolCalls) || message.toolCalls.some((toolCall) => {
    if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return true;
    const record = toolCall as Record<string, unknown>;
    return typeof record.id !== "string" || typeof record.name !== "string" || (record.runtimeOperationId !== undefined && typeof record.runtimeOperationId !== "string") || !record.arguments || typeof record.arguments !== "object" || Array.isArray(record.arguments);
  }))) return false;
  return true;
}
