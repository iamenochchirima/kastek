import type { ModelAdapter, ModelCredentials, ModelProvider, ModelRequest, ModelResponse, ModelToolCall } from "./types";
import { ModelProviderError } from "./types";
import { toolNameMaps } from "./openai-compatible";

interface ResponsesApiBody {
  id?: string;
  status?: string;
  output?: Array<{
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  incomplete_details?: { reason?: string };
  error?: { message?: string; code?: string };
}

export class OpenAIResponsesAdapter implements ModelAdapter {
  public readonly capabilities = { toolCalling: true, structuredOutput: true, streaming: false, vision: true } as const;

  public constructor(
    public readonly provider: ModelProvider,
    private readonly baseUrl: string,
  ) {}

  public estimateRequestBytes(request: ModelRequest): number {
    return Buffer.byteLength(JSON.stringify(this.requestBody(request)), "utf8");
  }

  private requestBody(request: ModelRequest): Record<string, unknown> {
    const names = toolNameMaps(request.tools);
    const instructions = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const input: Array<Record<string, unknown>> = [];
    for (const message of request.messages) {
      if (message.role === "system") continue;
      if (message.role === "tool") {
        input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
        continue;
      }
      if (message.content) input.push({ role: message.role, content: message.content });
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: names.toProvider(call.name),
          arguments: JSON.stringify(call.arguments),
        });
      }
    }
    return {
      model: request.model,
      input,
      ...(instructions ? { instructions } : {}),
      ...(request.tools?.length ? { tools: request.tools.map((tool) => ({
        type: "function",
        name: names.toProvider(tool.name),
        description: tool.description,
        parameters: tool.inputSchema,
        strict: true,
      })) } : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { max_output_tokens: request.maxTokens }),
      ...(request.responseFormat ? { text: { format: {
        type: "json_schema",
        name: request.responseFormat.name,
        strict: true,
        schema: request.responseFormat.schema,
      } } } : {}),
    };
  }

  public async complete(request: ModelRequest, credentials: ModelCredentials): Promise<ModelResponse> {
    const startedAt = Date.now();
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      signal: request.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${credentials.apiKey}` },
      body: JSON.stringify(this.requestBody(request)),
    });
    const body = await response.json() as ResponsesApiBody;
    if (!response.ok) {
      throw new ModelProviderError(
        body.error?.message ?? `Provider returned HTTP ${response.status}`,
        body.error?.code ?? "PROVIDER_HTTP_ERROR",
        response.status === 408 || response.status === 429 || response.status >= 500,
        this.provider,
        response.status,
      );
    }

    const names = toolNameMaps(request.tools);
    const content = (body.output ?? []).flatMap((item) => item.type === "message" ? item.content ?? [] : [])
      .filter((part) => part.type === "output_text")
      .map((part) => part.text ?? "")
      .join("");
    const toolCalls: ModelToolCall[] = (body.output ?? [])
      .filter((item) => item.type === "function_call" && item.name)
      .map((item, index) => {
        let args: Record<string, unknown>;
        try { args = JSON.parse(item.arguments ?? "{}") as Record<string, unknown>; }
        catch { throw new ModelProviderError("Provider returned invalid tool arguments", "INVALID_TOOL_ARGUMENTS", false, this.provider); }
        return {
          id: item.call_id ?? `${this.provider}-tool-${index}`,
          name: names.toCanonical(item.name ?? ""),
          arguments: args,
        };
      });
    const inputTokensReported = body.usage?.input_tokens !== undefined;
    const outputTokensReported = body.usage?.output_tokens !== undefined;
    const totalTokensReported = body.usage?.total_tokens !== undefined;
    const inputTokens = body.usage?.input_tokens ?? 0;
    const outputTokens = body.usage?.output_tokens ?? 0;
    return {
      provider: this.provider,
      model: request.model,
      ...(body.id?.trim() ? { providerResponseId: body.id.trim() } : {}),
      message: { role: "assistant", content, ...(toolCalls.length ? { toolCalls } : {}) },
      toolCalls,
      finishReason: body.incomplete_details?.reason ?? (body.status === "completed" ? "stop" : body.status ?? null),
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: body.usage?.total_tokens ?? inputTokens + outputTokens,
        inputTokensReported,
        outputTokensReported,
        totalTokensReported,
      },
      latencyMs: Date.now() - startedAt,
    };
  }
}
