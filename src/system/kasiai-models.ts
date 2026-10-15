import type { AppConfig } from "../config";
import { MODEL_PROVIDERS, type ModelProvider } from "../model/types";
import { MODEL_PROVIDER_DEFINITIONS } from "../model/providers";
import { openCodeModelProtocol } from "../model/opencode-route";

const CACHE_TTL_MS = 5 * 60_000;
const FAILURE_CACHE_TTL_MS = 60_000;
const CATALOG_TIMEOUT_MS = 10_000;
const MAX_MODELS_PER_PROVIDER = 500;

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

export type ModelCatalogSource = "live" | "fallback" | "mixed";

export interface ProviderModelCatalogStatus {
  source: "live" | "fallback";
  fetchedAt: string;
  error?: string;
}

export interface ProviderKasiAiModelCatalog extends ProviderModelCatalogStatus {
  provider: ModelProvider;
  models: KasiAiModelOption[];
}

export interface KasiAiModelCatalog {
  models: KasiAiModelOption[];
  source: ModelCatalogSource;
  fetchedAt: string;
  error?: string;
  providers: Partial<Record<ModelProvider, ProviderModelCatalogStatus>>;
}

type UnknownRecord = Record<string, unknown>;

interface CachedCatalog {
  expiresAt: number;
  status: ProviderModelCatalogStatus;
  models: KasiAiModelOption[];
}

const cache = new Map<ModelProvider, CachedCatalog>();

