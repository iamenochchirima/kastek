import { describe, expect, it, vi } from "vitest";
import { createModelCapabilityCatalog, type ModelCapabilityCatalogEntry } from "../src/model/model-capability-catalog";
import { contextCapabilityCorrectionFromProviderError, DurableContextCapabilityResolver, resolveContextCapability, type ContextCapabilityRecord, type ContextCapabilityStore } from "../src/runtime/context-capability";

function capabilityKey(input: {
  organizationId: string;
  provider: string;
  model: string;
  endpointId: string;
  credentialRouteId?: string;
  runtimeEnvironment?: string;
}): string {
  return JSON.stringify([
    input.organizationId,
    input.provider,
    input.model,
    input.endpointId,
    input.credentialRouteId ?? "default",
    input.runtimeEnvironment ?? "development",
  ]);
}

function createCapabilityStore(records: Map<string, ContextCapabilityRecord>) {
  const stats = { getCalls: 0 };
  const store: ContextCapabilityStore = {
    get: async (input) => {
      stats.getCalls += 1;
      return records.get(capabilityKey(input));
    },
    upsert: async (record) => {
      records.set(capabilityKey(record), record);
    },
  };
  return { stats, store };
}

function catalogEntry(overrides: Partial<ModelCapabilityCatalogEntry> = {}): ModelCapabilityCatalogEntry {
  return {
    provider: "openai",
    model: "primary",
    endpointId: "openai:default",
    credentialRouteId: "default",
    runtimeEnvironment: "playground",
    contextWindowTokens: 128_000,
    source: "catalog",
    resolvedAt: "2026-09-07T00:00:00.000Z",
    expiresAt: "2026-09-07T00:05:00.000Z",
    ...overrides,
  };
}

