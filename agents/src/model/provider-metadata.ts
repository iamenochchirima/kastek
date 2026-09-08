import { createHash } from "node:crypto";
import { modelProviderDefinition } from "./providers";
import { isModelProvider, type ModelCredentials, type ModelProvider } from "./types";
import type { ModelCapabilityCatalogEntry, ModelCapabilityRoute } from "./model-capability-catalog";

const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_TTL_MS = 5 * 60_000;

type JsonRecord = Record<string, unknown>;

export interface ProviderMetadataClientOptions {
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly ttlMs?: number;
}

export interface ProviderMetadataRequest {
  readonly route: ModelCapabilityRoute;
  readonly credentials: ModelCredentials;
}

interface CachedMetadata {
  readonly entry: ModelCapabilityCatalogEntry;
  readonly expiresAt: number;
}

/**
 * Reads only provider-published model metadata. This adapter never supplies a
 * family default: a malformed response or a provider without an authoritative
 * context field returns undefined and leaves the context runtime fail-closed.
 * API keys are used only for the request and are excluded from cache keys,
 * errors, and returned metadata.
 */
export class ProviderMetadataClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CachedMetadata>();

  public constructor(options: ProviderMetadataClientOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = positiveInteger(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
    this.ttlMs = positiveInteger(options.ttlMs) ?? DEFAULT_TTL_MS;
  }

  public async resolve(input: ProviderMetadataRequest): Promise<ModelCapabilityCatalogEntry | undefined> {
    const { route, credentials } = input;
    if (!isModelProvider(route.provider)) return undefined;
    if (route.endpointId !== `${route.provider}:default`) return undefined;
    if (!credentials.apiKey.trim()) return undefined;

    const cacheKey = this.cacheKey(route, credentials);
    const cached = this.cache.get(cacheKey);
    const now = this.now();
    if (cached && cached.expiresAt > now) return cached.entry;
    if (cached) this.cache.delete(cacheKey);

    const definition = modelProviderDefinition(route.provider as ModelProvider);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(this.requestUrl(definition.verificationUrl, definition.verificationAuth, credentials.apiKey), {
        signal: controller.signal,
        headers: this.requestHeaders(definition.verificationAuth, credentials.apiKey),
      });
      if (!response.ok) return undefined;
      const payload = await response.json() as unknown;
      const model = findModel(payload, route.model);
      if (!model) return undefined;
      const capability = parseCapability(model);
      if (!capability) return undefined;

      const resolvedAt = new Date(now).toISOString();
      const entry: ModelCapabilityCatalogEntry = {
        ...route,
        ...capability,
        source: "provider_metadata",
        resolvedAt,
        expiresAt: new Date(now + this.ttlMs).toISOString(),
      };
      this.cache.set(cacheKey, { entry, expiresAt: now + this.ttlMs });
      return entry;
    } catch {
      // Metadata is an optional admission source. The caller decides whether
      // the absence of a safe capability is terminal for this attempt.
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private cacheKey(route: ModelCapabilityRoute, credentials: ModelCredentials): string {
    const credentialDigest = createHash("sha256").update(credentials.apiKey).digest("hex");
    return JSON.stringify([route.provider, route.endpointId, route.credentialRouteId, route.model, route.runtimeEnvironment, credentialDigest]);
  }

  private requestUrl(url: string, auth: "bearer" | "x-api-key" | "gemini-query", apiKey: string): string {
    if (auth !== "gemini-query") return url;
    const parsed = new URL(url);
    parsed.searchParams.set("key", apiKey);
    return parsed.toString();
  }

  private requestHeaders(auth: "bearer" | "x-api-key" | "gemini-query", apiKey: string): Record<string, string> {
    if (auth === "bearer") return { authorization: `Bearer ${apiKey}`, accept: "application/json" };
    if (auth === "x-api-key") return { "x-api-key": apiKey, "anthropic-version": "2023-06-01", accept: "application/json" };
    return { accept: "application/json" };
  }
}

function findModel(payload: unknown, requestedModel: string): JsonRecord | undefined {
  const records = modelRecords(payload);
  return records.find((record) => modelMatches(record, requestedModel));
}

function modelRecords(payload: unknown): JsonRecord[] {
  if (!isRecord(payload)) return [];
  const candidates = [payload.data, payload.models];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const records = candidate.filter(isRecord);
    if (records.length) return records;
  }
  return [payload];
}

function modelMatches(record: JsonRecord, requestedModel: string): boolean {
  const requested = normalizeModelName(requestedModel);
  return [record.id, record.name, record.model, record.displayName]
    .filter((value): value is string => typeof value === "string")
    .some((value) => normalizeModelName(value) === requested);
}

function normalizeModelName(value: string): string {
  const normalized = value.trim();
  return normalized.startsWith("models/") ? normalized.slice("models/".length) : normalized;
}

function parseCapability(record: JsonRecord): { contextWindowTokens?: number; maxOutputTokens?: number } | undefined {
  const contextWindowTokens = firstPositiveInteger(record, [
    "context_length",
    "contextWindow",
    "context_window",
    "inputTokenLimit",
    "input_token_limit",
  ]);
  const maxOutputTokens = firstPositiveInteger(record, [
    "max_output_tokens",
    "maxOutputTokens",
    "outputTokenLimit",
    "output_token_limit",
    "max_completion_tokens",
  ]) ?? (isRecord(record.top_provider)
    ? firstPositiveInteger(record.top_provider, ["max_completion_tokens", "max_output_tokens"])
    : undefined);
  if (contextWindowTokens === undefined && maxOutputTokens === undefined) return undefined;
  return {
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

function firstPositiveInteger(record: JsonRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

function positiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
