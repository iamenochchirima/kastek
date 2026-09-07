import { isModelProvider, type ModelProvider } from "../model/types";
import type { ContextCapabilitySource, ProviderContextProfile } from "./context-planning";
import {
  isStaticModelCapabilitySource,
  modelCapabilityKey,
  normalizeModelCapabilityEntry,
  resolveModelCapabilityFromCatalog,
  type ModelCapabilityCatalog,
  type ModelCapabilityCatalogEntry,
  type ModelCapabilityRecord,
  type ModelCapabilityRoute,
} from "../model/model-capability-catalog";

export interface ContextCapabilityRecord {
  readonly organizationId: string;
  readonly provider: ModelProvider;
  readonly model: string;
  readonly endpointId: string;
  readonly credentialRouteId?: string;
  readonly runtimeEnvironment?: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly source: ContextCapabilitySource;
  readonly resolvedAt: string;
  readonly expiresAt?: string;
}

export interface ContextCapabilityStore {
  get(input: { organizationId: string; provider: ModelProvider; model: string; endpointId: string; credentialRouteId: string; runtimeEnvironment: string }): Promise<ContextCapabilityRecord | undefined>;
  upsert(input: ContextCapabilityRecord): Promise<void>;
}

export interface ContextCapabilityCorrection {
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

/** An override explicitly supplied for this provider attempt/route. */
export interface ExplicitContextCapabilityOverride {
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly resolvedAt?: string;
  readonly expiresAt?: string;
}

/** Provider metadata is untrusted until it passes the catalog normalizer. */
export type ContextCapabilityProviderMetadataResolver = (
  route: ModelCapabilityRoute,
) => ModelCapabilityCatalogEntry | ModelCapabilityRecord | undefined | Promise<ModelCapabilityCatalogEntry | ModelCapabilityRecord | undefined>;

export interface ContextCapabilitySourceOptions {
  /** Exact route-bound static entries. */
  readonly catalog?: ModelCapabilityCatalog;
  /** Optional provider metadata lookup. It is never consulted for an explicit override. */
  readonly providerMetadata?: ContextCapabilityProviderMetadataResolver;
}

/** The resolver may retain expiry for callers that need to inspect provenance. */
export type ResolvedContextCapabilityProfile = ProviderContextProfile & {
  readonly capabilityExpiresAt?: string;
};

/** Only accept a correction when the provider names one numeric constraint. */
export function contextCapabilityCorrectionFromProviderError(input: { code: string; message: string }): ContextCapabilityCorrection | undefined {
  const text = `${input.code} ${input.message}`;
  const contextMatch = text.match(/(?:context\s*(?:window|length)|maximum\s+context(?:\s+length)?|max(?:imum)?\s+context\s+tokens?)[^0-9]{0,48}([0-9][0-9,]*)/i);
  const outputMatch = text.match(/(?:maximum|max)\s+output\s+tokens?[^0-9]{0,48}([0-9][0-9,]*)/i);
  const contextWindowTokens = contextMatch ? Number(contextMatch[1]!.replace(/,/g, "")) : undefined;
  const maxOutputTokens = outputMatch ? Number(outputMatch[1]!.replace(/,/g, "")) : undefined;
  const validContext = contextWindowTokens !== undefined && Number.isSafeInteger(contextWindowTokens) && contextWindowTokens > 0 ? contextWindowTokens : undefined;
  const validOutput = maxOutputTokens !== undefined && Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : undefined;
  return validContext === undefined && validOutput === undefined ? undefined : {
    ...(validContext === undefined ? {} : { contextWindowTokens: validContext }),
    ...(validOutput === undefined ? {} : { maxOutputTokens: validOutput }),
  };
}

/**
 * Resolves the capability identity used by one provider attempt.
 *
 * The runtime currently receives the context window from the pinned agent
 * policy, so the value is explicitly marked as a configured override. Future
 * provider/catalog adapters can supply a stronger source without changing the
 * planner or loop interface. A fallback attempt is always re-keyed here so it
 * cannot inherit the primary model's identity by accident.
 */
export function resolveContextCapability(input: {
  profile: ProviderContextProfile;
  provider: ModelProvider;
  model: string;
  endpointId?: string;
  resolvedAt?: string;
}): ProviderContextProfile {
  const endpointId = input.endpointId
    ?? (input.profile.provider === input.provider ? input.profile.endpointId : undefined)
    ?? `${input.provider}:default`;
  const capabilitySource = input.profile.capabilitySource ?? "configured_override";
  return {
    ...input.profile,
    provider: input.provider,
    model: input.model,
    endpointId,
    ...(capabilitySource === "unknown" ? { contextWindowTokens: 0, maxOutputTokens: undefined } : {}),
    capabilitySource,
    capabilityResolvedAt: input.profile.capabilityResolvedAt ?? input.resolvedAt ?? new Date().toISOString(),
  };
}

/**
 * Adds a durable, tenant-scoped cache around the attempt resolver. The
 * configured profile remains the safe fallback, while provider metadata or an
 * evidence-backed correction wins when it is still valid.
 */
export class DurableContextCapabilityResolver {
  private readonly cache = new Map<string, { record: ContextCapabilityRecord; expiresAt: number }>();

