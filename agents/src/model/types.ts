export type ModelProvider = "openrouter" | "openai" | "anthropic" | "gemini";
export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ModelMessage {
  role: MessageRole;
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: ModelToolCall[];
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  provider: ModelProvider;
  model: string;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
}

export interface ModelResponse {
  provider: ModelProvider;
  model: string;
  message: ModelMessage;
  toolCalls: ModelToolCall[];
  finishReason: string | null;
  usage: ModelUsage;
  latencyMs: number;
}

export interface ModelCredentials {
  apiKey: string;
  fundingSource: "kasitek" | "user";
  credentialReference?: string;
}

export interface ModelAdapter {
  readonly provider: ModelProvider;
  complete(request: ModelRequest, credentials: ModelCredentials): Promise<ModelResponse>;
}

export class ModelProviderError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly provider: ModelProvider,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}
