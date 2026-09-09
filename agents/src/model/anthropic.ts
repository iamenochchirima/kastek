import type { ModelAdapter, ModelCredentials, ModelProvider, ModelRequest, ModelResponse } from "./types";
import { ModelProviderError } from "./types";

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

export class AnthropicAdapter implements ModelAdapter {
  public readonly provider: ModelProvider;
  public readonly capabilities = { toolCalling: true, structuredOutput: false, streaming: false, vision: true } as const;

  private readonly baseUrl: string;
  private readonly authHeader: "x-api-key" | "bearer";

  public constructor(options: { provider?: ModelProvider; baseUrl?: string; authHeader?: "x-api-key" | "bearer" } = {}) {
    this.provider = options.provider ?? "anthropic";
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
    this.authHeader = options.authHeader ?? "x-api-key";
  }

  public estimateRequestBytes(request: ModelRequest): number {
    const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => {
        if (message.role === "tool") return { role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }] };
        if (message.role === "assistant" && message.toolCalls?.length) {
          return {
            role: "assistant",
            content: [
              ...(message.content ? [{ type: "text", text: message.content }] : []),
              ...message.toolCalls.map((toolCall) => ({ type: "tool_use", id: toolCall.id, name: toolCall.name, input: toolCall.arguments })),
            ],
          };
        }
        return { role: message.role, content: message.content };
      });
    return Buffer.byteLength(JSON.stringify({
      model: request.model,
      max_tokens: request.maxTokens ?? 4_096,
      ...(system ? { system } : {}),
      messages,
      ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    }), "utf8");
  }

  public async complete(request: ModelRequest, credentials: ModelCredentials): Promise<ModelResponse> {
    const startedAt = Date.now();
    const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => {
        if (message.role === "tool") {
          return {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }],
          };
        }
        if (message.role === "assistant" && message.toolCalls?.length) {
          return {
            role: "assistant",
            content: [
              ...(message.content ? [{ type: "text", text: message.content }] : []),
              ...message.toolCalls.map((toolCall) => ({ type: "tool_use", id: toolCall.id, name: toolCall.name, input: toolCall.arguments })),
            ],
          };
        }
        return { role: message.role, content: message.content };
      });
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      signal: request.signal,
      headers: {
        "content-type": "application/json",
        [this.authHeader === "bearer" ? "authorization" : "x-api-key"]: this.authHeader === "bearer" ? `Bearer ${credentials.apiKey}` : credentials.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens ?? 4096,
        ...(system ? { system } : {}),
        messages,
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
            }
          : {}),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      }),
    });
    const body = (await response.json()) as AnthropicResponse;
    if (!response.ok) {
      throw new ModelProviderError(
        body.error?.message ?? `Provider returned HTTP ${response.status}`,
        body.error?.type ?? "PROVIDER_HTTP_ERROR",
        response.status === 408 || response.status === 429 || response.status >= 500,
        this.provider,
        response.status,
      );
    }
    const blocks = body.content ?? [];
    const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
    const toolCalls = blocks
      .filter((block) => block.type === "tool_use" && block.name)
      .map((block, index) => ({ id: block.id ?? `anthropic-tool-${index}`, name: block.name!, arguments: block.input ?? {} }));
    const inputTokens = body.usage?.input_tokens ?? 0;
    const outputTokens = body.usage?.output_tokens ?? 0;
    const inputTokensReported = body.usage?.input_tokens !== undefined;
    const outputTokensReported = body.usage?.output_tokens !== undefined;
    return {
      provider: this.provider,
      model: request.model,
      message: { role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) },
      toolCalls,
      finishReason: body.stop_reason ?? null,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        inputTokensReported,
        outputTokensReported,
        totalTokensReported: false,
      },
      latencyMs: Date.now() - startedAt,
    };
  }
}
