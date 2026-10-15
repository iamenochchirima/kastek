import { describe, expect, it } from "vitest";
import {
  createModelCapabilityCatalog,
  modelCapabilityKey,
  normalizeModelCapabilityEntry,
  resolveModelCapabilityFromCatalog,
  type ModelCapabilityCatalogEntry,
  type ModelCapabilityRoute,
} from "../src/model/model-capability-catalog";

const route: ModelCapabilityRoute = {
  provider: "openrouter",
  endpointId: "https://openrouter.ai/api/v1",
  credentialRouteId: "workspace-default",
  model: "vendor/model",
  runtimeEnvironment: "playground",
};

function entry(overrides: Partial<ModelCapabilityCatalogEntry> = {}): ModelCapabilityCatalogEntry {
  return {
    ...route,
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_000,
    source: "provider_metadata",
    resolvedAt: "2026-09-07T10:00:00.000Z",
    expiresAt: "2026-09-07T11:00:00.000Z",
    ...overrides,
  };
}

describe("model capability catalog", () => {
  it("normalizes explicit metadata into a stable route-isolated record", () => {
    expect(normalizeModelCapabilityEntry(entry({
      provider: " openrouter ",
      model: " vendor/model ",
      resolvedAt: "2026-09-07T12:00:00+02:00",
    }))).toEqual({
      ...route,
      key: modelCapabilityKey(route),
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_000,
      source: "provider_metadata",
      resolvedAt: "2026-09-07T10:00:00.000Z",
      expiresAt: "2026-09-07T11:00:00.000Z",
    });
  });

  it("rejects invalid metadata while keeping context and output limits independent", () => {
    expect(normalizeModelCapabilityEntry(entry({ contextWindowTokens: 0 }))).toBeUndefined();
    expect(normalizeModelCapabilityEntry(entry({ maxOutputTokens: 128_001 }))).toMatchObject({ contextWindowTokens: 128_000, maxOutputTokens: 128_001 });
    expect(normalizeModelCapabilityEntry(entry({ endpointId: " " }))).toBeUndefined();
    expect(normalizeModelCapabilityEntry(entry({ source: "guessed" }))).toBeUndefined();
    expect(normalizeModelCapabilityEntry(entry({ source: "unknown" }))).toBeUndefined();
    expect(normalizeModelCapabilityEntry(entry({ expiresAt: "2026-09-07T09:00:00.000Z" }))).toBeUndefined();
  });

  it("keeps provider, endpoint, credential, model, and environment routes disjoint", () => {
    const catalog = createModelCapabilityCatalog([
      entry(),
      entry({ endpointId: "https://proxy.example/v1", contextWindowTokens: 64_000 }),
      entry({ credentialRouteId: "byok-1", contextWindowTokens: 32_000 }),
      entry({ runtimeEnvironment: "live", contextWindowTokens: 96_000 }),
    ]);

    expect(resolveModelCapabilityFromCatalog(catalog, route, "2026-09-07T10:30:00.000Z")?.contextWindowTokens).toBe(128_000);
    expect(resolveModelCapabilityFromCatalog(catalog, { ...route, endpointId: "https://proxy.example/v1" }, "2026-09-07T10:30:00.000Z")?.contextWindowTokens).toBe(64_000);
    expect(resolveModelCapabilityFromCatalog(catalog, { ...route, credentialRouteId: "missing" }, "2026-09-07T10:30:00.000Z")).toBeUndefined();
    expect(resolveModelCapabilityFromCatalog(catalog, { ...route, model: "other-model" }, "2026-09-07T10:30:00.000Z")).toBeUndefined();
  });

  it("excludes expired records and keeps the newest duplicate", () => {
    const catalog = createModelCapabilityCatalog([
      entry({ contextWindowTokens: 64_000, resolvedAt: "2026-09-07T09:00:00.000Z" }),
      entry({ contextWindowTokens: 128_000 }),
    ]);

    expect(resolveModelCapabilityFromCatalog(catalog, route, "2026-09-07T10:59:59.000Z")?.contextWindowTokens).toBe(128_000);
    expect(resolveModelCapabilityFromCatalog(catalog, route, "2026-09-07T11:00:00.000Z")).toBeUndefined();
  });

  it("prefers provider metadata over a catalog tie at the same observation time", () => {
    const catalog = createModelCapabilityCatalog([
      entry({ source: "catalog", contextWindowTokens: 64_000 }),
      entry({ source: "provider_metadata", contextWindowTokens: 96_000 }),
    ]);

    expect(resolveModelCapabilityFromCatalog(catalog, route, "2026-09-07T10:30:00.000Z")).toMatchObject({
      contextWindowTokens: 96_000,
      source: "provider_metadata",
    });
  });

  it("does not trust a public map whose key points at a malformed record", () => {
    const key = modelCapabilityKey(route);
    const malformed = {
      ...entry(),
      key,
      model: "other-model",
    };

    expect(resolveModelCapabilityFromCatalog(new Map([[key, malformed]]), route, "2026-09-07T10:30:00.000Z")).toBeUndefined();
  });
});
