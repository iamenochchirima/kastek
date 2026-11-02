import { createHash } from "node:crypto";
import type { HarnessMessage, ToolDefinition } from "../../contracts/model-messages";
export type { HarnessToolCall, HarnessMessage, ToolDefinition } from "../../contracts/model-messages";
export interface ModelRequest {
  messages: HarnessMessage[]; tools?: ToolDefinition[]; maxOutputTokens: number;
  maxDurationSeconds: number; model: string; maxInputTokens?: number;
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
}
export interface ModelResponse {
  message: HarnessMessage; finishReason: "stop" | "tool_calls" | "length" | "refusal";
  usage: { observed?: boolean; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number;
    cacheWriteTokens?: number; reasoningTokens?: number }; providerRequestId?: string;
}
export class ModelOperationError extends Error {
  constructor(public readonly code: string, public readonly outcome: "rejected" | "uncertain", public readonly status = 502) {
    super(code); this.name = "ModelOperationError";
  }
}

/** Stable logical request representation, not a provider HTTP payload. */
export function serializeModelRequest(request: ModelRequest): string {
  return JSON.stringify({ model: request.model, maxOutputTokens: request.maxOutputTokens,
    maxDurationSeconds: request.maxDurationSeconds,
    ...(request.maxInputTokens === undefined ? {} : { maxInputTokens: request.maxInputTokens }),
    messages: request.messages, ...(request.tools?.length ? { tools: request.tools,
      ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }) } : {}) });
}

/** Packing estimate only. Native prepared-payload counting remains the dispatch boundary's responsibility. */
export function estimateRequestTokens(request: ModelRequest): number {
  return Buffer.byteLength(serializeModelRequest(request), "utf8");
}
export function requestDigest(request: ModelRequest): string {
  return createHash("sha256").update(serializeModelRequest(request)).digest("hex");
}

export function validateMessageGroups(messages: HarnessMessage[]): void {
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (!["system", "user", "assistant", "tool"].includes(message.role) ||
        !(typeof message.content === "string" || message.content === null)) {
      throw new ModelOperationError("MODEL_INVALID_MESSAGES", "rejected", 400);
    }
    if (message.role === "tool") {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id)) throw new ModelOperationError("MODEL_ORPHAN_TOOL_RESULT", "rejected", 400);
    } else if (pending.size) throw new ModelOperationError("MODEL_INCOMPLETE_TOOL_GROUP", "rejected", 400);
    if (message.tool_calls?.length) {
      if (message.role !== "assistant") throw new ModelOperationError("MODEL_INVALID_MESSAGES", "rejected", 400);
      for (const call of message.tool_calls) {
        if (!call.id || seen.has(call.id) || call.type !== "function" || !call.function.name || typeof call.function.arguments !== "string") {
          throw new ModelOperationError("MODEL_INVALID_TOOL_CALL", "rejected", 400);
        }
        pending.add(call.id); seen.add(call.id);
      }
    }
  }
  if (pending.size) throw new ModelOperationError("MODEL_INCOMPLETE_TOOL_GROUP", "rejected", 400);
}
