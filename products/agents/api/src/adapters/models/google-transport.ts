import { randomUUID } from "node:crypto";
import { observeModelIdentity } from "./model-identity";
import { ProviderTransportError, type ProviderTransportOptions, type ProviderTransportRequest, type ProviderTransportResponse } from "../../contracts/model-transport";
import { ModelNetworkError } from "../../infrastructure/model-network";
import type { HarnessToolCall } from "../../contracts/model-messages";

type JsonObject = Record<string, unknown>;
interface GoogleContent { role: "user" | "model"; parts: JsonObject[] }
const object = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const rejected = (code: string, status = 400) => new ProviderTransportError(code, "rejected", status);
const invalid = (code: string) => new ProviderTransportError(code, "uncertain");

/** The model is one encoded path segment. No key or other caller query reaches the URL. */
export function googleModelRequestUrl(baseUrl: string, model: string): URL {
  try {
    const base = new URL(baseUrl), id = model.replace(/^models\//, "");
    if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
        !id || id.length > 512 || /[\u0000-\u0020\u007f\\]/.test(id) || id.split("/").some(part => !part || part === "." || part === "..")) {
      throw rejected("MODEL_ENDPOINT_INVALID");
    }
    base.pathname = `${base.pathname.replace(/\/+$/, "")}/models/${encodeURIComponent(id)}:streamGenerateContent`;
    base.search = "?alt=sse";
    return base;
  } catch { throw rejected("MODEL_ENDPOINT_INVALID"); }
}

function googleHistory(request: ProviderTransportRequest): GoogleContent[] {
  const contents: GoogleContent[] = [], pending = new Map<string, { name: string; nativeId?: string }>(), seen = new Set<string>();
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const call = message.tool_call_id && pending.get(message.tool_call_id);
      if (!call || message.tool_calls?.length) throw rejected("MODEL_TOOL_HISTORY_INVALID");
      pending.delete(message.tool_call_id!);
      const part = { functionResponse: { name: call.name, ...(call.nativeId ? { id: call.nativeId } : {}), response: { output: message.content ?? "" } } };
      if (contents.at(-1)?.role === "user" && contents.at(-1)!.parts.every(p => "functionResponse" in p)) contents.at(-1)!.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
      continue;
    }
    if (pending.size) throw rejected("MODEL_TOOL_HISTORY_INVALID");
    if (message.role === "user") {
      if (message.tool_calls?.length) throw rejected("MODEL_TOOL_HISTORY_INVALID");
      contents.push({ role: "user", parts: [{ text: message.content ?? "" }] });
      continue;
    }
    const native = request.nativeHistory?.[index];
    let content: GoogleContent;
    if (native) {
      if (native.provider !== request.provider || native.protocol !== request.protocol || native.model !== request.model ||
          native.baseUrl !== request.baseUrl || native.credentialRevision !== request.credentialRevision) throw rejected("MODEL_NATIVE_STATE_MISMATCH", 409);
      if (!object(native.assistant) || native.assistant.role !== "model" || !Array.isArray(native.assistant.parts) || !native.assistant.parts.every(object)) {
        throw rejected("MODEL_NATIVE_STATE_INVALID");
      }
      content = structuredClone(native.assistant) as unknown as GoogleContent;
    } else {
      if (message.tool_calls?.length) throw rejected("MODEL_NATIVE_STATE_REQUIRED");
      content = { role: "model", parts: [{ text: message.content ?? "" }] };
    }
    const nativeCalls = content.parts.filter(p => p.functionCall !== undefined).map(p => p.functionCall);
    if (nativeCalls.length !== (message.tool_calls?.length ?? 0)) throw rejected("MODEL_NATIVE_STATE_MISMATCH", 409);
    for (const [callIndex, call] of (message.tool_calls ?? []).entries()) {
      const original = nativeCalls[callIndex];
      let args: unknown;
      try { args = JSON.parse(call.function.arguments); } catch { throw rejected("MODEL_TOOL_HISTORY_INVALID"); }
      if (!call.id || seen.has(call.id) || !object(original) || original.name !== call.function.name || !object(args) ||
          JSON.stringify(original.args ?? {}) !== JSON.stringify(args) || original.id !== undefined && original.id !== call.id) {
        throw rejected("MODEL_TOOL_HISTORY_INVALID");
      }
      seen.add(call.id);
      pending.set(call.id, { name: call.function.name, ...(typeof original.id === "string" ? { nativeId: original.id } : {}) });
    }
    contents.push(content);
  }
  if (pending.size) throw rejected("MODEL_TOOL_HISTORY_INVALID");
  return contents;
}

