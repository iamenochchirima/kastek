import { z } from "zod";
import { requestDigest } from "../../contracts/contracts";
import {
  metadataSourceSchema, modelDescriptorSchema, modelEndpointSchema, providerDefinitionSchema, reasoningEffortSchema,
  type ModelDescriptor, type ProviderDefinition, type ReasoningOptions,
} from "../../contracts/model-providers";

export interface ModelDiscoveryRequest {
  url: string;
  method: "GET";
  headers: Readonly<Record<string, string>>;
  redirect: "error";
  maxResponseBytes: number;
}

/** The caller supplies a transport that enforces egress, streaming byte and deadline limits. */
export type ModelDiscoveryFetch = (request: ModelDiscoveryRequest) => Promise<{ status: number; body: string }>;

export interface ModelDiscoveryOptions {
  apiKey: string;
  endpoint: string;
  fetch: ModelDiscoveryFetch;
  observedAt: string;
  maxResponseBytes: number;
  maxModels: number;
}

export type ModelDiscoveryResult = {
  kind: "discovered";
  visibility: "public_catalog" | "credential_scoped";
  models: ModelDescriptor[];
  observedAt: string;
  complete: boolean;
  /** Complete refreshed listings can retain unavailable saved IDs without silently replacing them. */
  unavailableModelIds?: string[];
} | {
  kind: "manual_required";
  models: ModelDescriptor[];
  observedAt: string;
};

export type ModelDiscoveryErrorCode = "invalid_configuration" | "network_failed" | "authentication_rejected" |
  "access_denied" | "rate_limited" | "unavailable" | "http_rejected" | "redirect_rejected" |
  "invalid_response" | "response_too_large" | "catalogue_limit_exceeded";

export class ModelDiscoveryError extends Error {
  constructor(readonly code: ModelDiscoveryErrorCode, readonly status?: number) {
    super(`Model discovery failed: ${code}`);
    this.name = "ModelDiscoveryError";
  }
}

type MetadataSource = z.infer<typeof metadataSourceSchema>;
type JsonObject = Record<string, unknown>;
const optionsSchema = z.strictObject({
  apiKey: z.string().min(1).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value)),
  endpoint: modelEndpointSchema,
  observedAt: z.iso.datetime(),
  maxResponseBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxModels: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

function object(value: unknown): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new ModelDiscoveryError("invalid_response");
  return value as JsonObject;
}

function optionalObject(value: unknown): JsonObject | undefined {
  return value === undefined || value === null ? undefined : object(value);
}

function positiveCapacity(value: unknown, source: MetadataSource): ModelDescriptor["contextTokens"] {
  if (value === undefined || value === null || value === 0) return { value: null, source: null };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ModelDiscoveryError("invalid_response");
  return { value, source };
}

function capability(value: unknown, source: MetadataSource): ModelDescriptor["capabilities"]["tools"] {
  return typeof value === "boolean" ? { value, evidence: "discovered", source } : { value: null, evidence: "unknown", source: null };
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.length > 128)) {
    throw new ModelDiscoveryError("invalid_response");
  }
  return value as string[];
}

function modalities(value: unknown): ModelDescriptor["inputModalities"] {
  const values = stringArray(value) ?? [];
  return [...new Set(values.filter((value): value is "text" | "image" | "audio" | "video" =>
    value === "text" || value === "image" || value === "audio" || value === "video"))];
}

function efforts(value: unknown): ReasoningOptions["efforts"] {
  const values = stringArray(value) ?? [];
  return [...new Set(values.filter((value): value is ReasoningOptions["efforts"][number] =>
    reasoningEffortSchema.safeParse(value).success))];
}

/** OpenRouter publishes selectable effort levels and their defaults on the model record. */
function openRouterReasoningOptions(value: unknown, source: MetadataSource): ReasoningOptions | null {
  const record = optionalObject(value), available = efforts(record?.supported_efforts);
  if (!available.length) return null;
  const rawDefault = record?.default_effort;
  return {
    efforts: available,
    defaultEffort: typeof rawDefault === "string" && available.includes(rawDefault as ReasoningOptions["efforts"][number])
      ? rawDefault as ReasoningOptions["efforts"][number] : null,
    defaultEnabled: typeof record?.default_enabled === "boolean" ? record.default_enabled : null,
    mandatory: record?.mandatory === true,
    supportsMaxTokens: record?.supports_max_tokens === true,
    source,
  };
}

