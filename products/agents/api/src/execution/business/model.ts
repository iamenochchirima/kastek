import { createHash } from "node:crypto";
import type { HarnessToolCall, HarnessMessage, ToolDefinition } from "../../contracts/model-messages";
export type { HarnessToolCall, HarnessMessage, ToolDefinition } from "../../contracts/model-messages";
export const APPROVED_MODEL_PROFILE = Object.freeze({
  id: "nemotron-v2", model: "nvidia/nemotron-3-super-120b-a12b",
  contextWindow: 262_144, maxInputTokens: 8192, maxOutputTokens: 1024,
  safetyTokens: 512, maxMessages: 64, maxTools: 16,
  accounting: "serialized-utf8-upper-bound-v1",
  tokenizerRevision: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16@2dc98e2afe4face0e4ce40972a915c45368bd34a",
});
export function isApprovedModel(model: string): boolean {
  return model === APPROVED_MODEL_PROFILE.model || model === `${APPROVED_MODEL_PROFILE.model}:free`;
}

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
export interface ModelAdapterOptions { openRouterApiKey: string | undefined; fetch?: typeof fetch; signal?: AbortSignal }
export class ModelOperationError extends Error {
  constructor(public readonly code: string, public readonly outcome: "rejected" | "uncertain", public readonly status = 502) {
    super(code); this.name = "ModelOperationError";
  }
}

export function serializeModelRequest(request: ModelRequest): string {
  return JSON.stringify({ model: request.model, max_tokens: request.maxOutputTokens,
    provider: { allow_fallbacks: false }, reasoning: { effort: "none", exclude: true },
    messages: request.messages, ...(request.tools?.length ? { tools: request.tools,
      tool_choice: request.toolChoice ?? "auto" } : {}) });
}

// The pinned NVIDIA tokenizer is byte-level BPE without normalization. Counting all
// serialized UTF-8 bytes overestimates content tokens; reserve framing separately.
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

export function validateModelRequest(request: ModelRequest): void {
  const profile = APPROVED_MODEL_PROFILE;
  if (!isApprovedModel(request.model)) throw new ModelOperationError("MODEL_PROFILE_UNSUPPORTED", "rejected", 400);
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > profile.maxOutputTokens ||
      !Number.isSafeInteger(request.maxDurationSeconds) || request.maxDurationSeconds < 1 || request.maxDurationSeconds > 120 ||
      !request.messages.length || request.messages.length > profile.maxMessages || (request.tools?.length ?? 0) > profile.maxTools) {
    throw new ModelOperationError("MODEL_REQUEST_LIMIT", "rejected", 400);
  }
  const maxInput = request.maxInputTokens ?? profile.maxInputTokens;
  if (!Number.isSafeInteger(maxInput) || maxInput < 1 || maxInput > profile.maxInputTokens) throw new ModelOperationError("MODEL_REQUEST_LIMIT", "rejected", 400);
  validateMessageGroups(request.messages);
  const names = new Set<string>();
  for (const tool of request.tools ?? []) {
    if (tool.type !== "function" || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.function.name) || names.has(tool.function.name) ||
        typeof tool.function.description !== "string" || !tool.function.parameters || typeof tool.function.parameters !== "object") {
      throw new ModelOperationError("MODEL_INVALID_TOOLS", "rejected", 400);
    }
    names.add(tool.function.name);
  }
  if (request.toolChoice && typeof request.toolChoice === "object" && !names.has(request.toolChoice.function.name)) {
    throw new ModelOperationError("MODEL_INVALID_TOOLS", "rejected", 400);
  }
  const estimate = estimateRequestTokens(request);
  if (estimate > maxInput || estimate + request.maxOutputTokens + profile.safetyTokens > profile.contextWindow) {
    throw new ModelOperationError("CONTEXT_LIMIT", "rejected", 400);
  }
}

