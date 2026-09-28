import type { AppConfig } from "../config";
import type { ModelProvider } from "../model/types";
import { MODEL_PROVIDER_DEFINITIONS, modelProviderEnvironmentKey } from "../model/providers";

const OPENROUTER_CATALOG_URL = "https://openrouter.ai/api/v1/models?output_modalities=text";
const CACHE_TTL_MS = 5 * 60_000;
const FAILURE_CACHE_TTL_MS = 60_000;

export interface KasiAiModelOption {
  provider: ModelProvider;
  model: string;
  label: string;
  description: string;
  tier: "fast" | "balanced" | "advanced";
  isWorkspaceDefault?: boolean;
  isFree?: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}

export interface KasiAiModelCatalog {
  models: KasiAiModelOption[];
  source: "live" | "fallback";
  fetchedAt: string;
  error?: string;
}

interface OpenRouterModel {
  id?: string;
  name?: string;
  description?: string;
  context_length?: number;
  max_output_tokens?: number;
  top_provider?: { max_completion_tokens?: number; max_output_tokens?: number };
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

interface CachedCatalog {
  expiresAt: number;
  catalog: KasiAiModelCatalog;
}

const cache = new Map<string, CachedCatalog>();

const directModels: KasiAiModelOption[] = [
  { provider: "openai", model: MODEL_PROVIDER_DEFINITIONS.openai.defaultModel, label: "OpenAI", description: "Direct OpenAI connection.", tier: "advanced", supportsTools: true },
  { provider: "anthropic", model: MODEL_PROVIDER_DEFINITIONS.anthropic.defaultModel, label: "Claude", description: "Direct Anthropic connection.", tier: "advanced", supportsTools: true },
  { provider: "gemini", model: MODEL_PROVIDER_DEFINITIONS.gemini.defaultModel, label: "Gemini", description: "Direct Gemini connection.", tier: "fast", supportsTools: true },
  { provider: "deepseek", model: MODEL_PROVIDER_DEFINITIONS.deepseek.defaultModel, label: "DeepSeek", description: "Direct DeepSeek connection.", tier: "advanced", supportsTools: true },
  { provider: "glm", model: MODEL_PROVIDER_DEFINITIONS.glm.defaultModel, label: "GLM", description: "Direct GLM connection.", tier: "advanced", supportsTools: true },
  { provider: "kimi", model: MODEL_PROVIDER_DEFINITIONS.kimi.defaultModel, label: "Kimi", description: "Direct Kimi connection.", tier: "advanced", supportsTools: true },
  { provider: "minimax", model: MODEL_PROVIDER_DEFINITIONS.minimax.defaultModel, label: "MiniMax", description: "Direct MiniMax connection.", tier: "advanced", supportsTools: true },
  { provider: "xai", model: MODEL_PROVIDER_DEFINITIONS.xai.defaultModel, label: "Grok", description: "Direct xAI connection.", tier: "advanced", supportsTools: true },
  { provider: "opencode_go", model: MODEL_PROVIDER_DEFINITIONS.opencode_go.defaultModel, label: "OpenCode Go", description: "OpenCode Go connection.", tier: "balanced", supportsTools: true },
  { provider: "opencode_zen", model: MODEL_PROVIDER_DEFINITIONS.opencode_zen.defaultModel, label: "OpenCode Zen", description: "OpenCode Zen connection.", tier: "fast", isFree: true, supportsTools: true },
];

const openRouterFallback: KasiAiModelOption[] = [
  { provider: "openrouter", model: "openai/gpt-4o-mini", label: "GPT-4o mini", description: "Fallback catalog entry while OpenRouter is unavailable.", tier: "balanced", supportsTools: true },
  { provider: "openrouter", model: "google/gemma-3-27b-it:free", label: "Gemma 3 27B", description: "Fallback catalog entry while OpenRouter is unavailable.", tier: "fast", isFree: true, supportsTools: true },
  { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B", description: "Fallback catalog entry while OpenRouter is unavailable.", tier: "advanced", supportsTools: true },
];

function hasProviderCredential(provider: ModelProvider): boolean {
  const key = modelProviderEnvironmentKey(provider);
  return Boolean(key && process.env[key]?.trim());
}

function pricePerMillion(value?: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Number((parsed * 1_000_000).toFixed(4)) : undefined;
}

function tierFor(model: OpenRouterModel, isFree: boolean, supportsTools: boolean): KasiAiModelOption["tier"] {
  if (isFree) return "fast";
  if (supportsTools && (model.context_length ?? 0) >= 100_000) return "advanced";
  return "balanced";
}

function normalizeOpenRouterModel(model: OpenRouterModel): KasiAiModelOption | null {
  const id = model.id?.trim();
  if (!id) return null;
  const parameters = new Set(model.supported_parameters ?? []);
  const inputPrice = pricePerMillion(model.pricing?.prompt);
  const outputPrice = pricePerMillion(model.pricing?.completion);
  const isFree = id.endsWith(":free") || (inputPrice === 0 && outputPrice === 0);
  const supportsTools = parameters.has("tools") && parameters.has("tool_choice");
  const maxOutputTokens = model.max_output_tokens
    ?? model.top_provider?.max_completion_tokens
    ?? model.top_provider?.max_output_tokens;
  return {
    provider: "openrouter",
    model: id,
    label: model.name?.trim() || id,
    description: (model.description?.replace(/\s+/g, " ").trim().slice(0, 280) || "OpenRouter text model."),
    tier: tierFor(model, isFree, supportsTools),
    isFree,
    supportsTools,
    supportsReasoning: parameters.has("reasoning"),
    contextWindow: model.context_length,
    ...(typeof maxOutputTokens === "number" && Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0 ? { maxOutputTokens } : {}),
    inputUsdPerMillion: inputPrice,
    outputUsdPerMillion: outputPrice,
  };
}

async function listOpenRouterModels(): Promise<KasiAiModelCatalog> {
  const cacheKey = "openrouter";
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.catalog;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    const response = await fetch(OPENROUTER_CATALOG_URL, {
      signal: controller.signal,
      headers: {
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        "x-title": "KasiTek Agent Platform",
      },
    });
    if (!response.ok) throw new Error(`OpenRouter model catalog returned HTTP ${response.status}`);
    const payload = await response.json() as { data?: OpenRouterModel[] };
    const models = (payload.data ?? []).map(normalizeOpenRouterModel).filter((model): model is KasiAiModelOption => Boolean(model));
    if (!models.length) throw new Error("OpenRouter returned no text models");
    const catalog: KasiAiModelCatalog = { models, source: "live", fetchedAt: new Date().toISOString() };
    cache.set(cacheKey, { catalog, expiresAt: Date.now() + CACHE_TTL_MS });
    return catalog;
  } catch (cause) {
    const catalog: KasiAiModelCatalog = {
      models: openRouterFallback,
      source: "fallback",
      fetchedAt: new Date().toISOString(),
      error: cause instanceof Error ? cause.message : "Unable to load the OpenRouter model catalog",
    };
    cache.set(cacheKey, { catalog, expiresAt: Date.now() + FAILURE_CACHE_TTL_MS });
    return catalog;
  } finally {
    clearTimeout(timeout);
  }
}

function configuredDefault(config: AppConfig, models: KasiAiModelOption[]): KasiAiModelOption {
  const match = models.find((model) => model.provider === config.KASIAI_MODEL_PROVIDER && model.model === config.KASIAI_MODEL);
  return {
    ...(match ?? {
      provider: config.KASIAI_MODEL_PROVIDER,
      model: config.KASIAI_MODEL,
      label: config.KASIAI_MODEL,
      description: "Configured by KasiTek for this workspace.",
      tier: "balanced" as const,
    }),
    isWorkspaceDefault: true,
  };
}

export async function getKasiAiModelCatalog(config: AppConfig): Promise<KasiAiModelCatalog> {
  const openRouter = hasProviderCredential("openrouter") ? await listOpenRouterModels() : null;
  const models = [
    ...(openRouter?.models ?? []),
    ...directModels,
  ];
  const defaultModel = configuredDefault(config, models);
  const deduplicated = [defaultModel, ...models.filter((model) => !(model.provider === defaultModel.provider && model.model === defaultModel.model))];
  return { ...openRouter, models: deduplicated, source: openRouter?.source ?? "fallback", fetchedAt: openRouter?.fetchedAt ?? new Date().toISOString() };
}

export async function availableKasiAiModels(config: AppConfig): Promise<KasiAiModelOption[]> {
  return (await getKasiAiModelCatalog(config)).models;
}

export async function isAllowedKasiAiModel(config: AppConfig, provider: ModelProvider, model: string): Promise<boolean> {
  return (await availableKasiAiModels(config)).some((entry) => entry.provider === provider && entry.model === model);
}

export function clearKasiAiModelCatalogCacheForTests(): void {
  cache.clear();
}
