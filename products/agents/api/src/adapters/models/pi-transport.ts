import { observeModelIdentity } from "./model-identity";
import { compileFunction, constants } from "node:vm";
import type { HarnessMessage, ToolDefinition } from "../../contracts/model-messages";

import type { ModelProtocol } from "../../contracts/model-providers";
import { ModelNetworkError } from "../../infrastructure/model-network";
import { ProviderTransportError, type ProviderProtocol, type PrivateNativeState, type ProviderTransportRequest,
  type ProviderTransportOptions, type ProviderTransportResponse,type ModelFailureDiagnostics } from "../../contracts/model-transport";
export { ProviderTransportError } from "../../contracts/model-transport";
export type { ProviderProtocol, PrivateNativeState, ProviderTransportRequest, ProviderTransportOptions, ProviderTransportResponse } from "../../contracts/model-transport";
import { compatibleProfile, compatibleSdkSettings, prepareCompatiblePayload } from "./compatible-profiles";
import { callGoogleProviderModel } from "./google-transport";
import { observeSseFailures } from "./sse-failure-diagnostics";

// Keep native import: TypeScript's CommonJS transform otherwise emits require(),
// which cannot resolve pi-ai's import-only package exports.
const loaders: Record<Exclude<ProviderProtocol, "google_generate_content">, () => Promise<any>> = {
  openai_chat_completions: compileFunction('return import("@earendil-works/pi-ai/api/openai-completions")', [], { filename: __filename, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }) as () => Promise<any>,
  openai_responses: compileFunction('return import("@earendil-works/pi-ai/api/openai-responses")', [], { filename: __filename, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }) as () => Promise<any>,
  anthropic_messages: compileFunction('return import("@earendil-works/pi-ai/api/anthropic-messages")', [], { filename: __filename, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }) as () => Promise<any>,
};
const loadMistral = compileFunction('return import("@earendil-works/pi-ai/api/mistral-conversations")', [], {
  filename: __filename, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
}) as () => Promise<any>;
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

function failure(status: number | undefined, dispatched: boolean, cancelled: boolean,
  streamDiagnostic?: Pick<ModelFailureDiagnostics, "streamErrorKind" | "providerErrorCode">, responseCompleted = false,
  diagnosticStage: ModelFailureDiagnostics["stage"] = "provider_stream"): ProviderTransportError {
  if (cancelled) return new ProviderTransportError("MODEL_CANCELLED", dispatched ? "uncertain" : "rejected", 409);
  // An upstream SSE error explicitly reporting 503 rejects the generation, even when the
  // provider uses HTTP 200 for the event stream, provided no complete response was accepted.
  // Other post-200 failures remain uncertain.
  if (!responseCompleted && streamDiagnostic?.streamErrorKind === "upstream_sse_error" && streamDiagnostic.providerErrorCode === 503) {
    return new ProviderTransportError("MODEL_PROVIDER_UNAVAILABLE", "rejected", 503, {
      ...(status === undefined ? {} : { httpStatus: status }), stage: "provider_stream", dispatched,
      ...streamDiagnostic,
    });
  }
  // SDK error events can follow an accepted HTTP response, including partial output.
  // Their private errorMessage is not a safe diagnostic, and HTTP 200 is not an error status.
  if (status !== undefined && status >= 200 && status < 300) {
    return new ProviderTransportError("MODEL_STREAM_FAILED", dispatched ? "uncertain" : "rejected", 502);
  }
  // An explicit HTTP503 remains a provider rejection even if its error body is interrupted.
  // Other HTTP200 stream failures remain uncertain because generation may have started.
  if (status === 503) return new ProviderTransportError("MODEL_PROVIDER_UNAVAILABLE", "rejected", 503, {
    httpStatus: 503, stage: diagnosticStage, dispatched,
    ...(streamDiagnostic?.streamErrorKind && streamDiagnostic.streamErrorKind !== "unclassified" ? streamDiagnostic : {}),
  });
  const rejections: Record<number, string> = { 400: "MODEL_REQUEST_INVALID", 422: "MODEL_REQUEST_INVALID", 401: "MODEL_AUTHENTICATION_FAILED", 402: "MODEL_BILLING_REQUIRED",
    403: "MODEL_ACCESS_DENIED", 404: "MODEL_UNAVAILABLE", 429: "MODEL_RATE_LIMITED" };
  if (status && rejections[status]) return new ProviderTransportError(rejections[status], "rejected", status);
  return new ProviderTransportError(status === undefined && dispatched ? "MODEL_OUTCOME_UNCERTAIN" : "MODEL_REQUEST_FAILED", dispatched ? "uncertain" : "rejected", status ?? 502);
}

