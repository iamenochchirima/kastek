import type { ModelMessage, ModelResponse } from "../model/types";
import type { AgentResponse } from "../media/contracts";
import { DECOMPOSED_ACTIVITY_PROTOCOL_VERSION } from "./decomposed-contracts";

export interface DecomposedLoopState {
  version: typeof DECOMPOSED_ACTIVITY_PROTOCOL_VERSION;
  phase: "model" | "tool" | "awaiting_approval" | "awaiting_human" | "awaiting_external_event" | "completed" | "failed";
  messages: ModelMessage[];
  iteration: number;
  toolCalls: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number };
  pendingToolCallIds: string[];
  completedToolCallIds: string[];
  toolStepIds: Record<string, string>;
  lastModelOperationKey?: string;
  lastModelResponse?: ModelResponse;
  waitingFor?: string;
  completion?: {
    response: ModelResponse;
    agentResponse?: AgentResponse;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number };
    iterations: number;
    toolCalls: number;
    provenance?: Record<string, unknown>;
  };
  lastCheckpoint?: { operationKey: string; phase: DecomposedLoopState["phase"] };
  failure?: { code: string; message: string };
}

export function readDecomposedLoopState(value: unknown): DecomposedLoopState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  if (state.version !== DECOMPOSED_ACTIVITY_PROTOCOL_VERSION
    || !["model", "tool", "awaiting_approval", "awaiting_human", "awaiting_external_event", "completed", "failed"].includes(String(state.phase))
    || !Array.isArray(state.messages)
    || !Array.isArray(state.pendingToolCallIds)
    || !Array.isArray(state.completedToolCallIds)
    || (state.toolStepIds !== undefined && !isRecord(state.toolStepIds))
    || !Number.isSafeInteger(state.iteration)
    || !Number.isSafeInteger(state.toolCalls)) return undefined;
  const messages = state.messages.filter(isModelMessage);
  const pendingToolCallIds = state.pendingToolCallIds.filter(isString);
  const completedToolCallIds = state.completedToolCallIds.filter(isString);
  if (messages.length !== state.messages.length || pendingToolCallIds.length !== state.pendingToolCallIds.length || completedToolCallIds.length !== state.completedToolCallIds.length) return undefined;
  return {
    version: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
    phase: state.phase as DecomposedLoopState["phase"],
    messages,
    iteration: state.iteration as number,
    toolCalls: state.toolCalls as number,
    usage: isRecord(state.usage) && [state.usage.inputTokens, state.usage.outputTokens, state.usage.totalTokens, state.usage.estimatedCostUsd].every((value) => typeof value === "number" && Number.isFinite(value))
      ? {
        inputTokens: state.usage.inputTokens as number,
        outputTokens: state.usage.outputTokens as number,
        totalTokens: state.usage.totalTokens as number,
        estimatedCostUsd: state.usage.estimatedCostUsd as number,
      }
      : { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
    pendingToolCallIds,
    completedToolCallIds,
    toolStepIds: isRecord(state.toolStepIds)
      ? Object.fromEntries(Object.entries(state.toolStepIds).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"))
      : {},
    ...(typeof state.lastModelOperationKey === "string" ? { lastModelOperationKey: state.lastModelOperationKey } : {}),
    ...(isModelResponse(state.lastModelResponse) ? { lastModelResponse: state.lastModelResponse } : {}),
    ...(typeof state.waitingFor === "string" ? { waitingFor: state.waitingFor } : {}),
    ...(isRecord(state.completion) && isModelResponse(state.completion.response)
      ? { completion: state.completion as DecomposedLoopState["completion"] }
      : {}),
    ...(isRecord(state.lastCheckpoint) && typeof state.lastCheckpoint.operationKey === "string"
      ? { lastCheckpoint: state.lastCheckpoint as DecomposedLoopState["lastCheckpoint"] }
      : {}),
    ...(isRecord(state.failure) && typeof state.failure.code === "string" && typeof state.failure.message === "string"
      ? { failure: state.failure as DecomposedLoopState["failure"] }
      : {}),
  };
}

function isModelMessage(value: unknown): value is ModelMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return ["system", "user", "assistant", "tool"].includes(String(message.role)) && typeof message.content === "string";
}

function isModelResponse(value: unknown): value is ModelResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return typeof response.provider === "string"
    && typeof response.model === "string"
    && isRecord(response.message)
    && Array.isArray(response.toolCalls)
    && isRecord(response.usage);
}

function isString(value: unknown): value is string { return typeof value === "string"; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