  public constructor(
    private readonly store: ContextCapabilityStore,
    private readonly cacheTtlMs = 60_000,
    private readonly sources: ContextCapabilitySourceOptions = {},
  ) {}

  public async resolve(input: {
    organizationId: string;
    profile: ProviderContextProfile;
    provider: ModelProvider;
    model: string;
    endpointId?: string;
    credentialRouteId?: string;
    runtimeEnvironment?: string;
    resolvedAt?: string;
    /** Optional explicit override for this exact provider route. */
    configuredOverride?: ExplicitContextCapabilityOverride;
    /** Per-resolution sources are useful when metadata is scoped to a run. */
    catalog?: ModelCapabilityCatalog;
    providerMetadata?: ContextCapabilityProviderMetadataResolver;
  }): Promise<ResolvedContextCapabilityProfile> {
    const fallback = resolveContextCapability(input);
    const endpointId = input.endpointId ?? fallback.endpointId ?? `${input.provider}:default`;
    const credentialRouteId = input.credentialRouteId ?? "default";
    const runtimeEnvironment = input.runtimeEnvironment ?? "development";
    const key = this.key(input.organizationId, input.provider, input.model, endpointId, credentialRouteId, runtimeEnvironment);
    const now = Date.now();
    const route: ModelCapabilityRoute = { provider: input.provider, model: input.model, endpointId, credentialRouteId, runtimeEnvironment };

    // Source order is deliberate. The current request's explicit override is
    // authoritative; static/provider metadata is next; durable evidence is
    // only used when neither of those sources can establish this route.
    const explicitCandidate = input.configuredOverride ?? configuredOverrideFromProfile(input.profile, route);
    const explicit = normalizeExplicitContextCapabilityOverride(explicitCandidate, now);
    if (explicit) {
      return applyCapability(fallback, route, explicit, "configured_override");
    }

    const providerMetadata = input.providerMetadata ?? this.sources.providerMetadata;
    const catalog = input.catalog ?? this.sources.catalog;
    const metadataRecord = await resolveProviderMetadata(providerMetadata, route, now);
    if (metadataRecord) return applyCapabilityRecord(fallback, metadataRecord);

    const catalogRecord = catalog
      ? resolveModelCapabilityFromCatalog(catalog, route, new Date(now).toISOString())
      : undefined;
    if (catalogRecord) return applyCapabilityRecord(fallback, catalogRecord);

    const cached = this.cache.get(key);
    const cachedRecord = cached && cached.expiresAt > now && isCapabilityRecordFresh(cached.record, now)
      ? cached.record
      : undefined;
    if (!cachedRecord && cached) this.cache.delete(key);
    let record = cachedRecord
      ? normalizeDurableCapabilityRecord(cachedRecord, input.organizationId, route)
      : undefined;
    if (!record) {
      const stored = await this.store.get({ organizationId: input.organizationId, provider: input.provider, model: input.model, endpointId, credentialRouteId, runtimeEnvironment });
      record = stored ? normalizeDurableCapabilityRecord(stored, input.organizationId, route) : undefined;
    }
    if (record && isCapabilityRecordFresh(record, now) && record.source !== "configured_override" && record.source !== "unknown" && hasCapabilityValue(record)) {
      // Keep lower-tier corrections read-through so a newly confirmed
      // metadata/catalog record cannot be hidden behind a stale correction.
      if (record.source === "provider_error_correction") this.cache.delete(key);
      else this.cache.set(key, { record, expiresAt: now + this.cacheTtlMs });
      return applyCapabilityRecord(fallback, record);
    }
    if (record && !isCapabilityRecordFresh(record, now)) this.cache.delete(key);
    return fallback.capabilitySource === "unknown" ? unknownCapability(fallback) : fallback;
  }

