/** Provider ids are persisted in policies, conversations, and the credential vault. */
export const MODEL_PROVIDERS = [
  "openrouter",
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "glm",
  "kimi",
  "minimax",
  "xai",
  "opencode_go",
  "opencode_zen",
] as const;

export type ModelProvider = typeof MODEL_PROVIDERS[number];

export function isModelProvider(value: unknown): value is ModelProvider {
  return typeof value === "string" && (MODEL_PROVIDERS as readonly string[]).includes(value);
}
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
  timeoutMs?: number;
  maxAttempts?: number;
  responseFormat?: {
    type: "json_schema";
    name: string;
    schema: Record<string, unknown>;
  };
}

export interface ModelCapabilities {
  toolCalling: boolean;
  structuredOutput: boolean;
  streaming: boolean;
  vision: boolean;
}

export interface ModelPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
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
  structuredOutput?: unknown;
}

export type ModelStreamDelta =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta?: string };

export interface ModelStreamResult {
  response: ModelResponse;
  deltas: number;
}

export interface ModelCredentials {
  apiKey: string;
  fundingSource: "kasitek" | "user";
  credentialReference?: string;
}

export interface ModelAdapter {
  readonly provider: ModelProvider;
  readonly capabilities: ModelCapabilities;
  complete(request: ModelRequest, credentials: ModelCredentials): Promise<ModelResponse>;
  stream?(request: ModelRequest, credentials: ModelCredentials, onDelta: (delta: ModelStreamDelta) => void | Promise<void>): Promise<ModelResponse>;
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
