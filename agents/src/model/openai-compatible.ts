import { createHash } from "node:crypto";
import type {
  ModelAdapter,
  ModelCredentials,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ModelUsage,
  ModelStreamDelta,
} from "./types";
import { ModelProviderError, type ModelProvider } from "./types";

interface OpenAICompatibleResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; code?: string };
}

export interface OpenAICompatibleAdapterOptions {
  provider: Extract<ModelProvider, "openrouter" | "openai">;
  baseUrl: string;
  extraHeaders?: Record<string, string>;
}

const PROVIDER_FUNCTION_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * OpenAI-compatible providers commonly reject dots in function names, while
 * KasiTek keeps dotted canonical namespaces internally. Use an alias solely
 * at the provider boundary and translate it back before tool execution.
 */
function providerToolName(name: string): string {
  if (PROVIDER_FUNCTION_NAME.test(name)) return name;
  return `kasitek_${createHash("sha256").update(name).digest("hex").slice(0, 32)}`;
}

function toolNameMaps(tools: ModelRequest["tools"]): {
  toProvider: (name: string) => string;
  toCanonical: (name: string) => string;
} {
  const canonicalToProvider = new Map<string, string>();
  const providerToCanonical = new Map<string, string>();
  for (const tool of tools ?? []) {
    const providerName = providerToolName(tool.name);
    canonicalToProvider.set(tool.name, providerName);
    providerToCanonical.set(providerName, tool.name);
  }
  return {
    toProvider: (name) => canonicalToProvider.get(name) ?? providerToolName(name),
    toCanonical: (name) => providerToCanonical.get(name) ?? name,
  };
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  public readonly provider: Extract<ModelProvider, "openrouter" | "openai">;
  public readonly capabilities = { toolCalling: true, structuredOutput: true, streaming: true, vision: true } as const;

  public constructor(private readonly options: OpenAICompatibleAdapterOptions) {
    this.provider = options.provider;
  }

  public async complete(request: ModelRequest, credentials: ModelCredentials): Promise<ModelResponse> {
    const startedAt = Date.now();
    const names = toolNameMaps(request.tools);
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: request.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentials.apiKey}`,
        ...this.options.extraHeaders,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
          ...(message.name ? { name: names.toProvider(message.name) } : {}),
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((toolCall) => ({
                  id: toolCall.id,
                  type: "function",
                  function: { name: names.toProvider(toolCall.name), arguments: JSON.stringify(toolCall.arguments) },
                })),
              }
            : {}),
        })),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                type: "function",
                function: { name: names.toProvider(tool.name), description: tool.description, parameters: tool.inputSchema },
              })),
            }
          : {}),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
        ...(request.responseFormat
          ? { response_format: { type: "json_schema", json_schema: { name: request.responseFormat.name, strict: true, schema: request.responseFormat.schema } } }
          : {}),
      }),
    });
    const body = (await response.json()) as OpenAICompatibleResponse;
    if (!response.ok) {
      throw new ModelProviderError(
        body.error?.message ?? `Provider returned HTTP ${response.status}`,
        body.error?.code ?? "PROVIDER_HTTP_ERROR",
        response.status === 408 || response.status === 429 || response.status >= 500,
        this.provider,
        response.status,
      );
    }
    const choice = body.choices?.[0];
    if (!choice?.message) {
      throw new ModelProviderError("Provider returned no model choice", "EMPTY_MODEL_RESPONSE", true, this.provider);
    }
    const toolCalls: ModelToolCall[] = (choice.message.tool_calls ?? []).map((toolCall, index) => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function?.arguments ?? "{}") as Record<string, unknown>;
      } catch {
        throw new ModelProviderError("Provider returned invalid tool arguments", "INVALID_TOOL_ARGUMENTS", false, this.provider);
      }
      return {
        id: toolCall.id ?? `${this.provider}-tool-${index}`,
        name: names.toCanonical(toolCall.function?.name ?? ""),
        arguments: args,
      };
    });
    const usage: ModelUsage = {
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
      totalTokens: body.usage?.total_tokens ?? (body.usage?.prompt_tokens ?? 0) + (body.usage?.completion_tokens ?? 0),
    };
    return {
      provider: this.provider,
      model: request.model,
      message: { role: "assistant", content: choice.message.content ?? "", ...(toolCalls.length ? { toolCalls } : {}) },
      toolCalls,
      finishReason: choice.finish_reason ?? null,
      usage,
      latencyMs: Date.now() - startedAt,
    };
  }

  public async stream(request: ModelRequest, credentials: ModelCredentials, onDelta: (delta: ModelStreamDelta) => void | Promise<void>): Promise<ModelResponse> {
    const startedAt = Date.now();
    const names = toolNameMaps(request.tools);
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: request.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${credentials.apiKey}`, ...this.options.extraHeaders },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
          ...(message.name ? { name: names.toProvider(message.name) } : {}),
          ...(message.toolCalls?.length ? {
            tool_calls: message.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: "function",
              function: { name: names.toProvider(toolCall.name), arguments: JSON.stringify(toolCall.arguments) },
            })),
          } : {}),
        })),
        ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: "function", function: { name: names.toProvider(tool.name), description: tool.description, parameters: tool.inputSchema } })) } : {}),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!response.ok || !response.body) throw new ModelProviderError(`Streaming provider returned HTTP ${response.status}`, "PROVIDER_STREAM_ERROR", response.status === 408 || response.status === 429 || response.status >= 500, this.provider, response.status);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let deltaCount = 0;
    const toolCalls: ModelToolCall[] = [];
    const toolArgumentBuffers = new Map<number, string>();
    const emitLine = async (line: string): Promise<void> => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let chunk: { choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      try { chunk = JSON.parse(payload) as typeof chunk; } catch { return; }
      const choice = chunk.choices?.[0];
      const text = choice?.delta?.content ?? "";
      if (text) { content += text; deltaCount += 1; await onDelta({ type: "text_delta", text }); }
      for (const call of choice?.delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const current = toolCalls[index] ?? { id: call.id ?? `${this.provider}-tool-${index}`, name: names.toCanonical(call.function?.name ?? ""), arguments: {} };
        const argumentsText = call.function?.arguments ?? "";
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name = names.toCanonical(call.function.name);
        if (argumentsText) {
          const combined = `${toolArgumentBuffers.get(index) ?? ""}${argumentsText}`;
          toolArgumentBuffers.set(index, combined);
          try { current.arguments = JSON.parse(combined) as Record<string, unknown>; } catch { /* wait for the final delta */ }
        }
        toolCalls[index] = current;
        deltaCount += 1;
        await onDelta({ type: "tool_call_delta", index, id: call.id, name: call.function?.name ? names.toCanonical(call.function.name) : undefined, argumentsDelta: argumentsText });
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      inputTokens = chunk.usage?.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage?.completion_tokens ?? outputTokens;
    };
    for (;;) {
      const next = await reader.read();
      buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) await emitLine(line);
      if (next.done) break;
    }
    if (buffer) await emitLine(buffer);
    return { provider: this.provider, model: request.model, message: { role: "assistant", content, ...(toolCalls.length ? { toolCalls } : {}) }, toolCalls, finishReason, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }, latencyMs: Date.now() - startedAt };
  }
}

export function createOpenRouterAdapter(): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    extraHeaders: {
      ...(process.env.KASITEK_APP_URL ? { "http-referer": process.env.KASITEK_APP_URL } : {}),
      "x-title": "KasiTek Agent Platform",
    },
  });
}

export function createOpenAIAdapter(): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({ provider: "openai", baseUrl: "https://api.openai.com/v1" });
}