/** OpenCode publishes selectable effort levels under capabilities.reasoning.effort. */
function openCodeReasoningOptions(value: unknown, source: MetadataSource): ReasoningOptions | null {
  const record = optionalObject(value), available = efforts(record?.effort);
  if (!available.length) return null;
  return {
    efforts: available, defaultEffort: null, defaultEnabled: null,
    mandatory: record?.toggle === false, supportsMaxTokens: false, source,
  };
}

/** OpenRouter prices are decimal USD/token strings; scale exactly to micro-USD/million tokens. */
export function usdPerTokenToMicrosPerMillion(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(value);
  if (!match) return null;
  const fraction = match[2] ?? "";
  let digits = `${match[1]}${fraction}`.replace(/^0+/, "");
  if (!digits) return 0;
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent)) return null;
  const scale = 12 + exponent - fraction.length;
  if (!Number.isSafeInteger(scale)) return null;
  if (scale >= 0) {
    if (digits.length + scale > 16) return null;
    digits += "0".repeat(scale);
  } else {
    const remove = -scale;
    if (remove >= digits.length || !digits.endsWith("0".repeat(Math.min(remove, digits.length)))) return null;
    digits = digits.slice(0, -remove);
  }
  if (digits.length > 16) return null;
  const integer = BigInt(digits);
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : null;
}

/** OpenCode publishes USD per million tokens as numbers, not per-token strings. */
export function usdPerMillionToMicros(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const micros = Math.round(value * 1_000_000);
  return Number.isSafeInteger(micros) ? micros : null;
}

function openRouterModel(record: JsonObject, model: ModelDescriptor, source: MetadataSource): void {
  const top = optionalObject(record.top_provider);
  model.contextTokens = positiveCapacity(record.context_length, source);
  const topContext = positiveCapacity(top?.context_length, source);
  if (topContext.value !== null && (model.contextTokens.value === null || topContext.value < model.contextTokens.value)) {
    model.contextTokens = topContext;
  }
  model.maxOutputTokens = positiveCapacity(top?.max_completion_tokens, source);
  const parameters = stringArray(record.supported_parameters);
  model.capabilities = {
    tools: capability(parameters === undefined ? undefined : parameters.includes("tools"), source),
    reasoning: capability(parameters === undefined ? undefined : parameters.includes("reasoning") || parameters.includes("reasoning_effort"), source),
    structuredOutput: capability(parameters === undefined ? undefined : parameters.includes("structured_outputs"), source),
  };
  model.reasoningOptions = openRouterReasoningOptions(record.reasoning, source);
  if (model.reasoningOptions) model.capabilities.reasoning = capability(true, source);
  const architecture = optionalObject(record.architecture);
  model.inputModalities = modalities(architecture?.input_modalities);
  model.outputModalities = modalities(architecture?.output_modalities);
  const pricing = optionalObject(record.pricing);
  if (pricing) {
    const normalized = {
      currency: "USD" as const,
      inputMicrosPerMillionTokens: usdPerTokenToMicrosPerMillion(pricing.prompt),
      outputMicrosPerMillionTokens: usdPerTokenToMicrosPerMillion(pricing.completion),
      cachedInputMicrosPerMillionTokens: usdPerTokenToMicrosPerMillion(pricing.input_cache_read),
      cacheWriteMicrosPerMillionTokens: usdPerTokenToMicrosPerMillion(pricing.input_cache_write),
      source,
    };
    model.pricing = { ...normalized, revision: requestDigest(normalized) };
  }
}

