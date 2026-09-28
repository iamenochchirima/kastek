export type ModelCapabilitySource =
  | "provider_metadata"
  | "catalog"
  | "configured_override"
  | "provider_error_correction"
  | "unknown";

/** Sources that are safe to resolve from a static catalog/metadata layer. */
export type StaticModelCapabilitySource = "provider_metadata" | "catalog";

export interface ModelCapabilityRoute {
  readonly provider: string;
  readonly endpointId: string;
  readonly credentialRouteId: string;
  readonly model: string;
  readonly runtimeEnvironment: string;
}

/** Untrusted metadata supplied by a provider adapter or a static catalog. */
export interface ModelCapabilityCatalogEntry extends ModelCapabilityRoute {
  readonly contextWindowTokens?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly source: unknown;
  readonly resolvedAt: unknown;
  readonly expiresAt?: unknown;
}

export interface ModelCapabilityRecord extends ModelCapabilityRoute {
  readonly key: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly source: ModelCapabilitySource;
  readonly resolvedAt: string;
  readonly expiresAt?: string;
}

export type ModelCapabilityCatalog = ReadonlyMap<string, ModelCapabilityRecord>;

const CAPABILITY_SOURCES = new Set<ModelCapabilitySource>([
  "provider_metadata",
  "catalog",
  "configured_override",
  "provider_error_correction",
  "unknown",
]);

const STATIC_CAPABILITY_SOURCES = new Set<StaticModelCapabilitySource>([
  "provider_metadata",
  "catalog",
]);

const CAPABILITY_SOURCE_PRIORITY: Record<StaticModelCapabilitySource, number> = {
  provider_metadata: 2,
  catalog: 1,
};

export function isStaticModelCapabilitySource(source: ModelCapabilitySource): source is StaticModelCapabilitySource {
  return STATIC_CAPABILITY_SOURCES.has(source as StaticModelCapabilitySource);
}

function normalizedIdentifier(value: string): string | undefined {
  const normalized = value.trim();
  return normalized || undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

export function modelCapabilityKey(route: ModelCapabilityRoute): string {
  const provider = normalizedIdentifier(route.provider);
  const endpointId = normalizedIdentifier(route.endpointId);
  const credentialRouteId = normalizedIdentifier(route.credentialRouteId);
  const model = normalizedIdentifier(route.model);
  const runtimeEnvironment = normalizedIdentifier(route.runtimeEnvironment);
  if (!provider || !endpointId || !credentialRouteId || !model || !runtimeEnvironment) {
    throw new Error("Model capability route identifiers must be non-empty");
  }
  return JSON.stringify([provider, endpointId, credentialRouteId, model, runtimeEnvironment]);
}

/**
 * Converts one explicit metadata entry into a route-bound capability record.
 * Invalid or internally inconsistent metadata is rejected instead of guessed.
 */
export function normalizeModelCapabilityEntry(entry: ModelCapabilityCatalogEntry): ModelCapabilityRecord | undefined {
  const provider = normalizedIdentifier(entry.provider);
  const endpointId = normalizedIdentifier(entry.endpointId);
  const credentialRouteId = normalizedIdentifier(entry.credentialRouteId);
  const model = normalizedIdentifier(entry.model);
  const runtimeEnvironment = normalizedIdentifier(entry.runtimeEnvironment);
  if (!provider || !endpointId || !credentialRouteId || !model || !runtimeEnvironment) return undefined;

  const contextWindowTokens = positiveInteger(entry.contextWindowTokens);
  const maxOutputTokens = positiveInteger(entry.maxOutputTokens);
  if (entry.contextWindowTokens !== undefined && contextWindowTokens === undefined) return undefined;
  if (entry.maxOutputTokens !== undefined && maxOutputTokens === undefined) return undefined;
  if (contextWindowTokens === undefined && maxOutputTokens === undefined) return undefined;

  if (typeof entry.source !== "string" || !CAPABILITY_SOURCES.has(entry.source as ModelCapabilitySource)) return undefined;
  const source = entry.source as ModelCapabilitySource;
  if (source === "unknown") return undefined;

  const resolvedAt = isoTimestamp(entry.resolvedAt);
  if (!resolvedAt) return undefined;
  const expiresAt = entry.expiresAt === undefined ? undefined : isoTimestamp(entry.expiresAt);
  if (entry.expiresAt !== undefined && !expiresAt) return undefined;
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(resolvedAt)) return undefined;

  const route = { provider, endpointId, credentialRouteId, model, runtimeEnvironment };
  return {
    ...route,
    key: modelCapabilityKey(route),
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    source,
    resolvedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/** Builds an exact-key catalog. Newer metadata wins when a route appears twice. */
export function createModelCapabilityCatalog(entries: readonly ModelCapabilityCatalogEntry[]): ModelCapabilityCatalog {
  const catalog = new Map<string, ModelCapabilityRecord>();
  for (const entry of entries) {
    const normalized = normalizeModelCapabilityEntry(entry);
    if (!normalized || !isStaticModelCapabilitySource(normalized.source)) continue;
    const current = catalog.get(normalized.key);
    if (!current || isNewerCapability(normalized, current)) {
      catalog.set(normalized.key, normalized);
    }
  }
  return catalog;
}

/** Returns only an exact, unexpired route match. */
export function resolveModelCapabilityFromCatalog(
  catalog: ModelCapabilityCatalog,
  route: ModelCapabilityRoute,
  at: string,
): ModelCapabilityRecord | undefined {
  const atTimestamp = Date.parse(at);
  if (!Number.isFinite(atTimestamp)) throw new Error("Capability resolution time must be a valid timestamp");
  const key = modelCapabilityKey(route);
  const record = catalog.get(key);
  if (!record) return undefined;

  // Catalogs are normally created through createModelCapabilityCatalog, but
  // the map is a public contract and can also be restored from a durable or
  // test boundary. Re-normalize that boundary so a key cannot point at a
  // record for a different route or carry untrusted numbers/timestamps.
  const normalized = normalizeModelCapabilityEntry(record);
  if (!normalized || normalized.key !== key || !isStaticModelCapabilitySource(normalized.source)) return undefined;
  if (normalized.expiresAt && Date.parse(normalized.expiresAt) <= atTimestamp) return undefined;
  return normalized;
}

function isNewerCapability(candidate: ModelCapabilityRecord, current: ModelCapabilityRecord): boolean {
  const candidateTime = Date.parse(candidate.resolvedAt);
  const currentTime = Date.parse(current.resolvedAt);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  return CAPABILITY_SOURCE_PRIORITY[candidate.source as StaticModelCapabilitySource] > CAPABILITY_SOURCE_PRIORITY[current.source as StaticModelCapabilitySource];
}
