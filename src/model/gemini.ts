import type { ModelAdapter, ModelCredentials, ModelProvider, ModelRequest, ModelResponse } from "./types";
import { ModelProviderError } from "./types";

interface GeminiResponse {
  responseId?: string;
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  error?: { message?: string; status?: string };
}

export class GeminiAdapter implements ModelAdapter {
  public readonly provider: ModelProvider;
  public readonly capabilities = { toolCalling: true, structuredOutput: false, streaming: false, vision: true } as const;

  private readonly baseUrl: string;
  private readonly apiKeyInQuery: boolean;

  public constructor(options: { provider?: ModelProvider; baseUrl?: string; apiKeyInQuery?: boolean } = {}) {
    this.provider = options.provider ?? "gemini";
    this.baseUrl = (options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    this.apiKeyInQuery = options.apiKeyInQuery ?? true;
  }

  public estimateRequestBytes(request: ModelRequest): number {
    const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => {
        if (message.role === "assistant" && message.toolCalls?.length) {
          return {
            role: "model",
            parts: [
              ...(message.content ? [{ text: message.content }] : []),
              ...message.toolCalls.map((toolCall) => ({ functionCall: { name: toolCall.name, args: toolCall.arguments } })),
            ],
          };
        }
        if (message.role === "tool") {
          let responseValue: unknown = message.content;
          try { responseValue = JSON.parse(message.content); } catch { /* preserve text */ }
          return { role: "user", parts: [{ functionResponse: { name: message.name ?? "tool", response: responseValue } }] };
        }
        return { role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] };
      });
    return Buffer.byteLength(JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: messages,
      ...(request.tools?.length ? { tools: [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })) }] } : {}),
      generationConfig: {
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
      },
    }), "utf8");
  }

  public async complete(request: ModelRequest, credentials: ModelCredentials): Promise<ModelResponse> {
    const startedAt = Date.now();
    const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => {
        if (message.role === "assistant" && message.toolCalls?.length) {
          return {
            role: "model",
            parts: [
              ...(message.content ? [{ text: message.content }] : []),
              ...message.toolCalls.map((toolCall) => ({ functionCall: { name: toolCall.name, args: toolCall.arguments } })),
            ],
          };
        }
        if (message.role === "tool") {
          let responseValue: unknown = message.content;
          try {
            responseValue = JSON.parse(message.content);
          } catch {
            // Keep non-JSON tool output as a string.
          }
          return { role: "user", parts: [{ functionResponse: { name: message.name ?? "tool", response: responseValue } }] };
        }
        return { role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] };
      });
    const url = new URL(`${this.baseUrl}/models/${encodeURIComponent(request.model)}:generateContent`);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKeyInQuery) url.searchParams.set("key", credentials.apiKey);
    else headers.authorization = `Bearer ${credentials.apiKey}`;
    const response = await fetch(url.toString(), {
        method: "POST",
        signal: request.signal,
        headers,
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: messages,
          ...(request.tools?.length
            ? { tools: [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })) }] }
            : {}),
          generationConfig: {
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
          },
        }),
      });
    const body = (await response.json()) as GeminiResponse;
    if (!response.ok) {
      throw new ModelProviderError(
        body.error?.message ?? `Provider returned HTTP ${response.status}`,
        body.error?.status ?? "PROVIDER_HTTP_ERROR",
        response.status === 408 || response.status === 429 || response.status >= 500,
        this.provider,
        response.status,
      );
    }
    const parts = body.candidates?.[0]?.content?.parts ?? [];
    const text = parts.filter((part) => part.text).map((part) => part.text).join("");
    const toolCalls = parts
      .filter((part) => part.functionCall?.name)
      .map((part, index) => ({ id: `gemini-tool-${index}`, name: part.functionCall!.name!, arguments: part.functionCall!.args ?? {} }));
    const inputTokens = body.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = body.usageMetadata?.candidatesTokenCount ?? 0;
    const inputTokensReported = body.usageMetadata?.promptTokenCount !== undefined;
    const outputTokensReported = body.usageMetadata?.candidatesTokenCount !== undefined;
    const totalTokensReported = body.usageMetadata?.totalTokenCount !== undefined;
    return {
      provider: this.provider,
      model: request.model,
      ...(body.responseId?.trim() ? { providerResponseId: body.responseId.trim() } : {}),
      message: { role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) },
      toolCalls,
      finishReason: body.candidates?.[0]?.finishReason ?? null,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: body.usageMetadata?.totalTokenCount ?? inputTokens + outputTokens,
        inputTokensReported,
        outputTokensReported,
        totalTokensReported,
      },
      latencyMs: Date.now() - startedAt,
    };
  }
}