function opencodeModel(record: JsonObject, model: ModelDescriptor, source: MetadataSource): void {
  const limit = optionalObject(record.limit);
  model.contextTokens = positiveCapacity(limit?.context, source);
  model.maxInputTokens = positiveCapacity(limit?.input, source);
  model.maxOutputTokens = positiveCapacity(limit?.output, source);
  const capabilities = optionalObject(record.capabilities);
  const tools = optionalObject(capabilities?.tools);
  const toolChoice = Array.isArray(tools?.choice) ? tools.choice : undefined;
  const reasoning = optionalObject(capabilities?.reasoning);
  model.capabilities = {
    tools: capability(typeof tools?.supported === "boolean" ? tools.supported : toolChoice?.length ? true : undefined, source),
    reasoning: capability(reasoning?.supported, source),
    structuredOutput: capability(capabilities?.structured_output, source),
  };
  model.reasoningOptions = openCodeReasoningOptions(reasoning, source);
  if (model.reasoningOptions) model.capabilities.reasoning = capability(true, source);
  const modalitiesRecord = optionalObject(record.modalities);
  model.inputModalities = modalities(modalitiesRecord?.input);
  model.outputModalities = modalities(modalitiesRecord?.output);
  const text = optionalObject(optionalObject(record.cost)?.text);
  if (text) {
    const input = optionalObject(text.input);
    const output = optionalObject(text.output);
    const normalized = {
      currency: "USD" as const,
      inputMicrosPerMillionTokens: usdPerMillionToMicros(input?.price),
      outputMicrosPerMillionTokens: usdPerMillionToMicros(output?.price),
      cachedInputMicrosPerMillionTokens: usdPerMillionToMicros(optionalObject(input?.cache)?.read),
      cacheWriteMicrosPerMillionTokens: usdPerMillionToMicros(optionalObject(input?.cache)?.write),
      source,
    };
    model.pricing = { ...normalized, revision: requestDigest(normalized) };
  }
}

function nativeModel(record: JsonObject, model: ModelDescriptor, source: MetadataSource): void {
  if (model.protocol === "google_generate_content") {
    model.maxInputTokens = positiveCapacity(record.inputTokenLimit, source);
    model.maxOutputTokens = positiveCapacity(record.outputTokenLimit, source);
    model.capabilities.reasoning = capability(record.thinking, source);
  } else if (model.protocol === "anthropic_messages") {
    model.maxInputTokens = positiveCapacity(record.max_input_tokens, source);
    model.maxOutputTokens = positiveCapacity(record.max_tokens, source);
    const capabilities = optionalObject(record.capabilities);
    model.capabilities.reasoning = capability(optionalObject(capabilities?.thinking)?.supported, source);
    model.capabilities.structuredOutput = capability(optionalObject(capabilities?.structured_outputs)?.supported, source);
  }
}