const openRouterFallback: KasiAiModelOption[] = [
  { provider: "openrouter", model: "openai/gpt-4o-mini", label: "GPT-4o mini", description: "OpenRouter preset model; live catalog unavailable.", tier: "balanced", supportsTools: true },
  { provider: "openrouter", model: "google/gemma-3-27b-it:free", label: "Gemma 3 27B", description: "OpenRouter preset model; live catalog unavailable.", tier: "fast", isFree: true, supportsTools: true },
  { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B", description: "OpenRouter preset model; live catalog unavailable.", tier: "advanced", supportsTools: true },
];

function fallbackModels(provider: ModelProvider): KasiAiModelOption[] {
  if (provider === "openrouter") return openRouterFallback;
  const definition = MODEL_PROVIDER_DEFINITIONS[provider];
  const ids = [...new Set([definition.defaultModel, definition.fastModel])];
  return ids.map((model, index) => ({
    provider,
    model,
    label: model,
    description: `${definition.label} preset model; connect a ${definition.label} credential to load its live catalog.`,
    tier: index === 0 ? "advanced" : "fast",
    supportsTools: true,
  }));
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
}

function positiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

function pricePerMillion(value: unknown): number | undefined {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Number((parsed * 1_000_000).toFixed(4)) : undefined;
}

function catalogRows(payload: unknown): UnknownRecord[] {
  if (!isRecord(payload)) return [];
  const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  return rows.filter(isRecord);
}

function isOpenAiNonChatModel(id: string): boolean {
  return /(?:^|[-_/])(embedding|embed|whisper|transcri(?:be|ption)|moderation|tts|dall-e|image|realtime|audio|sora)(?:$|[-_/])/i.test(id);
}

function tierFor(id: string, contextWindow?: number): KasiAiModelOption["tier"] {
  if (/(?:mini|flash|haiku|fast|lite|nano)/i.test(id)) return "fast";
  if (/(?:opus|pro|reasoner|ultra|advanced)/i.test(id) || (contextWindow ?? 0) >= 100_000) return "advanced";
  return "balanced";
}

function normalizeModel(provider: ModelProvider, row: UnknownRecord): KasiAiModelOption | null {
  const rawId = firstString(row.id, row.name, row.model);
  if (!rawId) return null;
  const id = provider === "gemini" ? rawId.replace(/^models\//, "") : rawId;
  if ((provider === "openai" || provider === "xai") && isOpenAiNonChatModel(id)) return null;
  if ((provider === "opencode_go" || provider === "opencode_zen") && !openCodeModelProtocol(provider, id)) return null;

  const methods = Array.isArray(row.supportedGenerationMethods)
    ? row.supportedGenerationMethods.filter((method): method is string => typeof method === "string")
    : [];
  if (provider === "gemini" && methods.length && !methods.includes("generateContent")) return null;

  const contextWindow = positiveInteger(row.context_length, row.context_window, row.context_window_tokens, row.inputTokenLimit, row.max_input_tokens);
  const maxOutputTokens = positiveInteger(row.max_output_tokens, row.maxOutputTokens, row.outputTokenLimit, row.max_tokens);
  const parameters = Array.isArray(row.supported_parameters)
    ? row.supported_parameters.filter((parameter): parameter is string => typeof parameter === "string")
    : [];
  const capabilities = isRecord(row.capabilities) ? row.capabilities : {};
  const toolUse = isRecord(capabilities.tool_use) ? capabilities.tool_use : undefined;
  const supportedTools = row.supports_tools ?? row.supportsTools ?? toolUse?.supported
    ?? (parameters.includes("tools") && parameters.includes("tool_choice") ? true : undefined);
  const isFree = id.endsWith(":free") || row.is_free === true || row.isFree === true;
  const pricing = provider === "openrouter" && isRecord(row.pricing) ? row.pricing : undefined;
  const inputPrice = pricePerMillion(pricing?.prompt);
  const outputPrice = pricePerMillion(pricing?.completion);

  return {
    provider,
    model: id,
    label: firstString(row.display_name, row.displayName, row.name, row.label) ?? id,
    description: firstString(row.description) ?? `${MODEL_PROVIDER_DEFINITIONS[provider].label} model.`,
    tier: tierFor(id, contextWindow),
    ...(isFree ? { isFree: true } : {}),
    ...(typeof supportedTools === "boolean" ? { supportsTools: supportedTools } : {}),
    ...(parameters.includes("reasoning") || row.supports_reasoning === true ? { supportsReasoning: true } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(inputPrice !== undefined ? { inputUsdPerMillion: inputPrice } : {}),
    ...(outputPrice !== undefined ? { outputUsdPerMillion: outputPrice } : {}),
  };
}

function catalogRequest(provider: ModelProvider, apiKey: string): { url: string; headers: Record<string, string> } {
  const definition = MODEL_PROVIDER_DEFINITIONS[provider];
  if (!definition.catalogUrl) throw new Error("Catalog endpoint is not configured");
  if (definition.verificationAuth === "gemini-query") {
    const url = new URL(definition.catalogUrl);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", "1000");
    return { url: url.toString(), headers: {} };
  }
  if (definition.verificationAuth === "x-api-key") {
    return {
      url: definition.catalogUrl,
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    };
  }
  return { url: definition.catalogUrl, headers: { authorization: `Bearer ${apiKey}` } };
}

function safeCatalogError(provider: ModelProvider, responseStatus?: number): string {
  const label = MODEL_PROVIDER_DEFINITIONS[provider].label;
  return responseStatus
    ? `${label} model catalog returned HTTP ${responseStatus}.`
    : `Unable to load the ${label} model catalog.`;
}

async function fetchProviderModels(provider: ModelProvider, apiKey: string): Promise<KasiAiModelOption[]> {
  const request = catalogRequest(provider, apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
  try {
    const response = await fetch(request.url, {
      method: "GET",
      signal: controller.signal,
      headers: request.headers,
    });
    if (!response.ok) throw Object.assign(new Error("Catalog request failed"), { statusCode: response.status });
    const payload: unknown = await response.json();
    const models = catalogRows(payload)
      .map((row) => normalizeModel(provider, row))
      .filter((model): model is KasiAiModelOption => model !== null)
      .slice(0, MAX_MODELS_PER_PROVIDER);
    if (!models.length) throw new Error("Provider returned no usable chat models");
    return models;
  } finally {
    clearTimeout(timeout);
  }
}

/** Fetch a single provider's catalog with an organization-scoped credential.
 * BYOK catalogs are deliberately uncached so one organization's model access
 * is never reused for another credential.
 */
export async function getProviderKasiAiModelCatalog(provider: ModelProvider, apiKey: string): Promise<ProviderKasiAiModelCatalog> {
  const fetchedAt = new Date().toISOString();
  try {
    const models = await fetchProviderModels(provider, apiKey.trim());
    return { provider, models, source: "live", fetchedAt };
  } catch (cause) {
    const responseStatus = isRecord(cause) && typeof cause.statusCode === "number" ? cause.statusCode : undefined;
    return { provider, models: fallbackModels(provider), source: "fallback", fetchedAt, error: safeCatalogError(provider, responseStatus) };
  }
}

async function providerCatalog(provider: ModelProvider): Promise<{ models: KasiAiModelOption[]; status: ProviderModelCatalogStatus }> {
  const apiKey = process.env[MODEL_PROVIDER_DEFINITIONS[provider].apiKeyEnv]?.trim();
  if (!apiKey) {
    const fetchedAt = new Date().toISOString();
    return { models: fallbackModels(provider), status: { source: "fallback", fetchedAt } };
  }

  const cached = cache.get(provider);
  if (cached && cached.expiresAt > Date.now()) return { models: cached.models, status: cached.status };

  const fetchedAt = new Date().toISOString();
  try {
    const models = await fetchProviderModels(provider, apiKey);
    const status: ProviderModelCatalogStatus = { source: "live", fetchedAt };
    cache.set(provider, { models, status, expiresAt: Date.now() + CACHE_TTL_MS });
    return { models, status };
  } catch (cause) {
    const responseStatus = isRecord(cause) && typeof cause.statusCode === "number" ? cause.statusCode : undefined;
    const models = fallbackModels(provider);
    const status: ProviderModelCatalogStatus = { source: "fallback", fetchedAt, error: safeCatalogError(provider, responseStatus) };
    cache.set(provider, { models, status, expiresAt: Date.now() + FAILURE_CACHE_TTL_MS });
    return { models, status };
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
  const catalogs = await Promise.all(MODEL_PROVIDERS.map(async (provider) => [provider, await providerCatalog(provider)] as const));
  const providers = Object.fromEntries(catalogs.map(([provider, catalog]) => [provider, catalog.status])) as KasiAiModelCatalog["providers"];
  const providerModels = catalogs.flatMap(([, catalog]) => catalog.models);
  const defaultModel = configuredDefault(config, providerModels);
  const models = [defaultModel, ...providerModels.filter((model) => !(model.provider === defaultModel.provider && model.model === defaultModel.model))];
  const liveCount = catalogs.filter(([, catalog]) => catalog.status.source === "live").length;
  const source: ModelCatalogSource = liveCount === 0 ? "fallback" : liveCount === MODEL_PROVIDERS.length ? "live" : "mixed";
  const errors = catalogs.flatMap(([provider, catalog]) => catalog.status.error ? [catalog.status.error] : []);
  return {
    models,
    source,
    fetchedAt: new Date().toISOString(),
    ...(errors.length ? { error: errors.join(" ") } : {}),
    providers,
  };
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
