import { AnthropicAdapter } from "./anthropic";
import { GeminiAdapter } from "./gemini";
import { OpenAIResponsesAdapter } from "./openai-responses";
import { createOpenAICompatibleAdapter } from "./openai-compatible";
import { openCodeModelProtocol } from "./opencode-route";
import { ModelProviderError, type ModelAdapter, type ModelCapabilities, type ModelCredentials, type ModelProvider, type ModelRequest, type ModelResponse, type ModelStreamDelta } from "./types";

export class OpenCodeAdapter implements ModelAdapter {
  public readonly provider: ModelProvider;
  public readonly capabilities: ModelCapabilities;

  private readonly chat: ModelAdapter;
  private readonly responses: ModelAdapter;
  private readonly anthropic: ModelAdapter;
  private readonly gemini: ModelAdapter;

  public constructor(provider: "opencode_go" | "opencode_zen", baseUrl: string) {
    this.provider = provider;
    this.chat = createOpenAICompatibleAdapter(provider, baseUrl);
    this.responses = new OpenAIResponsesAdapter(provider, baseUrl);
    this.anthropic = new AnthropicAdapter({ provider, baseUrl, authHeader: "x-api-key" });
    this.gemini = new GeminiAdapter({ provider, baseUrl });
    this.capabilities = this.chat.capabilities;
  }

  public capabilitiesForModel(model: string): ModelCapabilities {
    const protocol = openCodeModelProtocol(this.provider, model);
    if (!protocol) return { toolCalling: false, structuredOutput: false, streaming: false, vision: false };
    return this.adapterForProtocol(protocol).capabilities;
  }

  public estimateRequestBytes(request: ModelRequest): number {
    const adapter = this.adapterFor(request.model);
    return adapter.estimateRequestBytes?.(request) ?? Buffer.byteLength(JSON.stringify(request), "utf8");
  }

  public complete(request: ModelRequest, credentials: ModelCredentials): Promise<ModelResponse> {
    return this.adapterFor(request.model).complete(request, credentials);
  }

  public async stream(request: ModelRequest, credentials: ModelCredentials, onDelta: (delta: ModelStreamDelta) => void | Promise<void>): Promise<ModelResponse> {
    const adapter = this.adapterFor(request.model);
    if (!adapter.stream || !adapter.capabilities.streaming) {
      throw new ModelProviderError("This OpenCode model does not support streaming", "MODEL_CAPABILITY_UNSUPPORTED", false, this.provider);
    }
    return adapter.stream(request, credentials, onDelta);
  }

  private adapterFor(model: string): ModelAdapter {
    const protocol = openCodeModelProtocol(this.provider, model);
    if (!protocol) throw new ModelProviderError(
      `No supported API route is known for ${this.provider} model ${model}`,
      "MODEL_PROTOCOL_UNSUPPORTED",
      false,
      this.provider,
    );
    return this.adapterForProtocol(protocol);
  }

  private adapterForProtocol(protocol: NonNullable<ReturnType<typeof openCodeModelProtocol>>): ModelAdapter {
    switch (protocol) {
      case "openai-chat-completions": return this.chat;
      case "openai-responses": return this.responses;
      case "anthropic-messages": return this.anthropic;
      case "gemini-generate-content": return this.gemini;
    }
  }
}