describe("context capability resolution", () => {
  it("records the configured source and rekeys a fallback model", () => {
    const resolved = resolveContextCapability({
      profile: {
        provider: "openai",
        model: "primary",
        contextWindowTokens: 16_000,
        maxOutputTokens: 2_000,
        capabilitySource: "configured_override",
      },
      provider: "anthropic",
      model: "fallback",
      resolvedAt: "2026-09-07T00:00:00.000Z",
    });

    expect(resolved).toMatchObject({
      provider: "anthropic",
      model: "fallback",
      endpointId: "anthropic:default",
      capabilitySource: "configured_override",
      capabilityResolvedAt: "2026-09-07T00:00:00.000Z",
    });
  });

  it("preserves provider-confirmed provenance", () => {
    const resolved = resolveContextCapability({
      profile: {
        provider: "openai",
        model: "gpt-test",
        contextWindowTokens: 128_000,
        capabilitySource: "provider_metadata",
        capabilityResolvedAt: "2026-09-06T23:00:00.000Z",
      },
      provider: "openai",
      model: "gpt-test",
    });

    expect(resolved.capabilitySource).toBe("provider_metadata");
    expect(resolved.capabilityResolvedAt).toBe("2026-09-06T23:00:00.000Z");
  });

  it("does not expose a positive window when the direct profile provenance is unknown", () => {
    const resolved = resolveContextCapability({
      profile: { provider: "openai", model: "gpt-test", contextWindowTokens: 128_000, capabilitySource: "unknown" },
      provider: "openai",
      model: "gpt-test",
    });

    expect(resolved).toMatchObject({ contextWindowTokens: 0, capabilitySource: "unknown" });
    expect(resolved.maxOutputTokens).toBeUndefined();
  });

  it("uses durable stronger evidence for each fallback without sharing the primary window", async () => {
    const records = new Map<string, ContextCapabilityRecord>();
    const store: ContextCapabilityStore = {
      get: async ({ organizationId, provider, model, endpointId }) => records.get(`${organizationId}:${provider}:${model}:${endpointId}`),
      upsert: async (record) => { records.set(`${record.organizationId}:${record.provider}:${record.model}:${record.endpointId}`, record); },
    };
    await store.upsert({ organizationId: "org-1", provider: "openai", model: "fallback", endpointId: "openai:default", contextWindowTokens: 128_000, source: "catalog", resolvedAt: "2026-09-07T00:00:00.000Z" });
    const resolver = new DurableContextCapabilityResolver(store);
    const resolved = await resolver.resolve({
      organizationId: "org-1",
      profile: { provider: "openai", model: "primary", contextWindowTokens: 32_000, maxOutputTokens: 2_000 },
      provider: "openai",
      model: "fallback",
    });
    expect(resolved).toMatchObject({ provider: "openai", model: "fallback", contextWindowTokens: 128_000, capabilitySource: "catalog" });
    expect(resolved).not.toHaveProperty("contextWindowTokens", 32_000);
  });

  it("does not promote a configured durable record into provider capacity implicitly", async () => {
    const configured: ContextCapabilityRecord = { organizationId: "org-1", provider: "openai", model: "primary", endpointId: "openai:default", contextWindowTokens: 32_000, source: "configured_override", resolvedAt: "2026-09-07T00:00:00.000Z" };
    const store: ContextCapabilityStore = {
      get: async () => configured,
      upsert: async () => undefined,
    };
    const resolver = new DurableContextCapabilityResolver(store);
    const resolved = await resolver.resolve({ organizationId: "org-1", profile: { provider: "openai", model: "primary", contextWindowTokens: 64_000 }, provider: "openai", model: "primary" });
    expect(resolved).toMatchObject({ contextWindowTokens: 0, capabilitySource: "unknown" });
  });

  it("accepts only explicit numeric provider capacity corrections", () => {
    expect(contextCapabilityCorrectionFromProviderError({ code: "CONTEXT_LENGTH_EXCEEDED", message: "maximum context length is 8,192 tokens" })).toEqual({ contextWindowTokens: 8192 });
    expect(contextCapabilityCorrectionFromProviderError({ code: "OUTPUT_LIMIT", message: "maximum output tokens: 4096" })).toEqual({ maxOutputTokens: 4096 });
    expect(contextCapabilityCorrectionFromProviderError({ code: "CONTEXT_LENGTH_EXCEEDED", message: "request is too large" })).toBeUndefined();
  });

  it("does not reuse expired durable evidence or synthesize a replacement capacity", async () => {
    const records = new Map<string, ContextCapabilityRecord>();
    const key = "org-1:openai:primary:openai:default";
    const expired: ContextCapabilityRecord = {
      organizationId: "org-1",
      provider: "openai",
      model: "primary",
      endpointId: "openai:default",
      contextWindowTokens: 128_000,
      source: "catalog",
      resolvedAt: "2026-09-06T00:00:00.000Z",
      expiresAt: "2026-09-06T00:00:00.000Z",
    };
    records.set(key, expired);
    const store: ContextCapabilityStore = {
      get: async () => records.get(key),
      upsert: async (record) => { records.set(key, record); },
    };
    const resolver = new DurableContextCapabilityResolver(store);
    const resolved = await resolver.resolve({
      organizationId: "org-1",
      profile: { provider: "openai", model: "primary", contextWindowTokens: 32_000 },
      provider: "openai",
      model: "primary",
    });

    expect(resolved).toMatchObject({ contextWindowTokens: 0, capabilitySource: "unknown" });
    await resolver.rememberConfigured({
      organizationId: "org-1",
      profile: { provider: "openai", model: "primary", contextWindowTokens: 32_000 },
    });
    expect(records.get(key)).toMatchObject({ contextWindowTokens: 32_000, source: "configured_override" });
  });

  it("discards an expired cached record before reading newer durable evidence", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-07T00:00:00.000Z"));
      const records = new Map<string, ContextCapabilityRecord>();
      const route = {
        organizationId: "org-1",
        provider: "openai" as const,
        model: "primary",
        endpointId: "openai:default",
        credentialRouteId: "default",
        runtimeEnvironment: "development",
      };
      records.set(capabilityKey(route), {
        ...route,
        contextWindowTokens: 128_000,
        source: "provider_metadata",
        resolvedAt: "2026-09-07T00:00:00.000Z",
        expiresAt: "2026-09-07T00:05:00.000Z",
      });
      const { stats, store } = createCapabilityStore(records);
      const resolver = new DurableContextCapabilityResolver(store, 60 * 60 * 1000);

      const initial = await resolver.resolve({
        organizationId: route.organizationId,
        profile: { provider: route.provider, model: route.model, contextWindowTokens: 32_000 },
        provider: route.provider,
        model: route.model,
      });
      expect(initial).toMatchObject({ contextWindowTokens: 128_000, capabilitySource: "provider_metadata" });

      records.set(capabilityKey(route), {
        ...route,
        contextWindowTokens: 96_000,
        source: "provider_error_correction",
        resolvedAt: "2026-09-07T00:05:01.000Z",
        expiresAt: "2026-09-07T01:00:00.000Z",
      });
      vi.setSystemTime(new Date("2026-09-07T00:05:01.000Z"));

      const refreshed = await resolver.resolve({
        organizationId: route.organizationId,
        profile: { provider: route.provider, model: route.model, contextWindowTokens: 32_000 },
        provider: route.provider,
        model: route.model,
      });
      expect(refreshed).toMatchObject({ contextWindowTokens: 96_000, capabilitySource: "provider_error_correction" });
      expect(stats.getCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers exact provider evidence over configured fallback without crossing provider or model routes", async () => {
    const records = new Map<string, ContextCapabilityRecord>();
    const route = {
      organizationId: "org-1",
      provider: "openai" as const,
      model: "primary",
      endpointId: "openai:default",
      credentialRouteId: "default",
      runtimeEnvironment: "development",
    };
    records.set(capabilityKey(route), {
      ...route,
      contextWindowTokens: 128_000,
      source: "provider_metadata",
      resolvedAt: "2026-09-07T00:00:00.000Z",
    });
    const { store } = createCapabilityStore(records);
    const resolver = new DurableContextCapabilityResolver(store);

    await resolver.rememberConfigured({
      organizationId: route.organizationId,
      profile: { provider: route.provider, model: route.model, contextWindowTokens: 32_000 },
    });

    const exactRoute = await resolver.resolve({
      organizationId: route.organizationId,
      profile: { provider: route.provider, model: route.model, contextWindowTokens: 32_000 },
      provider: route.provider,
      model: route.model,
    });
    const differentModel = await resolver.resolve({
      organizationId: route.organizationId,
      profile: { provider: route.provider, model: "other-model", contextWindowTokens: 64_000 },
      provider: route.provider,
      model: "other-model",
    });
    const differentProvider = await resolver.resolve({
      organizationId: route.organizationId,
      profile: { provider: "anthropic", model: route.model, contextWindowTokens: 48_000 },
      provider: "anthropic",
      model: route.model,
    });

    expect(exactRoute).toMatchObject({ contextWindowTokens: 128_000, capabilitySource: "provider_metadata" });
    expect(differentModel).toMatchObject({ contextWindowTokens: 0, capabilitySource: "unknown" });
    expect(differentProvider).toMatchObject({ contextWindowTokens: 0, capabilitySource: "unknown" });
    expect(records.get(capabilityKey(route))).toMatchObject({ contextWindowTokens: 128_000, source: "provider_metadata" });
  });

  it("loads provider corrections after a fresh resolver instance", async () => {
    const records = new Map<string, ContextCapabilityRecord>();
    const { stats, store } = createCapabilityStore(records);
    const profile = { provider: "openai" as const, model: "primary", contextWindowTokens: 32_000 };
    const firstResolver = new DurableContextCapabilityResolver(store);

    await firstResolver.recordCorrection({
      organizationId: "org-1",
      profile,
      correction: { contextWindowTokens: 96_000 },
      resolvedAt: "2026-09-07T00:00:00.000Z",
    });

    const secondResolver = new DurableContextCapabilityResolver(store);
    const resolvedAfterRestart = await secondResolver.resolve({
      organizationId: "org-1",
      profile,
      provider: profile.provider,
      model: profile.model,
    });

    expect(resolvedAfterRestart).toMatchObject({
      contextWindowTokens: 96_000,
      capabilitySource: "provider_error_correction",
      capabilityResolvedAt: "2026-09-07T00:00:00.000Z",
    });
    expect(stats.getCalls).toBe(1);
  });

  it("uses an explicit configured override before provider metadata, catalog, and durable evidence", async () => {
    vi.useFakeTimers();
    try {
    vi.setSystemTime(new Date("2026-09-07T00:02:00.000Z"));
    const records = new Map<string, ContextCapabilityRecord>();
    const route = {
      organizationId: "org-1",
      provider: "openai" as const,
      model: "primary",
      endpointId: "openai:default",
      credentialRouteId: "default",
      runtimeEnvironment: "playground",
    };
    records.set(capabilityKey(route), {
      ...route,
      contextWindowTokens: 64_000,
      source: "provider_error_correction",
      resolvedAt: "2026-09-07T00:00:00.000Z",
    });
    const providerMetadata = vi.fn().mockResolvedValue({
      ...catalogEntry({ contextWindowTokens: 96_000, source: "provider_metadata" }),
      runtimeEnvironment: "playground",
    });
    const resolver = new DurableContextCapabilityResolver(createCapabilityStore(records).store, 60_000, {
      catalog: createModelCapabilityCatalog([catalogEntry()]),
      providerMetadata,
    });

    const resolved = await resolver.resolve({
      organizationId: route.organizationId,
      profile: { provider: route.provider, model: route.model, contextWindowTokens: 0, capabilitySource: "unknown" },
      provider: route.provider,
      model: route.model,
      endpointId: route.endpointId,
      credentialRouteId: route.credentialRouteId,
      runtimeEnvironment: route.runtimeEnvironment,
      configuredOverride: {
        contextWindowTokens: 32_000,
        resolvedAt: "2026-09-07T00:01:00.000Z",
        expiresAt: "2026-09-08T00:04:00.000Z",
      },
    });

    expect(resolved).toMatchObject({ contextWindowTokens: 32_000, capabilitySource: "configured_override" });
    expect(providerMetadata).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers provider metadata over catalog and preserves the exact route and environment", async () => {
    vi.useFakeTimers();
    try {
    vi.setSystemTime(new Date("2026-09-07T00:02:00.000Z"));
    const { store } = createCapabilityStore(new Map());
    const providerMetadata = vi.fn().mockImplementation(async (route: { runtimeEnvironment: string }) => ({
      ...catalogEntry({ contextWindowTokens: route.runtimeEnvironment === "playground" ? 96_000 : 192_000, source: "provider_metadata", expiresAt: "2026-09-08T00:05:00.000Z" }),
      runtimeEnvironment: route.runtimeEnvironment,
    }));
    const resolver = new DurableContextCapabilityResolver(store, 60_000, {
      catalog: createModelCapabilityCatalog([catalogEntry({ contextWindowTokens: 128_000, expiresAt: "2026-09-08T00:05:00.000Z" })]),
      providerMetadata,
    });

    const playground = await resolver.resolve({
      organizationId: "org-1",
      profile: { provider: "openai", model: "primary", contextWindowTokens: 0, capabilitySource: "unknown" },
      provider: "openai",
      model: "primary",
      runtimeEnvironment: "playground",
    });
    const live = await resolver.resolve({
      organizationId: "org-1",
      profile: { provider: "openai", model: "primary", contextWindowTokens: 0, capabilitySource: "unknown" },
      provider: "openai",
      model: "primary",
      runtimeEnvironment: "live",
    });

    expect(playground).toMatchObject({ contextWindowTokens: 96_000, capabilitySource: "provider_metadata", endpointId: "openai:default" });
    expect(live).toMatchObject({ contextWindowTokens: 192_000, capabilitySource: "provider_metadata", endpointId: "openai:default" });
    expect(providerMetadata).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hydrates a lazy catalog for the exact route without inheriting another endpoint", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-07T12:00:00.000Z"));
      const { store } = createCapabilityStore(new Map());
      const catalogResolver = vi.fn().mockImplementation(async (route: { provider: string; model: string; endpointId: string; credentialRouteId: string; runtimeEnvironment: string }) => ({
        ...route,
        contextWindowTokens: 128_000,
        source: "catalog",
        resolvedAt: "2026-09-07T00:00:00.000Z",
        expiresAt: "2026-09-08T00:00:00.000Z",
      }));
      const resolver = new DurableContextCapabilityResolver(store, 60_000, { catalogResolver });

      const resolved = await resolver.resolve({
        organizationId: "org-1",
        profile: { provider: "openai", model: "primary", contextWindowTokens: 0, capabilitySource: "unknown" },
        provider: "openai",
        model: "primary",
        endpointId: "openai:default",
        credentialRouteId: "workspace-key",
        runtimeEnvironment: "playground",
      });

      expect(resolved).toMatchObject({
        contextWindowTokens: 128_000,
        capabilitySource: "catalog",
        endpointId: "openai:default",
        capabilityExpiresAt: "2026-09-08T00:00:00.000Z",
      });
      expect(catalogResolver).toHaveBeenCalledWith(expect.objectContaining({ credentialRouteId: "workspace-key", runtimeEnvironment: "playground" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses an exact unexpired catalog entry before durable correction, then falls back after expiry", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-07T00:00:00.000Z"));
      const route = {
        organizationId: "org-1",
        provider: "openai" as const,
        model: "primary",
        endpointId: "openai:default",
        credentialRouteId: "default",
        runtimeEnvironment: "playground",
      };
      const records = new Map<string, ContextCapabilityRecord>();
      records.set(capabilityKey(route), {
        ...route,
        contextWindowTokens: 64_000,
        source: "provider_error_correction",
        resolvedAt: "2026-09-06T23:00:00.000Z",
      });
      const resolver = new DurableContextCapabilityResolver(
        createCapabilityStore(records).store,
        60_000,
        { catalog: createModelCapabilityCatalog([catalogEntry()]) },
      );
      const input = {
        organizationId: route.organizationId,
        profile: { provider: route.provider, model: route.model, contextWindowTokens: 0, capabilitySource: "unknown" as const },
        provider: route.provider,
        model: route.model,
        endpointId: route.endpointId,
        credentialRouteId: route.credentialRouteId,
        runtimeEnvironment: route.runtimeEnvironment,
      };

      await expect(resolver.resolve(input)).resolves.toMatchObject({ contextWindowTokens: 128_000, capabilitySource: "catalog", capabilityExpiresAt: "2026-09-07T00:05:00.000Z" });
      vi.setSystemTime(new Date("2026-09-07T00:05:00.000Z"));
      await expect(resolver.resolve(input)).resolves.toMatchObject({ contextWindowTokens: 64_000, capabilitySource: "provider_error_correction" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects mismatched provider metadata and returns unknown when no exact source is available", async () => {
    const { store } = createCapabilityStore(new Map());
    const resolver = new DurableContextCapabilityResolver(store, 60_000, {
      providerMetadata: async () => catalogEntry({ model: "different-model", source: "provider_metadata" }),
    });

    const resolved = await resolver.resolve({
      organizationId: "org-1",
      profile: { provider: "openai", model: "primary", contextWindowTokens: 0, capabilitySource: "unknown" },
      provider: "openai",
      model: "primary",
      runtimeEnvironment: "playground",
    });

    expect(resolved).toMatchObject({ contextWindowTokens: 0, capabilitySource: "unknown" });
  });

  it("fails closed when a profile explicitly marks its positive window as unknown", async () => {
    const { store } = createCapabilityStore(new Map());
    const resolver = new DurableContextCapabilityResolver(store);

    const resolved = await resolver.resolve({
      organizationId: "org-1",
      profile: { provider: "openai", model: "primary", contextWindowTokens: 32_000, capabilitySource: "unknown" },
      provider: "openai",
      model: "primary",
    });

    expect(resolved).toMatchObject({ contextWindowTokens: 0, capabilitySource: "unknown" });
    expect(resolved.maxOutputTokens).toBeUndefined();
  });

  it("does not let a cached correction hide newer durable metadata", async () => {
    const route = {
      organizationId: "org-1",
      provider: "openai" as const,
      model: "primary",
      endpointId: "openai:default",
      credentialRouteId: "default",
      runtimeEnvironment: "playground",
    };
    const records = new Map<string, ContextCapabilityRecord>([[capabilityKey(route), {
      ...route,
      contextWindowTokens: 64_000,
      source: "provider_error_correction",
      resolvedAt: "2026-09-07T00:00:00.000Z",
    }]]);
    const { store } = createCapabilityStore(records);
    const resolver = new DurableContextCapabilityResolver(store, 60 * 60 * 1000);
    const input = {
      organizationId: route.organizationId,
      profile: { provider: route.provider, model: route.model, contextWindowTokens: 0, capabilitySource: "unknown" as const },
      provider: route.provider,
      model: route.model,
      endpointId: route.endpointId,
      credentialRouteId: route.credentialRouteId,
      runtimeEnvironment: route.runtimeEnvironment,
    };

    await expect(resolver.resolve(input)).resolves.toMatchObject({ contextWindowTokens: 64_000, capabilitySource: "provider_error_correction" });
    records.set(capabilityKey(route), {
      ...route,
      contextWindowTokens: 128_000,
      source: "provider_metadata",
      resolvedAt: "2026-09-07T00:01:00.000Z",
    });

    await expect(resolver.resolve(input)).resolves.toMatchObject({ contextWindowTokens: 128_000, capabilitySource: "provider_metadata" });
  });

  it("does not let malformed explicit capacity poison an otherwise valid provider source", async () => {
    const { store } = createCapabilityStore(new Map());
    const providerMetadata = vi.fn().mockResolvedValue(catalogEntry({ contextWindowTokens: 96_000, source: "provider_metadata", expiresAt: "2026-09-10T00:00:00.000Z" }));
    const resolver = new DurableContextCapabilityResolver(store, 60_000, { providerMetadata });

    const resolved = await resolver.resolve({
      organizationId: "org-1",
      profile: { provider: "openai", model: "primary", contextWindowTokens: 32_000, capabilitySource: "unknown" },
      provider: "openai",
      model: "primary",
      runtimeEnvironment: "playground",
      configuredOverride: { contextWindowTokens: -1, resolvedAt: "not-a-timestamp" },
    });

    expect(resolved).toMatchObject({ contextWindowTokens: 96_000, capabilitySource: "provider_metadata" });
    expect(providerMetadata).toHaveBeenCalledOnce();
  });

  it("rejects a direct correction with no positive capacity instead of poisoning the durable cache", async () => {
    const records = new Map<string, ContextCapabilityRecord>();
    const { store } = createCapabilityStore(records);
    const resolver = new DurableContextCapabilityResolver(store);

    await expect(resolver.recordCorrection({
      organizationId: "org-1",
      profile: { provider: "openai", model: "primary", contextWindowTokens: 32_000 },
      correction: { contextWindowTokens: 0, maxOutputTokens: -1 },
    })).rejects.toThrow("CONTEXT_CAPABILITY_CORRECTION_INVALID");
    expect(records.size).toBe(0);
  });
});
