import type { ModelMessage } from "../model/types";
import { agentUiSchema, type AgentUi } from "../media/dynamic-ui";
import type { AgentLoopResult } from "./loop";

export const AGENT_LOOP_CHECKPOINT_VERSION = 1;

export interface DurableAgentLoopCheckpoint {
  version: typeof AGENT_LOOP_CHECKPOINT_VERSION;
  messages: ModelMessage[];
  iterations: number;
  toolCalls: number;
  /** The workflow input step that produced this checkpoint. */
  stepIndex?: number;
  /** The activity result needed if the worker is lost before the result is acknowledged. */
  status?: "limited" | "awaiting_approval" | "awaiting_human" | "awaiting_external_event";
  pendingToolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown>; argumentsHash: string }>;
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
  if (record.version !== AGENT_LOOP_CHECKPOINT_VERSION || !Array.isArray(record.messages)) return undefined;
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
  const pendingToolCalls = readPendingToolCalls(record.pendingToolCalls);
  if (record.pendingToolCalls !== undefined && !pendingToolCalls) return undefined;
  if (record.waitingFor !== undefined && typeof record.waitingFor !== "string") return undefined;
  const ui = record.ui === undefined ? undefined : agentUiSchema.safeParse(record.ui);
  if (record.ui !== undefined && (!ui || !ui.success)) return undefined;
  return {
    version: AGENT_LOOP_CHECKPOINT_VERSION,
    messages,
    iterations,
    toolCalls,
    ...(stepIndex === undefined ? {} : { stepIndex }),
    ...(status === undefined ? {} : { status }),
    ...(pendingToolCalls === undefined ? {} : { pendingToolCalls }),
    ...(typeof record.waitingFor === "string" ? { waitingFor: record.waitingFor } : {}),
    ...(ui?.success ? { ui: ui.data } : {}),
  };
}

export function durableAgentLoopCheckpoint(
  result: Pick<AgentLoopResult, "messages" | "iterations" | "toolCalls">
    & Partial<Pick<AgentLoopResult, "status" | "pendingToolCalls" | "waitingFor" | "ui">>,
  previous?: DurableAgentLoopCheckpoint,
  options: { stepIndex?: number } = {},
): DurableAgentLoopCheckpoint {
  const checkpoint = {
    version: AGENT_LOOP_CHECKPOINT_VERSION as typeof AGENT_LOOP_CHECKPOINT_VERSION,
    messages: result.messages,
    iterations: (previous?.iterations ?? 0) + Math.max(0, Math.trunc(result.iterations)),
    toolCalls: (previous?.toolCalls ?? 0) + Math.max(0, Math.trunc(result.toolCalls)),
    ...(options.stepIndex === undefined ? {} : { stepIndex: options.stepIndex }),
    ...(result.status === "limited" || result.status === "awaiting_approval" || result.status === "awaiting_human" || result.status === "awaiting_external_event" ? { status: result.status } : {}),
    ...(result.pendingToolCalls ? { pendingToolCalls: result.pendingToolCalls } : {}),
    ...(result.waitingFor ? { waitingFor: result.waitingFor } : {}),
    ...(result.ui ? { ui: result.ui } : {}),
  } satisfies DurableAgentLoopCheckpoint;
  if (checkpoint.messages.length > MAX_CHECKPOINT_MESSAGES || checkpoint.messages.reduce((total, message) => total + message.content.length, 0) > MAX_CHECKPOINT_CHARACTERS) {
    throw new Error("AGENT_LOOP_CHECKPOINT_TOO_LARGE");
  }
  return checkpoint;
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
      && typeof record.name === "string"
      && typeof record.argumentsHash === "string"
      && Boolean(record.arguments)
      && typeof record.arguments === "object"
      && !Array.isArray(record.arguments);
  });
  return pending.length === value.length ? pending : undefined;
}

function isModelMessage(value: unknown): value is ModelMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (!["system", "user", "assistant", "tool"].includes(String(message.role)) || typeof message.content !== "string") return false;
  if (message.toolCallId !== undefined && typeof message.toolCallId !== "string") return false;
  if (message.name !== undefined && typeof message.name !== "string") return false;
  if (message.toolCalls !== undefined && (!Array.isArray(message.toolCalls) || message.toolCalls.some((toolCall) => {
    if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return true;
    const record = toolCall as Record<string, unknown>;
    return typeof record.id !== "string" || typeof record.name !== "string" || !record.arguments || typeof record.arguments !== "object" || Array.isArray(record.arguments);
  }))) return false;
  return true;
}