function normalizeModel(record: JsonObject, provider: ProviderDefinition, source: MetadataSource): ModelDescriptor {
  const nativeGoogle = provider.protocol === "google_generate_content";
  const rawId = nativeGoogle ? record.name : record.id;
  if (typeof rawId !== "string" || rawId.length === 0) throw new ModelDiscoveryError("invalid_response");
  const id = nativeGoogle ? rawId.replace(/^models\//, "") : rawId;
  const display = nativeGoogle ? record.displayName : provider.protocol === "anthropic_messages" ? record.display_name : record.name;
  if (display !== undefined && (typeof display !== "string" || /[\u0000-\u001f\u007f]/.test(display))) {
    throw new ModelDiscoveryError("invalid_response");
  }
  const lifecycle = record.lifecycle;
  const model: ModelDescriptor = {
    id, providerId: provider.id, name: typeof display === "string" ? display : id.slice(0, 256), protocol: provider.protocol,
    revision: "pending",
    contextTokens: { value: null, source: null }, maxInputTokens: { value: null, source: null }, maxOutputTokens: { value: null, source: null },
    capabilities: { tools: capability(undefined, source), reasoning: capability(undefined, source), structuredOutput: capability(undefined, source) },
    reasoningOptions: null,
    inputModalities: [], outputModalities: [], pricing: null,
    lifecycle: lifecycle === "active" || lifecycle === "deprecated" || lifecycle === "retired" ? lifecycle : "unknown",
  };
  if (provider.id === "openrouter") openRouterModel(record, model, source);
  else if (provider.id === "opencode") opencodeModel(record, model, source);
  else nativeModel(record, model, source);
  model.revision = requestDigest(model);
  return modelDescriptorSchema.parse(model);
}

export async function discoverProviderModels(provider: ProviderDefinition, options: ModelDiscoveryOptions): Promise<ModelDiscoveryResult> {
  let configured: ProviderDefinition;
  try {
    configured = providerDefinitionSchema.parse(provider);
    const { fetch: _fetch, ...settings } = options;
    optionsSchema.parse(settings);
    if (typeof options.fetch !== "function") throw new Error("Missing discovery transport");
  } catch {
    throw new ModelDiscoveryError("invalid_configuration");
  }
  if (configured.discovery.kind === "curated") return { kind: "manual_required", models: [], observedAt: options.observedAt };
  let url: string;
  try {
    const base = new URL(options.endpoint);
    url = modelEndpointSchema.parse(`${base.href.replace(/\/+$/, "")}${configured.discovery.path}`);
    if (new URL(url).origin !== base.origin) throw new Error("Discovery origin changed");
  } catch {
    throw new ModelDiscoveryError("invalid_configuration");
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (configured.auth.kind === "bearer") headers.Authorization = `Bearer ${options.apiKey}`;
  else headers[configured.auth.headerName] = options.apiKey;
  if (configured.protocol === "anthropic_messages") headers["anthropic-version"] = "2023-06-01";
  let response: { status: number; body: string };
  try {
    response = await options.fetch({ url, method: "GET", headers: Object.freeze(headers), redirect: "error", maxResponseBytes: options.maxResponseBytes });
  } catch {
    throw new ModelDiscoveryError("network_failed");
  }
  if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599 || typeof response.body !== "string") {
    throw new ModelDiscoveryError("invalid_response");
  }
  const status = response.status;
  if (status < 200 || status >= 300) {
    const code: ModelDiscoveryErrorCode = status >= 300 && status < 400 ? "redirect_rejected" :
      status === 401 ? "authentication_rejected" : status === 403 ? "access_denied" :
        status === 429 ? "rate_limited" : status >= 500 ? "unavailable" : "http_rejected";
    throw new ModelDiscoveryError(code, status);
  }
  if (Buffer.byteLength(response.body, "utf8") > options.maxResponseBytes) throw new ModelDiscoveryError("response_too_large");
  try {
    const envelope = object(JSON.parse(response.body));
    if (envelope.has_more !== undefined && typeof envelope.has_more !== "boolean" ||
      envelope.nextPageToken !== undefined && typeof envelope.nextPageToken !== "string") {
      throw new ModelDiscoveryError("invalid_response");
    }
    const rawModels = configured.protocol === "google_generate_content" ? envelope.models : envelope.data;
    if (!Array.isArray(rawModels)) throw new ModelDiscoveryError("invalid_response");
    if (rawModels.length > options.maxModels) throw new ModelDiscoveryError("catalogue_limit_exceeded");
    const source: MetadataSource = { kind: "discovery", reference: url, observedAt: options.observedAt };
    const models: ModelDescriptor[] = [];
    const ids = new Set<string>();
    for (const raw of rawModels) {
      const record = object(raw);
      if (configured.protocol === "google_generate_content") {
        const methods = stringArray(record.supportedGenerationMethods);
        if (methods && !methods.includes("generateContent")) continue;
      }
      const model = normalizeModel(record, configured, source);
      if (ids.has(model.id)) throw new ModelDiscoveryError("invalid_response");
      ids.add(model.id);
      models.push(model);
    }
    const result: ModelDiscoveryResult = {
      kind: "discovered", visibility: configured.id === "openrouter" || configured.id === "opencode" ? "public_catalog" : "credential_scoped", models,
      observedAt: options.observedAt, complete: envelope.has_more !== true && !envelope.nextPageToken,
    };
    if (JSON.stringify(result).includes(options.apiKey)) throw new ModelDiscoveryError("invalid_response");
    return result;
  } catch (error) {
    if (error instanceof ModelDiscoveryError) throw error;
    throw new ModelDiscoveryError("invalid_response");
  }
}
