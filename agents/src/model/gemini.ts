import type { ModelAdapter, ModelCredentials, ModelRequest, ModelResponse } from "./types";
import { ModelProviderError } from "./types";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  error?: { message?: string; status?: string };
}

export class GeminiAdapter implements ModelAdapter {
  public readonly provider = "gemini" as const;

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
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(credentials.apiKey)}`,
      {
        method: "POST",
        signal: request.signal,
        headers: { "content-type": "application/json" },
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
      },
    );
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
    return {
      provider: this.provider,
      model: request.model,
      message: { role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) },
      toolCalls,
      finishReason: body.candidates?.[0]?.finishReason ?? null,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: body.usageMetadata?.totalTokenCount ?? inputTokens + outputTokens,
      },
      latencyMs: Date.now() - startedAt,
    };
  }
}
