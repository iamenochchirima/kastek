import { AnthropicAdapter } from "./anthropic";
import { createOpenAIAdapter, createOpenRouterAdapter } from "./openai-compatible";
import { GeminiAdapter } from "./gemini";
import { ModelProviderError, type ModelAdapter, type ModelCapabilities, type ModelCredentials, type ModelPricing, type ModelProvider, type ModelRequest, type ModelResponse } from "./types";

export class ModelGateway {
  private readonly adapters: Map<ModelProvider, ModelAdapter>;
  private readonly retryBaseDelayMs: number;
  private readonly pricing: Record<string, ModelPricing>;

  public constructor(adapters: ModelAdapter[] = [
    createOpenRouterAdapter(), createOpenAIAdapter(), new AnthropicAdapter(), new GeminiAdapter(),
  ], options: { retryBaseDelayMs?: number; pricing?: Record<string, ModelPricing> } = {}) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
    this.pricing = options.pricing ?? {};
  }

  public capabilities(provider: ModelProvider): ModelCapabilities | undefined {
    return this.adapters.get(provider)?.capabilities;
  }

  public async complete(request: ModelRequest, credentials: ModelCredentials): Promise<ModelResponse> {
    const adapter = this.adapters.get(request.provider);
    if (!adapter) throw new Error(`No model adapter configured for provider ${request.provider}`);
    if (!credentials.apiKey) throw new Error(`No credential supplied for provider ${request.provider}`);
    if (request.tools?.length && !adapter.capabilities.toolCalling) {
      throw new ModelProviderError("Provider does not support tool calling", "MODEL_CAPABILITY_UNSUPPORTED", false, request.provider);
    }
    const maxAttempts = Math.max(1, Math.min(request.maxAttempts ?? 3, 5));
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = request.timeoutMs && request.timeoutMs > 0
        ? setTimeout(() => controller.abort(), request.timeoutMs)
        : undefined;
      const abortParent = (): void => controller.abort();
      request.signal?.addEventListener("abort", abortParent, { once: true });
      try {
        const response = await adapter.complete({ ...request, signal: controller.signal }, credentials);
        if (response.usage.estimatedCostUsd === undefined) {
          response.usage.estimatedCostUsd = this.estimateCost(response.provider, response.model, response.usage.inputTokens, response.usage.outputTokens);
        }
        return response;
      } catch (error) {
        const providerError = error instanceof ModelProviderError ? error : undefined;
        if (controller.signal.aborted && !request.signal?.aborted) {
          throw new ModelProviderError("Model request timed out", "MODEL_TIMEOUT", true, request.provider);
        }
        if (!providerError || !providerError.retryable || attempt >= maxAttempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.retryBaseDelayMs * 2 ** (attempt - 1)));
      } finally {
        if (timeout) clearTimeout(timeout);
        request.signal?.removeEventListener("abort", abortParent);
      }
    }
    throw new Error("Model gateway exhausted attempts");
  }

  public estimateCost(provider: ModelProvider, model: string, inputTokens: number, outputTokens: number): number {
    const pricing = this.pricing[`${provider}:${model}`] ?? this.pricing[`${provider}:*`];
    if (!pricing) return 0;
    return (inputTokens / 1_000_000) * pricing.inputUsdPerMillion + (outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
  }
}
