import { compileFunction, constants } from "node:vm";
import type { HarnessMessage, ToolDefinition } from "../../contracts/model-messages";

import type { ModelProtocol } from "../../contracts/model-providers";
import { ModelNetworkError } from "../../infrastructure/model-network";
export type ProviderProtocol = ModelProtocol;
export interface PrivateNativeState {
  provider: string; protocol: ProviderProtocol; model: string; baseUrl: string; credentialRevision: string;
  assistant: unknown;
}
export interface ProviderTransportRequest {
  provider: string; protocol: ProviderProtocol; model: string; baseUrl: string; credentialRevision: string;
  contextWindowTokens: number; maxOutputTokens: number; messages: HarnessMessage[]; tools?: ToolDefinition[];
  /** Native protocol options, supplied only by the trusted policy resolver. */
  reasoning?: Record<string, unknown>;
  nativeHistory?: Record<number, PrivateNativeState>;
  maxRequestBytes?: number; maxResponseBytes?: number;
}
export interface ProviderTransportOptions {
  apiKey: string; signal?: AbortSignal; fetch?: typeof fetch; onText?: (delta: string) => void;
  onProgress?: () => void;
  beforePayloadDispatch?: (payload: Readonly<Record<string, unknown>>) => Promise<void>;
}
export interface ProviderTransportResponse {
  message: HarnessMessage; finishReason: "stop" | "tool_calls" | "length" | "refusal";
  usage: { observed: boolean; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number;
    cacheWriteTokens?: number; reasoningTokens?: number };
  providerRequestId?: string; nativeState: PrivateNativeState;
}
export class ProviderTransportError extends Error {
  constructor(readonly code: string, readonly outcome: "rejected" | "uncertain", readonly status = 502) {
    super(code); this.name = "ProviderTransportError";
  }
}

// Keep native import: TypeScript's CommonJS transform otherwise emits require(),
// which cannot resolve pi-ai's import-only package exports.
const loaders: Record<ProviderProtocol, () => Promise<any>> = {
  openai_chat_completions: compileFunction('return import("@earendil-works/pi-ai/api/openai-completions")', [], { filename: __filename, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }) as () => Promise<any>,
  openai_responses: compileFunction('return import("@earendil-works/pi-ai/api/openai-responses")', [], { filename: __filename, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }) as () => Promise<any>,
  anthropic_messages: compileFunction('return import("@earendil-works/pi-ai/api/anthropic-messages")', [], { filename: __filename, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }) as () => Promise<any>,
  google_generate_content: compileFunction('return import("@earendil-works/pi-ai/api/google-generative-ai")', [], { filename: __filename, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }) as () => Promise<any>,
};
const piApi = { openai_chat_completions: "openai-completions", openai_responses: "openai-responses",
  anthropic_messages: "anthropic-messages", google_generate_content: "google-generative-ai" };
const protocols = new Set<ProviderProtocol>(["openai_chat_completions", "openai_responses", "anthropic_messages", "google_generate_content"]);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const loadCatalog = compileFunction('return import("@earendil-works/pi-ai/providers/all")', [], {
  filename: __filename, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
}) as () => Promise<any>;
export interface BundledProviderModel {
  id: string; name: string; api: string; contextWindow: number; maxTokens: number; input: string[]; reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
/** Pinned bundled metadata only; no discovery, credential lookup or inference. */
export async function getBundledProviderModels(providerId: string): Promise<BundledProviderModel[]> {
  const catalog = (await loadCatalog()).builtinModels();
  if (!catalog.getProviders().some((provider: any) => provider.id === providerId)) return [];
  return catalog.getModels(providerId).map((model: any) => ({ id: model.id, name: model.name, api: model.api,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, input: [...model.input], reasoning: model.reasoning,
    cost: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite } }));
}

function failure(status: number | undefined, dispatched: boolean, cancelled: boolean): ProviderTransportError {
  if (cancelled) return new ProviderTransportError("MODEL_CANCELLED", dispatched ? "uncertain" : "rejected", 409);
  const rejections: Record<number, string> = { 401: "MODEL_AUTHENTICATION_FAILED", 402: "MODEL_BILLING_REQUIRED",
    403: "MODEL_ACCESS_DENIED", 404: "MODEL_UNAVAILABLE", 429: "MODEL_RATE_LIMITED" };
  if (status && rejections[status]) return new ProviderTransportError(rejections[status], "rejected", status);
  return new ProviderTransportError("MODEL_REQUEST_FAILED", dispatched ? "uncertain" : "rejected", status ?? 502);
}