function googleUsage(metadata: unknown, maxOutputTokens: number): ProviderTransportResponse["usage"] {
  if (metadata === undefined) return { observed: false };
  if (!object(metadata)) throw invalid("MODEL_USAGE_INVALID");
  for (const key of ["promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "cachedContentTokenCount", "toolUsePromptTokenCount", "totalTokenCount"]) {
    if (metadata[key] !== undefined && !count(metadata[key])) throw invalid("MODEL_USAGE_INVALID");
  }
  if (!count(metadata.promptTokenCount) || !count(metadata.candidatesTokenCount)) return { observed: false };
  const thoughts = (metadata.thoughtsTokenCount as number | undefined) ?? 0;
  const inputTokens = metadata.promptTokenCount + ((metadata.toolUsePromptTokenCount as number | undefined) ?? 0);
  const outputTokens = metadata.candidatesTokenCount + thoughts;
  if (!count(inputTokens) || !count(outputTokens) || !count(inputTokens + outputTokens) || outputTokens > maxOutputTokens ||
      (metadata.cachedContentTokenCount !== undefined && Number(metadata.cachedContentTokenCount) > metadata.promptTokenCount) ||
      (metadata.totalTokenCount !== undefined && metadata.totalTokenCount !== inputTokens + outputTokens)) throw invalid("MODEL_USAGE_INVALID");
  return { observed: true, inputTokens, outputTokens,
    ...(metadata.cachedContentTokenCount === undefined ? {} : { cachedInputTokens: Number(metadata.cachedContentTokenCount) }),
    ...(metadata.thoughtsTokenCount === undefined ? {} : { reasoningTokens: thoughts }) };
}

/** Thin Gemini REST streaming adapter. The caller supplies the controlled physical fetch. */
export async function callGoogleProviderModel(request: ProviderTransportRequest, options: ProviderTransportOptions): Promise<ProviderTransportResponse> {
  let dispatched = false, status: number | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const control = new AbortController();
  const cancel = () => { control.abort(options.signal?.reason); void reader?.cancel().catch(() => {}); };
  try {
    if (request.protocol !== "google_generate_content" || !request.provider || !request.credentialRevision || !request.messages.length ||
        !options.apiKey || /\s/.test(options.apiKey) || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 ||
        !Number.isSafeInteger(request.contextWindowTokens) || request.contextWindowTokens <= request.maxOutputTokens) throw rejected("MODEL_CONFIGURATION_INVALID");
    if (!options.fetch) throw rejected("MODEL_NETWORK_POLICY_REQUIRED");
    if (options.signal?.aborted) throw rejected("MODEL_CANCELLED_BEFORE_DISPATCH", 409);
    options.signal?.addEventListener("abort", cancel, { once: true });
    const url = googleModelRequestUrl(request.baseUrl, request.model);
    const contents = googleHistory(request);
    const system = request.messages.filter(message => message.role === "system").map(message => message.content ?? "").join("\n\n");
    let thinkingConfig: JsonObject | undefined;
    if (request.reasoning !== undefined) {
      if (Object.keys(request.reasoning).some(key => key !== "thinkingConfig") || !object(request.reasoning.thinkingConfig)) throw rejected("MODEL_REASONING_CONFIGURATION_INVALID");
      thinkingConfig = request.reasoning.thinkingConfig;
      if (Object.keys(thinkingConfig).some(key => !["thinkingBudget", "thinkingLevel", "includeThoughts"].includes(key)) ||
          thinkingConfig.thinkingBudget !== undefined && (!count(thinkingConfig.thinkingBudget) || thinkingConfig.thinkingBudget > request.maxOutputTokens) ||
          thinkingConfig.thinkingLevel !== undefined && !["MINIMAL", "LOW", "MEDIUM", "HIGH", "XHIGH"].includes(String(thinkingConfig.thinkingLevel)) ||
          thinkingConfig.includeThoughts !== undefined && typeof thinkingConfig.includeThoughts !== "boolean") throw rejected("MODEL_REASONING_CONFIGURATION_INVALID");
    }
    const payload: JsonObject = { contents,
      generationConfig: { maxOutputTokens: request.maxOutputTokens, candidateCount: 1, ...(thinkingConfig ? { thinkingConfig: { ...thinkingConfig, includeThoughts: false } } : {}) },
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(request.tools?.length ? { tools: [{ functionDeclarations: request.tools.map(tool => ({ name: tool.function.name,
        description: tool.function.description, parametersJsonSchema: tool.function.parameters })) }] } : {}) };
    options.preparePayload?.(payload);
    const body = JSON.stringify(payload);
    if (request.maxRequestBytes !== undefined && Buffer.byteLength(body) > request.maxRequestBytes) throw rejected("MODEL_REQUEST_BYTES_EXCEEDED");
    await options.beforePayloadDispatch?.(structuredClone(payload));
    if (control.signal.aborted) throw rejected("MODEL_CANCELLED_BEFORE_DISPATCH", 409);
    dispatched = true;
    const response = await options.fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", "x-goog-api-key": options.apiKey },
      body, signal: control.signal, redirect: "error" });
    status = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      const codes: Record<number, string> = { 401: "MODEL_AUTHENTICATION_FAILED", 402: "MODEL_BILLING_REQUIRED", 403: "MODEL_ACCESS_DENIED", 404: "MODEL_UNAVAILABLE", 429: "MODEL_RATE_LIMITED", 503: "MODEL_PROVIDER_UNAVAILABLE" };
      throw new ProviderTransportError(codes[status] ?? "MODEL_REQUEST_FAILED", status >= 400 && status < 500 || status === 503 ? "rejected" : "uncertain", status);
    }
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream" || !response.body) throw invalid("MODEL_RESPONSE_INVALID");
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "", data: string[] = [], bytes = 0, finish: string | undefined, text = "", metadata: unknown, requestId: string | undefined;
    const parts: JsonObject[] = [], calls: HarnessToolCall[] = [], ids = new Set<string>();
    const refusedReasons = new Set(["SAFETY", "RECITATION", "LANGUAGE", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION"]);
    const identity = observeModelIdentity(request.model);
    function event() {
      if (!data.length) return;
      let value: unknown;
      try { value = JSON.parse(data.join("\n")); } catch { throw invalid("MODEL_STREAM_INVALID"); }
      data = [];
      if (!object(value) || value.error !== undefined) throw invalid("MODEL_STREAM_INVALID");
      identity.observe(value.modelVersion);
      if (value.usageMetadata !== undefined) {
        googleUsage(value.usageMetadata, request.maxOutputTokens); metadata = value.usageMetadata;
      }
      if (value.responseId !== undefined) {
        if (typeof value.responseId !== "string" || /[\u0000-\u001f\u007f]/.test(value.responseId)) throw invalid("MODEL_STREAM_INVALID");
        requestId = value.responseId;
      }
      if (object(value.promptFeedback) && value.promptFeedback.blockReason && value.promptFeedback.blockReason !== "BLOCK_REASON_UNSPECIFIED") {
        if (finish || parts.length) throw invalid("MODEL_STREAM_INVALID");
        finish = "SAFETY";
      }
      if (value.candidates === undefined) return;
      if (!Array.isArray(value.candidates) || value.candidates.length > 1) throw invalid("MODEL_STREAM_INVALID");
      const candidate = value.candidates[0];
      if (candidate === undefined) return;
      if (!object(candidate) || candidate.index !== undefined && candidate.index !== 0) throw invalid("MODEL_STREAM_INVALID");
      if (candidate.content !== undefined) {
        if (finish || !object(candidate.content) || candidate.content.role !== undefined && candidate.content.role !== "model" || !Array.isArray(candidate.content.parts)) throw invalid("MODEL_STREAM_INVALID");
        for (const part of candidate.content.parts) {
          if (!object(part) || part.thought !== undefined && typeof part.thought !== "boolean" ||
              part.thoughtSignature !== undefined && typeof part.thoughtSignature !== "string" ||
              part.text !== undefined && typeof part.text !== "string" || part.text !== undefined && part.functionCall !== undefined ||
              Object.keys(part).some(key => !["text", "thought", "thoughtSignature", "functionCall"].includes(key))) throw invalid("MODEL_STREAM_INVALID");
          if (part.functionCall !== undefined) {
            const call = part.functionCall;
            if (part.thought || !object(call) || typeof call.name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(call.name) ||
                call.args !== undefined && !object(call.args) || call.id !== undefined && (typeof call.id !== "string" || !call.id || /[\u0000-\u001f\u007f]/.test(call.id))) throw invalid("MODEL_TOOL_ARGUMENTS_INVALID");
            const id = typeof call.id === "string" ? call.id : `google-${randomUUID()}`;
            if (ids.has(id)) throw invalid("MODEL_TOOL_ARGUMENTS_INVALID");
            ids.add(id); calls.push({ id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } });
            options.onProgress?.();
          }
          if (typeof part.text === "string" && part.text && part.thought !== true) { text += part.text; options.onText?.(part.text); options.onProgress?.(); }
          parts.push(structuredClone(part));
        }
      }
      if (candidate.finishReason !== undefined && candidate.finishReason !== "FINISH_REASON_UNSPECIFIED") {
        if (finish || typeof candidate.finishReason !== "string") throw invalid("MODEL_STREAM_INVALID");
        finish = candidate.finishReason;
      }
    }
    function line(value: string) {
      if (!value) { event(); return; }
      if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
      else if (!value.startsWith(":") && !/^(event|id|retry):/.test(value)) throw invalid("MODEL_STREAM_INVALID");
    }
    for (;;) {
      const chunk = await reader.read();
      if (control.signal.aborted) throw new ProviderTransportError("MODEL_CANCELLED", "uncertain", 409);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (request.maxResponseBytes !== undefined && bytes > request.maxResponseBytes) throw invalid("MODEL_RESPONSE_BYTES_EXCEEDED");
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const boundary = buffer.search(/[\r\n]/);
        if (boundary < 0 || buffer[boundary] === "\r" && boundary === buffer.length - 1) break;
        const width = buffer[boundary] === "\r" && buffer[boundary + 1] === "\n" ? 2 : 1;
        line(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + width);
      }
    }
    buffer += decoder.decode();
    // An unterminated data event is a truncated stream, even if its JSON parses.
    if (buffer.trim() || data.length) throw invalid("MODEL_STREAM_INVALID");
    if (!finish) throw invalid("MODEL_INCOMPLETE_RESPONSE");
    if (finish === "MALFORMED_FUNCTION_CALL" || finish === "UNEXPECTED_TOOL_CALL") throw invalid("MODEL_TOOL_ARGUMENTS_INVALID");
    const refusal = refusedReasons.has(finish);
    if (!refusal && finish !== "STOP" && finish !== "MAX_TOKENS") throw invalid("MODEL_INCOMPLETE_RESPONSE");
    if (calls.length && finish !== "STOP") throw invalid("MODEL_TOOL_ARGUMENTS_INVALID");
    if (!refusal && !calls.length && !text.trim()) throw invalid("MODEL_EMPTY_RESPONSE");
    return { message: { role: "assistant", content: refusal ? null : text || null, ...(!refusal && calls.length ? { tool_calls: calls } : {}) },
      finishReason: refusal ? "refusal" : finish === "MAX_TOKENS" ? "length" : calls.length ? "tool_calls" : "stop",
      modelIdentity: identity.receipt(), usage: googleUsage(metadata, request.maxOutputTokens), ...(requestId ? { providerRequestId: requestId } : {}),
      nativeState: { provider: request.provider, protocol: request.protocol, model: request.model, baseUrl: request.baseUrl,
        credentialRevision: request.credentialRevision, assistant: { role: "model", parts } } };
  } catch (error) {
    if (error instanceof ProviderTransportError) throw error;
    if (options.signal?.aborted) throw new ProviderTransportError("MODEL_CANCELLED", dispatched ? "uncertain" : "rejected", 409);
    if (error instanceof ModelNetworkError) throw new ProviderTransportError(`MODEL_NETWORK_${error.code}`, error.dispatched ? "uncertain" : "rejected");
    throw new ProviderTransportError(options.signal?.aborted ? "MODEL_CANCELLED" : "MODEL_TRANSPORT_FAILED", dispatched ? "uncertain" : "rejected", status ?? 502);
  } finally {
    control.abort();
    await reader?.cancel().catch(() => {});
    options.signal?.removeEventListener("abort", cancel);
  }
}