// SDK error events omit the original body-reader error. Retain its type before SDK parsing.
function observeResponseBody(response: Response, onFailure: (error: unknown) => void, observer?:ReturnType<typeof observeSseFailures>): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let released = false, cancelled = false;
  const release = () => { if (!released) { released = true; reader.releaseLock(); } };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (cancelled) return;
        if (chunk.done) { observer?.finish(); release(); controller.close(); }
        else { observer?.write(chunk.value); controller.enqueue(chunk.value); }
      } catch (error) {
        if(!cancelled)onFailure(error); release();
        if (!cancelled) controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      try { await reader.cancel(reason); }
      catch { /* Reader cleanup cannot replace the failure which stopped SDK consumption. */ }
      finally { release(); }
    },
  });
  const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  Object.defineProperty(observed, "url", { value: response.url });
  return observed;
}

function validate(request: ProviderTransportRequest, options: ProviderTransportOptions): void {
  if (!protocols.has(request.protocol) || !request.provider || !request.model || !request.credentialRevision ||
      !options.apiKey?.trim() || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 ||
      !Number.isSafeInteger(request.contextWindowTokens) || request.contextWindowTokens <= request.maxOutputTokens || !request.messages.length) {
    throw new ProviderTransportError("MODEL_CONFIGURATION_INVALID", "rejected", 400);
  }
  if (!options.fetch) {
    throw new ProviderTransportError("MODEL_NETWORK_POLICY_REQUIRED", "rejected", 400);
  }
  let url: URL;
  try { url = new URL(request.baseUrl); } catch { throw new ProviderTransportError("MODEL_ENDPOINT_INVALID", "rejected", 400); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ProviderTransportError("MODEL_ENDPOINT_INVALID", "rejected", 400);
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
  compatibleProfile(request);
  if (request.protocol === "google_generate_content") return callGoogleProviderModel(request, options);
  if (options.signal?.aborted) throw new ProviderTransportError("MODEL_CANCELLED_BEFORE_DISPATCH", "rejected", 409);
  const nativeMistral = request.provider === "mistral";
  const streamObserver=!nativeMistral&&["openai_chat_completions","openai_responses"].includes(request.protocol)?observeSseFailures(request.protocol==="openai_responses"):undefined;
  let rawReasoning: unknown;
  let preparationFailure: ProviderTransportError | undefined, identityFailure: ProviderTransportError | undefined,streamFailure:ProviderTransportError|undefined;
  const identity = observeModelIdentity(request.model);
  let dispatched = false, httpStatus: number | undefined, physicalFailure: ModelNetworkError | undefined,
    observed = false, inputObserved = false, outputObserved = false, refused = false, bytes = 0;
  let responseCompleted = false;
  let stage:ModelFailureDiagnostics["stage"]="request";
  const raw = new Map<string, string>();
  const control = new AbortController();
  const cancel = () => control.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const adapter = await (nativeMistral ? loadMistral() : loaders[request.protocol]());
    const model = { id: request.model, name: request.model, provider: request.provider, api: nativeMistral ? "mistral-conversations" : piApi[request.protocol],
      baseUrl: request.protocol === "anthropic_messages" || nativeMistral ? request.baseUrl.replace(/\/v1\/?$/, "") : request.baseUrl,
      contextWindow: request.contextWindowTokens, maxTokens: request.maxOutputTokens,
      reasoning: request.reasoningCapable ?? !!request.reasoning, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, maxTokensField: "max_tokens", ...compatibleSdkSettings(request) } };
    const context = { messages: [{ role: "system", timestamp: 0,
      content: request.messages.filter(m => m.role === "system").map(m => m.content ?? "").join("\n\n"),
      toolsAdded: request.tools?.map(t => ({ name: t.function.name,
        description: t.function.description, parameters: t.function.parameters })) ?? [] }, ...history(request)] };
    const stream = adapter.stream(model, context, {
      ...request.reasoning, apiKey: options.apiKey, signal: control.signal, maxRetries: 0, maxTokens: request.maxOutputTokens,
      transport: "sse", cacheRetention: "none",
      // Native Mistral otherwise inserts a 60-second timer. The bounded caller owns the actual deadline.
      ...(nativeMistral ? { timeoutMs: 2147483647 } : {}), ...({ fetch: (async (url, init) => {
        try {
          if (nativeMistral) {
            const payload: unknown = JSON.parse(String(init?.body));
            if (!object(payload)) throw new ProviderTransportError("MODEL_PAYLOAD_INVALID", "rejected", 400);
            payload.max_tokens = request.maxOutputTokens;
            if (Array.isArray(payload.tools)) for (const tool of payload.tools) if (object(tool.function)) delete tool.function.strict;
            prepareCompatiblePayload(request, payload);
            options.preparePayload?.(payload);
            const body = JSON.stringify(payload);
            if (request.maxRequestBytes !== undefined && Buffer.byteLength(body) > request.maxRequestBytes) throw new ProviderTransportError("MODEL_REQUEST_BYTES_EXCEEDED", "rejected", 400);
            await options.beforePayloadDispatch?.(structuredClone(payload));
            control.signal.throwIfAborted(); dispatched = true;
            init = { ...init, body };
          }
          const response = await options.fetch!(url, init);
          httpStatus = response.status;stage="provider_stream";
          return observeResponseBody(response, error => {
            if (error instanceof ModelNetworkError&&!physicalFailure) { physicalFailure = error; dispatched = error.dispatched;stage="response_body"; }
          },streamObserver);
        } catch (error) {
          if (error instanceof ModelNetworkError&&!physicalFailure) { physicalFailure = error; dispatched = error.dispatched; }
          if (error instanceof ProviderTransportError) preparationFailure = error;
          throw error;
        }
      }) as typeof fetch }),
      onResponse: (response: { status: number }) => { httpStatus = response.status; },
      onPayload: async (value: unknown) => {
        if (!object(value)) throw new ProviderTransportError("MODEL_PAYLOAD_INVALID", "rejected", 400);
        if (nativeMistral) { value.maxTokens = request.maxOutputTokens; return value; }
        // Override SDK minimums/defaults with the exact approved physical-call cap.
        if (request.protocol === "openai_responses") value.max_output_tokens = request.maxOutputTokens;
        else {
          delete value.max_completion_tokens; value.max_tokens = request.maxOutputTokens;
        }
        if (request.provider === "openrouter") value.provider = { allow_fallbacks: false, require_parameters: true };
        prepareCompatiblePayload(request, value);
        options.preparePayload?.(value);
        if (request.maxRequestBytes !== undefined && Buffer.byteLength(JSON.stringify(value)) > request.maxRequestBytes) {
          throw new ProviderTransportError("MODEL_REQUEST_BYTES_EXCEEDED", "rejected", 400);
        }
        await options.beforePayloadDispatch?.(structuredClone(value));
        control.signal.throwIfAborted(); dispatched = true;
        return value;
      },
      onProviderStreamEvent: (event: any) => {
        try {
          if (request.protocol === "openai_chat_completions") identity.observe(event.model);
          else if (request.protocol === "openai_responses" && event.response) identity.observe(event.response.model);
          else if (request.protocol === "anthropic_messages" && event.type === "message_start") identity.observe(event.message?.model);
        } catch (error) {
          if (error instanceof ProviderTransportError) identityFailure = error;
          throw error;
        }
        bytes += Buffer.byteLength(JSON.stringify(event));
        if (request.maxResponseBytes !== undefined && bytes > request.maxResponseBytes) {
          streamFailure=new ProviderTransportError("MODEL_RESPONSE_BYTES_EXCEEDED", "uncertain");control.abort();throw streamFailure;
        }
        if (event.usage && count(event.usage.prompt_tokens) && count(event.usage.completion_tokens)) observed = true;
        if (event.usage?.completion_tokens_details?.reasoning_tokens !== undefined) rawReasoning = event.usage.completion_tokens_details.reasoning_tokens;
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
      if (event.type === "done") { result = event.message; responseCompleted = result !== undefined; }
      if (event.type === "error") {
        if (identityFailure) throw identityFailure;
        if (preparationFailure) throw preparationFailure;
        if(streamFailure)throw streamFailure;
        const diagnostic=streamObserver?.diagnostic();
        const explicitUnavailable=httpStatus===503||!responseCompleted&&diagnostic?.streamErrorKind==="upstream_sse_error"&&diagnostic.providerErrorCode===503;
        if (physicalFailure&&!explicitUnavailable) throw new ProviderTransportError(`MODEL_NETWORK_${physicalFailure.code}`, physicalFailure.dispatched ? "uncertain" : "rejected");
        throw failure(httpStatus, dispatched,options.signal?.aborted===true,diagnostic,responseCompleted,
          physicalFailure&&httpStatus===503?"response_body":"provider_stream");
      }
    }
    stage="response_validation";
    if (identityFailure) throw identityFailure;
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
        (rawReasoning !== undefined && (!count(rawReasoning) || Number(rawReasoning) > result.usage.output)) ||
        result.usage.output > request.maxOutputTokens)) throw new ProviderTransportError("MODEL_USAGE_INVALID", "uncertain");
    return { message: { role: "assistant", content: text || null,
      ...(calls.length ? { tool_calls: calls.map((c: any) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) },
      finishReason: refused ? "refusal" : result.stopReason === "toolUse" ? "tool_calls" : result.stopReason === "length" ? "length" : "stop",
      usage: observed ? { observed: true, inputTokens: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
        outputTokens: result.usage.output, cachedInputTokens: result.usage.cacheRead, cacheWriteTokens: result.usage.cacheWrite,
        reasoningTokens: rawReasoning !== undefined ? Number(rawReasoning) : result.usage.reasoning } : { observed: false },
      modelIdentity: identity.receipt(), providerRequestId: result.responseId,
      nativeState: { provider: request.provider, protocol: request.protocol, model: request.model,
        baseUrl: request.baseUrl, credentialRevision: request.credentialRevision, assistant: structuredClone(result) } };
  } catch (error) {
    const streamDiagnostic=streamObserver?.diagnostic();
    const explicitStreamUnavailable=!options.signal?.aborted&&!responseCompleted&&streamDiagnostic?.streamErrorKind==="upstream_sse_error"&&streamDiagnostic.providerErrorCode===503;
    const interruptedUnavailable=physicalFailure&&(httpStatus===503||explicitStreamUnavailable);
    const initiating=interruptedUnavailable?failure(httpStatus,dispatched,options.signal?.aborted===true,streamDiagnostic,responseCompleted,
      httpStatus===503?"response_body":"provider_stream"):
      error instanceof ProviderTransportError?error:physicalFailure?
        new ProviderTransportError(`MODEL_NETWORK_${physicalFailure.code}`,physicalFailure.dispatched?"uncertain":"rejected"):
        failure(httpStatus,dispatched,options.signal?.aborted===true,streamDiagnostic,responseCompleted);
    const diagnostics:ModelFailureDiagnostics=initiating.diagnostics??{...(httpStatus===undefined?{}:{httpStatus}),stage,dispatched,
      ...(initiating.code==="MODEL_STREAM_FAILED"&&streamObserver?streamObserver.diagnostic():{})};
    control.abort();
    throw new ProviderTransportError(initiating.code,initiating.outcome,initiating.status,diagnostics);
  } finally { options.signal?.removeEventListener("abort", cancel); }
}
