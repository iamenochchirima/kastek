import { isModelProvider, type ModelProvider } from "./types";

export type ModelProviderWire = "openai" | "anthropic" | "gemini";

export interface ModelProviderDefinition {
  id: ModelProvider;
  label: string;
  wire: ModelProviderWire;
  apiKeyEnv: string;
  baseUrl?: string;
  verificationUrl: string;
  verificationAuth: "bearer" | "x-api-key" | "gemini-query";
  defaultModel: string;
  fastModel: string;
  catalogUrl?: string;
}

/**
 * The provider registry is the single backend contract for model providers.
 * Provider ids are deliberately stable because they are stored with agent
 * versions and credential references.
 */
export const MODEL_PROVIDER_DEFINITIONS: Record<ModelProvider, ModelProviderDefinition> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    wire: "openai",
    apiKeyEnv: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    verificationUrl: "https://openrouter.ai/api/v1/models",
    verificationAuth: "bearer",
    defaultModel: "openai/gpt-4o-mini",
    fastModel: "google/gemma-3-27b-it:free",
    catalogUrl: "https://openrouter.ai/api/v1/models?output_modalities=text",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    wire: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    verificationUrl: "https://api.openai.com/v1/models",
    verificationAuth: "bearer",
    defaultModel: "gpt-5.5",
    fastModel: "gpt-4.1-mini",
    catalogUrl: "https://api.openai.com/v1/models",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    wire: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    verificationUrl: "https://api.anthropic.com/v1/models",
    verificationAuth: "x-api-key",
    defaultModel: "claude-sonnet-5",
    fastModel: "claude-haiku-4-5-20251001",
    catalogUrl: "https://api.anthropic.com/v1/models?limit=1000",
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    wire: "gemini",
    apiKeyEnv: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    verificationUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    verificationAuth: "gemini-query",
    defaultModel: "gemini-3.5-flash",
    fastModel: "gemini-3.1-flash-lite",
    catalogUrl: "https://generativelanguage.googleapis.com/v1beta/models",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    wire: "openai",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com",
    verificationUrl: "https://api.deepseek.com/models",
    verificationAuth: "bearer",
    defaultModel: "deepseek-v4-pro",
    fastModel: "deepseek-v4-pro",
    catalogUrl: "https://api.deepseek.com/models",
  },
  glm: {
    id: "glm",
    label: "GLM",
    wire: "anthropic",
    apiKeyEnv: "ZHIPU_API_KEY",
    baseUrl: "https://api.z.ai/api/anthropic/v1",
    // Z.ai exposes the model catalogue on its OpenAI-compatible API while
    // the agent runtime uses the Anthropic-compatible coding endpoint.
    verificationUrl: "https://api.z.ai/api/paas/v4/models",
    verificationAuth: "bearer",
    defaultModel: "glm-5.2",
    fastModel: "glm-5-turbo",
    catalogUrl: "https://api.z.ai/api/paas/v4/models",
  },
  kimi: {
    id: "kimi",
    label: "Kimi",
    wire: "anthropic",
    apiKeyEnv: "MOONSHOT_API_KEY",
    baseUrl: "https://api.moonshot.ai/anthropic/v1",
    verificationUrl: "https://api.moonshot.ai/v1/models",
    verificationAuth: "bearer",
    defaultModel: "kimi-k3",
    fastModel: "kimi-k2.7-code-highspeed",
    catalogUrl: "https://api.moonshot.ai/v1/models",
  },
  minimax: {
    id: "minimax",
    label: "MiniMax",
    wire: "anthropic",
    apiKeyEnv: "MINIMAX_API_KEY",
    baseUrl: "https://api.minimaxi.com/anthropic/v1",
    verificationUrl: "https://api.minimaxi.com/anthropic/v1/models",
    verificationAuth: "x-api-key",
    defaultModel: "MiniMax-M3",
    fastModel: "MiniMax-M2",
    catalogUrl: "https://api.minimaxi.com/anthropic/v1/models",
  },
  xai: {
    id: "xai",
    label: "xAI",
    wire: "openai",
    apiKeyEnv: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
    verificationUrl: "https://api.x.ai/v1/models",
    verificationAuth: "bearer",
    defaultModel: "grok-4.6",
    fastModel: "grok-4.6",
    catalogUrl: "https://api.x.ai/v1/language-models",
  },
  opencode_go: {
    id: "opencode_go",
    label: "OpenCode Go",
    wire: "openai",
    apiKeyEnv: "OPENCODE_GO_API_KEY",
    baseUrl: "https://opencode.ai/zen/go/v1",
    verificationUrl: "https://opencode.ai/zen/go/v1/models",
    verificationAuth: "bearer",
    defaultModel: "deepseek-v4-flash",
    fastModel: "deepseek-v4-flash",
    catalogUrl: "https://opencode.ai/zen/go/v1/models",
  },
  opencode_zen: {
    id: "opencode_zen",
    label: "OpenCode Zen",
    wire: "openai",
    apiKeyEnv: "OPENCODE_ZEN_API_KEY",
    baseUrl: "https://opencode.ai/zen/v1",
    verificationUrl: "https://opencode.ai/zen/v1/models",
    verificationAuth: "bearer",
    defaultModel: "deepseek-v4-flash-free",
    fastModel: "deepseek-v4-flash-free",
    catalogUrl: "https://opencode.ai/zen/v1/models",
  },
};

export function modelProviderDefinition(provider: ModelProvider): ModelProviderDefinition {
  return MODEL_PROVIDER_DEFINITIONS[provider];
}

export function modelProviderEnvironmentKey(provider?: string): string | undefined {
  return provider && isModelProvider(provider) ? MODEL_PROVIDER_DEFINITIONS[provider].apiKeyEnv : undefined;
}
