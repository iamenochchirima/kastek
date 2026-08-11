import type {
  ModelAdapter,
  ModelCredentials,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ModelUsage,
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

export class OpenAICompatibleAdapter implements ModelAdapter {
  public readonly provider: Extract<ModelProvider, "openrouter" | "openai">;
  public readonly capabilities = { toolCalling: true, structuredOutput: true, streaming: false, vision: true } as const;

  public constructor(private readonly options: OpenAICompatibleAdapterOptions) {
    this.provider = options.provider;
  }

  public async complete(request: ModelRequest, credentials: ModelCredentials): Promise<ModelResponse> {
    const startedAt = Date.now();
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
          ...(message.name ? { name: message.name } : {}),
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((toolCall) => ({
                  id: toolCall.id,
                  type: "function",
                  function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
                })),
              }
            : {}),
        })),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                type: "function",
                function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
              })),
            }
          : {}),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
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
        name: toolCall.function?.name ?? "",
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