  /** Record a configured fallback without overwriting stronger evidence. */
  public async rememberConfigured(input: {
    organizationId: string;
    profile: ProviderContextProfile;
    credentialRouteId?: string;
    runtimeEnvironment?: string;
  }): Promise<void> {
    const provider = input.profile.provider as ModelProvider;
    const model = input.profile.model;
    const endpointId = input.profile.endpointId ?? `${provider}:default`;
    const credentialRouteId = input.credentialRouteId ?? "default";
    const runtimeEnvironment = input.runtimeEnvironment ?? "development";
    const route: ModelCapabilityRoute = { provider, model, endpointId, credentialRouteId, runtimeEnvironment };
    const stored = await this.store.get({ organizationId: input.organizationId, provider, model, endpointId, credentialRouteId, runtimeEnvironment });
    const existing = stored ? normalizeDurableCapabilityRecord(stored, input.organizationId, route) : undefined;
    if (existing && isCapabilityRecordFresh(existing) && existing.source !== "configured_override") return;
    const record = createCapabilityRecord({
      organizationId: input.organizationId,
      provider,
      model,
      endpointId,
      credentialRouteId,
      runtimeEnvironment,
      contextWindowTokens: input.profile.contextWindowTokens,
      ...(input.profile.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.profile.maxOutputTokens }),
      source: "configured_override",
      resolvedAt: input.profile.capabilityResolvedAt ?? new Date().toISOString(),
    });
    await this.store.upsert(record);
    this.cache.set(this.key(input.organizationId, provider, model, endpointId, credentialRouteId, runtimeEnvironment), { record, expiresAt: Date.now() + this.cacheTtlMs });
  }

  public async recordCorrection(input: {
    organizationId: string;
    profile: ProviderContextProfile;
    correction: ContextCapabilityCorrection;
    credentialRouteId?: string;
    runtimeEnvironment?: string;
    resolvedAt?: string;
  }): Promise<void> {
    if (!hasCapabilityValue(input.correction)) throw new Error("CONTEXT_CAPABILITY_CORRECTION_INVALID");
    const provider = input.profile.provider as ModelProvider;
    const model = input.profile.model;
    const endpointId = input.profile.endpointId ?? `${provider}:default`;
    const credentialRouteId = input.credentialRouteId ?? "default";
    const runtimeEnvironment = input.runtimeEnvironment ?? "development";
    const record = createCapabilityRecord({
      organizationId: input.organizationId,
      provider,
      model,
      endpointId,
      credentialRouteId,
      runtimeEnvironment,
      contextWindowTokens: input.correction.contextWindowTokens ?? input.profile.contextWindowTokens,
      ...(input.correction.maxOutputTokens === undefined
        ? (input.profile.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.profile.maxOutputTokens })
        : { maxOutputTokens: input.correction.maxOutputTokens }),
      source: "provider_error_correction",
      resolvedAt: input.resolvedAt ?? new Date().toISOString(),
    });
    await this.store.upsert(record);
    this.cache.set(this.key(input.organizationId, provider, model, endpointId, credentialRouteId, runtimeEnvironment), { record, expiresAt: Date.now() + this.cacheTtlMs });
  }

  private key(organizationId: string, provider: ModelProvider, model: string, endpointId: string, credentialRouteId: string, runtimeEnvironment: string): string {
    return `${organizationId}:${modelCapabilityKey({ provider, endpointId, credentialRouteId, model, runtimeEnvironment })}`;
  }
}

