import type { HarnessMessage, ToolDefinition } from "./model-messages";
import type { ModelProtocol } from "./model-providers";
export type ProviderProtocol = ModelProtocol;
export interface PrivateNativeState {
  provider: string; protocol: ProviderProtocol; model: string; baseUrl: string; credentialRevision: string;
  assistant: unknown;
}
export interface ProviderTransportRequest {
  provider: string; protocol: ProviderProtocol; model: string; baseUrl: string; credentialRevision: string;
  contextWindowTokens: number; maxOutputTokens: number; messages: HarnessMessage[]; tools?: ToolDefinition[];
  /** Native protocol options, supplied only by the trusted policy resolver. */
  reasoning?: Record<string, unknown>;
  nativeHistory?: Record<number, PrivateNativeState>;
  maxRequestBytes?: number; maxResponseBytes?: number;
}
export interface ProviderTransportOptions {
  apiKey: string; signal?: AbortSignal; fetch?: typeof fetch; onText?: (delta: string) => void;
  onProgress?: () => void;
  beforePayloadDispatch?: (payload: Readonly<Record<string, unknown>>) => Promise<void>;
}
export interface ProviderTransportResponse {
  message: HarnessMessage; finishReason: "stop" | "tool_calls" | "length" | "refusal";
  usage: { observed: boolean; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number;
    cacheWriteTokens?: number; reasoningTokens?: number };
  providerRequestId?: string; nativeState: PrivateNativeState;
}
export class ProviderTransportError extends Error {
  constructor(readonly code: string, readonly outcome: "rejected" | "uncertain", readonly status = 502) {
    super(code); this.name = "ProviderTransportError";
  }
}