function validate(request: ProviderTransportRequest, options: ProviderTransportOptions): void {
  if (!protocols.has(request.protocol) || !request.provider || !request.model || !request.credentialRevision ||
      !options.apiKey?.trim() || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 ||
      !Number.isSafeInteger(request.contextWindowTokens) || request.contextWindowTokens <= request.maxOutputTokens || !request.messages.length) {
    throw new ProviderTransportError("MODEL_CONFIGURATION_INVALID", "rejected", 400);
  }
  if (request.protocol !== "google_generate_content" && !options.fetch) {
    throw new ProviderTransportError("MODEL_NETWORK_POLICY_REQUIRED", "rejected", 400);
  }
  let url: URL;
  try { url = new URL(request.baseUrl); } catch { throw new ProviderTransportError("MODEL_ENDPOINT_INVALID", "rejected", 400); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ProviderTransportError("MODEL_ENDPOINT_INVALID", "rejected", 400);
  }
  if (request.protocol === "google_generate_content" &&
      (url.origin !== "https://generativelanguage.googleapis.com" || !["/v1beta", "/v1", "/v1beta/", "/v1/"].includes(url.pathname) || options.fetch)) {
    throw new ProviderTransportError("MODEL_GOOGLE_ENDPOINT_UNSUPPORTED", "rejected", 400);
  }
  // This SDK consults these flags even with an explicit key and endpoint. The
  // bundled adapter cannot override its constructor's cloud-backend selection.
  if (request.protocol === "google_generate_content" &&
      [process.env.GOOGLE_GENAI_USE_VERTEXAI, process.env.GOOGLE_GENAI_USE_ENTERPRISE].some(value => value !== undefined)) {
    throw new ProviderTransportError("MODEL_AMBIENT_CONFIGURATION_UNSUPPORTED", "rejected", 400);
  }
  const pending = new Set<string>(), seen = new Set<string>();
  for (const message of request.messages) {
    if (message.role === "tool") {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id)) throw new ProviderTransportError("MODEL_TOOL_HISTORY_INVALID", "rejected", 400);
    } else if (pending.size) throw new ProviderTransportError("MODEL_TOOL_HISTORY_INVALID", "rejected", 400);
    for (const call of message.tool_calls ?? []) {
      if (message.role !== "assistant" || !call.id || seen.has(call.id) || !call.function.name) throw new ProviderTransportError("MODEL_TOOL_HISTORY_INVALID", "rejected", 400);
      seen.add(call.id); pending.add(call.id);
    }
  }
  if (pending.size) throw new ProviderTransportError("MODEL_TOOL_HISTORY_INVALID", "rejected", 400);
}

function history(request: ProviderTransportRequest): any[] {
  const names = new Map(request.messages.flatMap(m => (m.tool_calls ?? []).map(c => [c.id, c.function.name])));
  return request.messages.flatMap((message, index): any[] => {
    if (message.role === "system") return [];
    if (message.role === "user") return [{ role: "user", content: message.content ?? "", timestamp: 0 }];
    if (message.role === "tool") return [{ role: "toolResult", toolCallId: message.tool_call_id,
      toolName: names.get(message.tool_call_id!), content: [{ type: "text", text: message.content ?? "" }], isError: false, timestamp: 0 }];
    const native = request.nativeHistory?.[index];
    if (native) {
      if (native.provider !== request.provider || native.protocol !== request.protocol || native.model !== request.model ||
          native.credentialRevision !== request.credentialRevision || native.baseUrl !== request.baseUrl) throw new ProviderTransportError("MODEL_NATIVE_STATE_MISMATCH", "rejected", 409);
      return [structuredClone(native.assistant)];
    }
    return [{ role: "assistant", api: piApi[request.protocol], provider: request.provider, model: request.model,
      content: [...(message.content ? [{ type: "text", text: message.content }] : []), ...(message.tool_calls ?? []).map(call => {
        const args: unknown = JSON.parse(call.function.arguments);
        if (!object(args)) throw new ProviderTransportError("MODEL_TOOL_HISTORY_INVALID", "rejected", 400);
        return { type: "toolCall", id: call.id, name: call.function.name, arguments: args };
      })], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: message.tool_calls?.length ? "toolUse" : "stop", timestamp: 0 }];
  });
}

