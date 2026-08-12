import type { AppConfig } from "../config";
import type { ModelProvider } from "../model/types";

export interface KasiAiModelOption {
  provider: ModelProvider;
  model: string;
  label: string;
  description: string;
  tier: "fast" | "balanced" | "advanced";
}

const catalog: KasiAiModelOption[] = [
  { provider: "openrouter", model: "openai/gpt-4o-mini", label: "GPT-4o mini", description: "Fast, balanced everyday help.", tier: "balanced" },
  { provider: "openrouter", model: "google/gemma-3-27b-it:free", label: "Gemma 3 27B", description: "Free option for general guidance.", tier: "fast" },
  { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B", description: "Stronger reasoning for longer tasks.", tier: "advanced" },
  { provider: "openai", model: "gpt-4o-mini", label: "GPT-4o mini (OpenAI)", description: "Direct OpenAI connection.", tier: "balanced" },
  { provider: "anthropic", model: "claude-3-5-haiku-latest", label: "Claude Haiku", description: "Fast, concise responses.", tier: "fast" },
  { provider: "gemini", model: "gemini-2.0-flash", label: "Gemini Flash", description: "Fast responses through Gemini.", tier: "fast" },
];

function hasProviderCredential(provider: ModelProvider): boolean {
  return Boolean(process.env[{
    openrouter: "OPENROUTER_API_KEY",
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    gemini: "GEMINI_API_KEY",
  }[provider]]?.trim());
}

export function availableKasiAiModels(config: AppConfig): KasiAiModelOption[] {
  const configured: KasiAiModelOption = {
    provider: config.KASIAI_MODEL_PROVIDER,
    model: config.KASIAI_MODEL,
    label: "Workspace default",
    description: "Configured by KasiTek for this workspace.",
    tier: "balanced",
  };
  const visible = catalog.filter((entry) => hasProviderCredential(entry.provider));
  const key = `${configured.provider}:${configured.model}`;
  return [configured, ...visible.filter((entry) => `${entry.provider}:${entry.model}` !== key)];
}

export function isAllowedKasiAiModel(config: AppConfig, provider: ModelProvider, model: string): boolean {
  return availableKasiAiModels(config).some((entry) => entry.provider === provider && entry.model === model);
}
