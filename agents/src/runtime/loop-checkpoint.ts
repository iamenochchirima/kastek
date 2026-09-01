import type { ModelMessage } from "../model/types";
import type { AgentLoopResult } from "./loop";

export const AGENT_LOOP_CHECKPOINT_VERSION = 1;

export interface DurableAgentLoopCheckpoint {
  version: typeof AGENT_LOOP_CHECKPOINT_VERSION;
  messages: ModelMessage[];
  iterations: number;
  toolCalls: number;
}

const MAX_CHECKPOINT_MESSAGES = 128;
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
  return { version: AGENT_LOOP_CHECKPOINT_VERSION, messages, iterations, toolCalls };
}

export function durableAgentLoopCheckpoint(result: Pick<AgentLoopResult, "messages" | "iterations" | "toolCalls">, previous?: DurableAgentLoopCheckpoint): DurableAgentLoopCheckpoint {
  const checkpoint = {
    version: AGENT_LOOP_CHECKPOINT_VERSION as typeof AGENT_LOOP_CHECKPOINT_VERSION,
    messages: result.messages,
    iterations: (previous?.iterations ?? 0) + Math.max(0, Math.trunc(result.iterations)),
    toolCalls: (previous?.toolCalls ?? 0) + Math.max(0, Math.trunc(result.toolCalls)),
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
