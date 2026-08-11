import { AnthropicAdapter } from "./anthropic";
import { createOpenAIAdapter, createOpenRouterAdapter } from "./openai-compatible";
import { GeminiAdapter } from "./gemini";
import type { ModelAdapter, ModelCredentials, ModelProvider, ModelRequest, ModelResponse } from "./types";

export class ModelGateway {
  private readonly adapters: Map<ModelProvider, ModelAdapter>;

  public constructor(adapters: ModelAdapter[] = [
    createOpenRouterAdapter(),
    createOpenAIAdapter(),
    new AnthropicAdapter(),
    new GeminiAdapter(),
  ]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  public async complete(request: ModelRequest, credentials: ModelCredentials): Promise<ModelResponse> {
    const adapter = this.adapters.get(request.provider);
    if (!adapter) throw new Error(`No model adapter configured for provider ${request.provider}`);
    if (!credentials.apiKey) throw new Error(`No credential supplied for provider ${request.provider}`);
    return adapter.complete(request, credentials);
  }
}