export async function callProviderModel(request: ProviderTransportRequest, options: ProviderTransportOptions): Promise<ProviderTransportResponse> {
  validate(request, options);
  if (options.signal?.aborted) throw new ProviderTransportError("MODEL_CANCELLED_BEFORE_DISPATCH", "rejected", 409);
  let dispatched = false, httpStatus: number | undefined, physicalFailure: ModelNetworkError | undefined,
    observed = false, inputObserved = false, outputObserved = false, refused = false, bytes = 0;
  const raw = new Map<string, string>();
  const control = new AbortController();
  const cancel = () => control.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const adapter = await loaders[request.protocol]();
    const model = { id: request.model, name: request.model, provider: request.provider, api: piApi[request.protocol],
      baseUrl: request.protocol === "anthropic_messages" ? request.baseUrl.replace(/\/v1\/?$/, "") : request.baseUrl,
      contextWindow: request.contextWindowTokens, maxTokens: request.maxOutputTokens,
      reasoning: !!request.reasoning, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, maxTokensField: "max_tokens" } };
    const context = { messages: [{ role: "system", timestamp: 0,
      content: request.messages.filter(m => m.role === "system").map(m => m.content ?? "").join("\n\n"),
      toolsAdded: request.tools?.map(t => ({ name: t.function.name,
        description: t.function.description, parameters: t.function.parameters })) ?? [] }, ...history(request)] };
    const stream = adapter.stream(model, context, {
      ...request.reasoning, apiKey: options.apiKey, signal: control.signal, maxRetries: 0, maxTokens: request.maxOutputTokens,
      transport: "sse", cacheRetention: "none", ...(request.protocol !== "google_generate_content" ? { fetch: (async (url, init) => {
        try {
          const response = await options.fetch!(url, init);
          httpStatus = response.status; return response;
        } catch (error) {
          if (error instanceof ModelNetworkError) { physicalFailure = error; dispatched = error.dispatched; }
          throw error;
        }
      }) as typeof fetch } : {}),
      onResponse: (response: { status: number }) => { httpStatus = response.status; },
      onPayload: async (value: unknown) => {
        if (!object(value)) throw new ProviderTransportError("MODEL_PAYLOAD_INVALID", "rejected", 400);
        // Override SDK minimums/defaults with the exact approved physical-call cap.
        if (request.protocol === "openai_responses") value.max_output_tokens = request.maxOutputTokens;
        else if (request.protocol === "google_generate_content") {
          value.config = { ...value.config, maxOutputTokens: request.maxOutputTokens };
        } else {
          delete value.max_completion_tokens; value.max_tokens = request.maxOutputTokens;
        }
        if (request.provider === "openrouter") value.provider = { allow_fallbacks: false, require_parameters: true };
        if (request.maxRequestBytes !== undefined && Buffer.byteLength(JSON.stringify(value)) > request.maxRequestBytes) {
          throw new ProviderTransportError("MODEL_REQUEST_BYTES_EXCEEDED", "rejected", 400);
        }
        await options.beforePayloadDispatch?.(structuredClone(value));
        control.signal.throwIfAborted(); dispatched = true;
        return value;
      },
      onProviderStreamEvent: (event: any) => {
        bytes += Buffer.byteLength(JSON.stringify(event));
        if (request.maxResponseBytes !== undefined && bytes > request.maxResponseBytes) {
          control.abort(); throw new ProviderTransportError("MODEL_RESPONSE_BYTES_EXCEEDED", "uncertain");
        }
        if (event.usage && count(event.usage.prompt_tokens) && count(event.usage.completion_tokens)) observed = true;
        if (event.type === "message_start" && count(event.message?.usage?.input_tokens)) inputObserved = true;
        if (event.type === "message_delta" && count(event.usage?.output_tokens)) outputObserved = true;
        if (inputObserved && outputObserved) observed = true;
        if (event.type === "response.completed" && count(event.response?.usage?.input_tokens) && count(event.response?.usage?.output_tokens)) observed = true;
        if (count(event.usageMetadata?.promptTokenCount) && count(event.usageMetadata?.candidatesTokenCount)) observed = true;
        if (event.type === "response.refusal.delta" || event.delta?.stop_reason === "refusal" || event.choices?.some((c: any) => c.delta?.refusal)) refused = true;
        for (const choice of event.choices ?? []) for (const call of choice.delta?.tool_calls ?? []) {
          if (call.function?.arguments !== undefined) raw.set(`chat:${call.index}`, (raw.get(`chat:${call.index}`) ?? "") + call.function.arguments);
        }
        if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") raw.set(`anthropic:${event.index}`, (raw.get(`anthropic:${event.index}`) ?? "") + event.delta.partial_json);
        if (event.type === "response.function_call_arguments.delta") raw.set(`responses:${event.item_id}`, (raw.get(`responses:${event.item_id}`) ?? "") + event.delta);
        if (event.type === "response.function_call_arguments.done") raw.set(`responses:${event.item_id}`, event.arguments);
      },
    });
    let result: any;
    for await (const event of stream) {
      if (["text_delta", "thinking_delta", "toolcall_delta"].includes(event.type) && typeof event.delta === "string" && event.delta.length) options.onProgress?.();
      if (event.type === "text_delta") {
        options.onText?.(event.delta);
      }
      if (event.type === "done") result = event.message;
      if (event.type === "error") {
        if (physicalFailure) throw new ProviderTransportError(`MODEL_NETWORK_${physicalFailure.code}`, physicalFailure.dispatched ? "uncertain" : "rejected");
        throw failure(httpStatus, dispatched, control.signal.aborted);
      }
    }
    if (!result || !["stop", "toolUse", "length"].includes(result.stopReason)) throw new ProviderTransportError("MODEL_INCOMPLETE_RESPONSE", "uncertain");
    for (const value of raw.values()) if (!object(JSON.parse(value))) throw new ProviderTransportError("MODEL_TOOL_ARGUMENTS_INVALID", "uncertain");
    const calls = result.content.filter((part: any) => part.type === "toolCall");
    if ((calls.length && result.stopReason !== "toolUse") || new Set(calls.map((c: any) => c.id)).size !== calls.length ||
        calls.some((c: any) => !object(c.arguments) || !c.id || !c.name)) throw new ProviderTransportError("MODEL_TOOL_ARGUMENTS_INVALID", "uncertain");
    const text = result.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
    if (!refused && !calls.length && !text.trim()) throw new ProviderTransportError("MODEL_EMPTY_RESPONSE", "uncertain");
    if (observed && (![result.usage.input, result.usage.output, result.usage.cacheRead, result.usage.cacheWrite].every(count) ||
        !count(result.usage.input + result.usage.cacheRead + result.usage.cacheWrite) ||
        !count(result.usage.input + result.usage.cacheRead + result.usage.cacheWrite + result.usage.output) ||
        (result.usage.reasoning !== undefined && (!count(result.usage.reasoning) || result.usage.reasoning > result.usage.output)) ||
        result.usage.output > request.maxOutputTokens)) throw new ProviderTransportError("MODEL_USAGE_INVALID", "uncertain");
    return { message: { role: "assistant", content: text || null,
      ...(calls.length ? { tool_calls: calls.map((c: any) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) },
      finishReason: refused ? "refusal" : result.stopReason === "toolUse" ? "tool_calls" : result.stopReason === "length" ? "length" : "stop",
      usage: observed ? { observed: true, inputTokens: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
        outputTokens: result.usage.output, cachedInputTokens: result.usage.cacheRead, cacheWriteTokens: result.usage.cacheWrite,
        reasoningTokens: result.usage.reasoning } : { observed: false },
      providerRequestId: result.responseId,
      nativeState: { provider: request.provider, protocol: request.protocol, model: request.model,
        baseUrl: request.baseUrl, credentialRevision: request.credentialRevision, assistant: structuredClone(result) } };
  } catch (error) {
    control.abort();
    if (error instanceof ProviderTransportError) throw error;
    throw new ProviderTransportError(options.signal?.aborted ? "MODEL_CANCELLED" : "MODEL_TRANSPORT_FAILED", dispatched ? "uncertain" : "rejected", httpStatus ?? 502);
  } finally { options.signal?.removeEventListener("abort", cancel); }
}