function invalidResponse(): never { throw new ModelOperationError("MODEL_INVALID_RESPONSE", "uncertain"); }
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidResponse();
  return value as Record<string, unknown>;
}
function parseResponse(body: unknown, request: ModelRequest): ModelResponse {
  const root = asRecord(body);
  if (root.model !== undefined && root.model !== request.model && root.model !== request.model.replace(/:free$/, "") &&
      root.model !== "nvidia/nemotron-3-super-120b-a12b-20230311") invalidResponse();
  if (!Array.isArray(root.choices) || root.choices.length !== 1) invalidResponse();
  const choice = asRecord(root.choices[0]);
  const message = asRecord(choice.message);
  const usage = asRecord(root.usage);
  const inputTokens = usage.prompt_tokens, outputTokens = usage.completion_tokens;
  if (!Number.isSafeInteger(inputTokens) || Number(inputTokens) < 0 || !Number.isSafeInteger(outputTokens) ||
      Number(outputTokens) < 0 || Number(outputTokens) > request.maxOutputTokens || message.role !== "assistant" ||
      !(message.content === null || typeof message.content === "string")) invalidResponse();
  if (message.reasoning !== undefined && message.reasoning !== null && message.reasoning !== "") invalidResponse();
  if (usage.completion_tokens_details) {
    const details = asRecord(usage.completion_tokens_details);
    if (details.reasoning_tokens !== undefined && (!Number.isSafeInteger(details.reasoning_tokens) || Number(details.reasoning_tokens) !== 0)) invalidResponse();
  }
  const resultMessage: HarnessMessage = { role: "assistant", content: message.content as string | null };
  const calls: HarnessToolCall[] = [];
  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 16) invalidResponse();
    const ids = new Set<string>();
    for (const item of message.tool_calls as unknown[]) {
      const call = asRecord(item), fn = asRecord(call.function);
      if (call.type !== "function" || typeof call.id !== "string" || !call.id || call.id.length > 200 || ids.has(call.id) ||
          typeof fn.name !== "string" || !fn.name || typeof fn.arguments !== "string" || Buffer.byteLength(fn.arguments) > 16_384) invalidResponse();
      ids.add(call.id as string);
      // Preserve malformed JSON for the trusted tool validator's bounded correction path.
      calls.push({ id: call.id as string, type: "function", function: { name: fn.name as string, arguments: fn.arguments as string } });
    }
  }
  if (calls.length) resultMessage.tool_calls = calls;
  let finishReason = choice.finish_reason;
  if (message.refusal || finishReason === "content_filter") finishReason = "refusal";
  if (!["stop", "tool_calls", "length", "refusal"].includes(String(finishReason))) invalidResponse();
  if (finishReason === "tool_calls" && !calls.length || finishReason === "stop" && calls.length ||
      finishReason === "stop" && !(resultMessage.content?.trim())) invalidResponse();
  if (request.toolChoice === "none" && calls.length) invalidResponse();
  if (typeof message.content === "string" && Buffer.byteLength(message.content) > 32_768) invalidResponse();
  if (Number(inputTokens) > estimateRequestTokens(request) + APPROVED_MODEL_PROFILE.safetyTokens) {
    throw new ModelOperationError("MODEL_ACCOUNTING_PROFILE_MISMATCH", "uncertain");
  }
  return { message: resultMessage, finishReason: finishReason as ModelResponse["finishReason"],
    usage: { inputTokens: Number(inputTokens), outputTokens: Number(outputTokens) },
    ...(typeof root.id === "string" && root.id.length <= 200 ? { providerRequestId: root.id } : {}) };
}

export async function callModel(request: ModelRequest, options: ModelAdapterOptions): Promise<ModelResponse> {
  validateModelRequest(request);
  if (!options.openRouterApiKey) throw new ModelOperationError("MODEL_CREDENTIAL_UNAVAILABLE", "rejected", 503);
  if (options.signal?.aborted) throw new ModelOperationError("MODEL_CANCELLED_BEFORE_DISPATCH", "rejected", 409);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.maxDurationSeconds * 1000);
  try {
    const response = await (options.fetch ?? fetch)("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
      headers: { authorization: `Bearer ${options.openRouterApiKey}`, "content-type": "application/json" },
      body: serializeModelRequest(request),
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      if ([400, 401, 402, 403, 404, 422, 429].includes(response.status)) {
        const code = ({ 401: "MODEL_AUTHENTICATION_FAILED", 402: "MODEL_BILLING_REQUIRED",
          403: "MODEL_ACCESS_DENIED", 404: "MODEL_UNAVAILABLE", 429: "MODEL_RATE_LIMITED" } as Record<number, string>)[response.status]
          ?? "MODEL_REQUEST_REJECTED";
        throw new ModelOperationError(code, "rejected");
      }
      throw new ModelOperationError("MODEL_OUTCOME_UNCERTAIN", "uncertain");
    }
    if (!response.body) invalidResponse();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 128_000) { await reader.cancel(); invalidResponse(); }
      chunks.push(next.value);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return invalidResponse(); }
    return parseResponse(body, request);
  } catch (error) {
    if (error instanceof ModelOperationError) throw error;
    throw new ModelOperationError("MODEL_OUTCOME_UNCERTAIN", "uncertain");
  } finally { clearTimeout(timeout); }
}