function configuredOverrideFromProfile(profile: ProviderContextProfile, route: ModelCapabilityRoute): ExplicitContextCapabilityOverride | undefined {
  // A profile with an explicit non-configured provenance is evidence supplied
  // by another resolver, not a new override. Profiles without provenance are
  // retained as a legacy fallback, but are not allowed to outrank metadata or
  // durable correction evidence.
  if (profile.capabilitySource !== "configured_override") return undefined;
  if (profile.provider !== route.provider || profile.model !== route.model) return undefined;
  if (profile.endpointId !== undefined && profile.endpointId !== route.endpointId) return undefined;
  if (!hasCapabilityValue(profile)) return undefined;
  const resolvedProfile = profile as ResolvedContextCapabilityProfile;
  return {
    contextWindowTokens: profile.contextWindowTokens,
    ...(profile.maxOutputTokens === undefined ? {} : { maxOutputTokens: profile.maxOutputTokens }),
    ...(profile.capabilityResolvedAt === undefined ? {} : { resolvedAt: profile.capabilityResolvedAt }),
    ...(resolvedProfile.capabilityExpiresAt === undefined ? {} : { expiresAt: resolvedProfile.capabilityExpiresAt }),
  };
}

function hasCapabilityValue(value: { contextWindowTokens?: number; maxOutputTokens?: number }): boolean {
  return isPositiveInteger(value.contextWindowTokens) || isPositiveInteger(value.maxOutputTokens);
}

function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function normalizeExplicitContextCapabilityOverride(
  override: ExplicitContextCapabilityOverride | undefined,
  now: number,
): ExplicitContextCapabilityOverride | undefined {
  if (!override) return undefined;
  if (override.contextWindowTokens !== undefined && !isPositiveInteger(override.contextWindowTokens)) return undefined;
  if (override.maxOutputTokens !== undefined && !isPositiveInteger(override.maxOutputTokens)) return undefined;
  if (!hasCapabilityValue(override)) return undefined;

  const resolvedAt = override.resolvedAt === undefined ? undefined : normalizedTimestamp(override.resolvedAt);
  if (override.resolvedAt !== undefined && !resolvedAt) return undefined;
  const expiresAt = override.expiresAt === undefined ? undefined : normalizedTimestamp(override.expiresAt);
  if (override.expiresAt !== undefined && !expiresAt) return undefined;
  if (expiresAt && Date.parse(expiresAt) <= now) return undefined;
  if (resolvedAt && expiresAt && Date.parse(expiresAt) <= Date.parse(resolvedAt)) return undefined;

  return {
    ...(override.contextWindowTokens === undefined ? {} : { contextWindowTokens: override.contextWindowTokens }),
    ...(override.maxOutputTokens === undefined ? {} : { maxOutputTokens: override.maxOutputTokens }),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function normalizedTimestamp(value: string): string | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function createCapabilityRecord(input: {
  organizationId: string;
  provider: ModelProvider;
  model: string;
  endpointId: string;
  credentialRouteId: string;
  runtimeEnvironment: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  source: Exclude<ContextCapabilitySource, "unknown">;
  resolvedAt: string;
  expiresAt?: string;
}): ContextCapabilityRecord {
  if (!input.organizationId.trim()) throw new Error("CONTEXT_CAPABILITY_ORGANIZATION_ID_REQUIRED");
  const normalized = normalizeModelCapabilityEntry({
    provider: input.provider,
    model: input.model,
    endpointId: input.endpointId,
    credentialRouteId: input.credentialRouteId,
    runtimeEnvironment: input.runtimeEnvironment,
    contextWindowTokens: input.contextWindowTokens,
    maxOutputTokens: input.maxOutputTokens,
    source: input.source,
    resolvedAt: input.resolvedAt,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  });
  if (!normalized || !isModelProvider(normalized.provider)) throw new Error("CONTEXT_CAPABILITY_RECORD_INVALID");
  return { organizationId: input.organizationId, ...normalized, provider: normalized.provider };
}

function normalizeDurableCapabilityRecord(
  record: ContextCapabilityRecord,
  organizationId: string,
  route: ModelCapabilityRoute,
): ContextCapabilityRecord | undefined {
  if (record.organizationId !== organizationId) return undefined;
  const normalized = normalizeModelCapabilityEntry({
    provider: record.provider,
    model: record.model,
    endpointId: record.endpointId,
    credentialRouteId: record.credentialRouteId ?? "default",
    runtimeEnvironment: record.runtimeEnvironment ?? "development",
    contextWindowTokens: record.contextWindowTokens,
    maxOutputTokens: record.maxOutputTokens,
    source: record.source,
    resolvedAt: record.resolvedAt,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
  });
  if (!normalized || !isModelProvider(normalized.provider) || modelCapabilityKey(normalized) !== modelCapabilityKey(route)) return undefined;
  return { organizationId, ...normalized, provider: normalized.provider };
}

async function resolveProviderMetadata(
  resolver: ContextCapabilityProviderMetadataResolver | undefined,
  route: ModelCapabilityRoute,
  now: number,
): Promise<ModelCapabilityRecord | undefined> {
  if (!resolver) return undefined;
  try {
    const candidate = await resolver(route);
    if (!candidate) return undefined;
    const normalized = normalizeModelCapabilityEntry({
      provider: candidate.provider,
      endpointId: candidate.endpointId,
      credentialRouteId: candidate.credentialRouteId,
      model: candidate.model,
      runtimeEnvironment: candidate.runtimeEnvironment,
      contextWindowTokens: candidate.contextWindowTokens,
      maxOutputTokens: candidate.maxOutputTokens,
      // Provider metadata is classified by the boundary, never trusted from
      // an adapter-provided source label.
      source: "provider_metadata",
      resolvedAt: candidate.resolvedAt,
      ...(candidate.expiresAt === undefined ? {} : { expiresAt: candidate.expiresAt }),
    });
    if (!normalized || !isStaticModelCapabilitySource(normalized.source)) return undefined;
    if (modelCapabilityKey(normalized) !== modelCapabilityKey(route)) return undefined;
    if (normalized.expiresAt && Date.parse(normalized.expiresAt) <= now) return undefined;
    return normalized;
  } catch {
    // Metadata is an optional optimization. A malformed or unavailable
    // provider source must fall through to the durable evidence/unknown path.
    return undefined;
  }
}

function applyCapabilityRecord(profile: ProviderContextProfile, record: ModelCapabilityRecord | ContextCapabilityRecord): ResolvedContextCapabilityProfile {
  return {
    ...profile,
    provider: record.provider as ModelProvider,
    model: record.model,
    endpointId: record.endpointId,
    ...(record.contextWindowTokens === undefined ? {} : { contextWindowTokens: record.contextWindowTokens }),
    ...(record.maxOutputTokens === undefined ? {} : { maxOutputTokens: record.maxOutputTokens }),
    capabilitySource: record.source,
    capabilityResolvedAt: record.resolvedAt,
    capabilityExpiresAt: record.expiresAt,
  };
}

function applyCapability(
  profile: ProviderContextProfile,
  route: ModelCapabilityRoute,
  capability: ExplicitContextCapabilityOverride,
  source: ContextCapabilitySource,
): ResolvedContextCapabilityProfile {
  return {
    ...profile,
    provider: route.provider as ModelProvider,
    model: route.model,
    endpointId: route.endpointId,
    ...(capability.contextWindowTokens === undefined ? {} : { contextWindowTokens: capability.contextWindowTokens }),
    ...(capability.maxOutputTokens === undefined ? {} : { maxOutputTokens: capability.maxOutputTokens }),
    capabilitySource: source,
    ...(capability.resolvedAt === undefined ? {} : { capabilityResolvedAt: capability.resolvedAt }),
    capabilityExpiresAt: capability.expiresAt,
  };
}

function unknownCapability(profile: ProviderContextProfile): ResolvedContextCapabilityProfile {
  return {
    ...profile,
    contextWindowTokens: 0,
    maxOutputTokens: undefined,
    capabilitySource: "unknown",
    capabilityResolvedAt: undefined,
    capabilityExpiresAt: undefined,
  };
}

function isCapabilityRecordFresh(record: ContextCapabilityRecord, now = Date.now()): boolean {
  if (!record.expiresAt) return true;
  const expiresAt = Date.parse(record.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}
