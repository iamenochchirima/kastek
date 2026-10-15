import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import { MODEL_PROVIDER_DEFINITIONS } from "../src/model/providers";
import { MODEL_PROVIDERS, type ModelProvider } from "../src/model/types";
import { clearKasiAiModelCatalogCacheForTests, getKasiAiModelCatalog, getProviderKasiAiModelCatalog, isAllowedKasiAiModel } from "../src/system/kasiai-models";

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 4100,
  HOST: "127.0.0.1",
  AGENTS_DATABASE_URL: "postgres://unused",
  AGENTS_DATABASE_POOL_MAX: 1,
  TEMPORAL_ENABLED: false,
  TEMPORAL_MODE: "local",
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "test",
  KASIAI_MODEL_PROVIDER: "openrouter",
  KASIAI_MODEL: "openai/gpt-4o-mini",
  INTERNAL_AUTH_AUDIENCE: "test",
  AUTH_MODE: "headers",
  LOG_LEVEL: "silent",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  clearKasiAiModelCatalogCacheForTests();
  vi.unstubAllEnvs();
  globalThis.fetch = originalFetch;
});

function clearProviderKeys(): void {
  for (const provider of MODEL_PROVIDERS) {
    vi.stubEnv(MODEL_PROVIDER_DEFINITIONS[provider].apiKeyEnv, " ");
  }
}

function modelPayload(provider: ModelProvider): unknown {
  if (provider === "gemini") {
    return {
      models: [
        { name: "models/gemini-live", displayName: "Gemini Live", description: "Live Gemini catalog entry.", inputTokenLimit: 65_536, outputTokenLimit: 8_192, supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-embedding", displayName: "Embedding only", supportedGenerationMethods: ["embedContent"] },
      ],
    };
  }
  const row = {
    id: provider === "opencode_go" || provider === "opencode_zen" ? "deepseek-v4-pro-live" : `${provider}-live-model`,
    name: `${provider} Live Model`,
    display_name: `${provider} Live Model`,
    context_window: 65_536,
    max_output_tokens: 8_192,
    capabilities: { tool_use: { supported: true } },
    supported_parameters: ["tools", "tool_choice", "reasoning"],
    pricing: { prompt: "0.000001", completion: "0.000002" },
  };
  return provider === "xai" ? { models: [row] } : { data: [row] };
}

describe("provider model catalogs", () => {
  it("keeps a selectable provider-specific preset when no provider keys are configured", async () => {
    clearProviderKeys();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    const catalog = await getKasiAiModelCatalog(config);
    const listedProviders = new Set(catalog.models.map((model) => model.provider));

    expect(catalog.source).toBe("fallback");
    expect(listedProviders).toEqual(new Set(MODEL_PROVIDERS));
    for (const provider of MODEL_PROVIDERS) {
      expect(catalog.models).toContainEqual(expect.objectContaining({
        provider,
        model: MODEL_PROVIDER_DEFINITIONS[provider].defaultModel,
      }));
      expect(catalog.providers[provider]?.source).toBe("fallback");
      await expect(isAllowedKasiAiModel(config, provider, MODEL_PROVIDER_DEFINITIONS[provider].defaultModel)).resolves.toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(MODEL_PROVIDERS)("loads the %s catalog using only that provider's key", async (provider) => {
    clearProviderKeys();
    vi.stubEnv(MODEL_PROVIDER_DEFINITIONS[provider].apiKeyEnv, "provider-only-test-key");
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify(modelPayload(provider)), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const catalog = await getKasiAiModelCatalog(config);
    const discoveredModel = provider === "gemini"
      ? "gemini-live"
      : provider === "opencode_go" || provider === "opencode_zen"
        ? "deepseek-v4-pro-live"
        : `${provider}-live-model`;
    expect(catalog.source).toBe("mixed");
    expect(catalog.providers[provider]).toMatchObject({ source: "live" });
    expect(catalog.models).toContainEqual(expect.objectContaining({
      provider,
      model: discoveredModel,
      contextWindow: 65_536,
      maxOutputTokens: 8_192,
    }));
    if (provider !== "gemini") expect(catalog.models).toContainEqual(expect.objectContaining({ provider, model: discoveredModel, supportsTools: true }));
    else expect(catalog.models.find((model) => model.model === discoveredModel)?.supportsTools).toBeUndefined();
    expect(catalog.models).not.toContainEqual(expect.objectContaining({ model: "gemini-embedding" }));
    await expect(isAllowedKasiAiModel(config, provider, discoveredModel)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const headers = new Headers(capturedInit?.headers);
    const definition = MODEL_PROVIDER_DEFINITIONS[provider];
    if (definition.verificationAuth === "bearer") expect(headers.get("authorization")).toBe("Bearer provider-only-test-key");
    if (definition.verificationAuth === "x-api-key") {
      expect(headers.get("x-api-key")).toBe("provider-only-test-key");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
    }
    if (definition.verificationAuth === "gemini-query") expect(new URL(capturedUrl).searchParams.get("key")).toBe("provider-only-test-key");
  });

  it("keeps provider-scoped presets and reports an unavailable provider catalog safely", async () => {
    clearProviderKeys();
    vi.stubEnv(MODEL_PROVIDER_DEFINITIONS.openai.apiKeyEnv, "openai-test-key");
    globalThis.fetch = vi.fn(async () => new Response("provider error containing secret must not escape", { status: 503 })) as typeof fetch;

    const catalog = await getKasiAiModelCatalog(config);

    expect(catalog.source).toBe("fallback");
    expect(catalog.providers.openai).toMatchObject({ source: "fallback", error: "OpenAI model catalog returned HTTP 503." });
    expect(catalog.error).toContain("OpenAI model catalog returned HTTP 503.");
    expect(catalog.error).not.toContain("secret");
    expect(catalog.models).toContainEqual(expect.objectContaining({ provider: "openai", model: MODEL_PROVIDER_DEFINITIONS.openai.defaultModel }));
  });

  it("loads organization credentials independently without sharing catalog cache entries", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer organization-key-${callCount}`);
      return new Response(JSON.stringify({ data: [{ id: `tenant-model-${callCount}`, name: `Tenant Model ${callCount}` }] }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const first = await getProviderKasiAiModelCatalog("openai", "organization-key-1");
    const second = await getProviderKasiAiModelCatalog("openai", "organization-key-2");

    expect(first).toMatchObject({ source: "live", models: [expect.objectContaining({ model: "tenant-model-1" })] });
    expect(second).toMatchObject({ source: "live", models: [expect.objectContaining({ model: "tenant-model-2" })] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["opencode_go", "opencode_zen"] as const)("only lists %s models with a supported runtime protocol", async (provider) => {
    const ids = [
      "deepseek-v4-pro",
      "kimi-k3",
      "glm-5.3",
      "minimax-m3",
      "longcat-2.0",
      "omen-alpha",
      "claude-sonnet-5",
      "gpt-6-sol",
      "gemini-3.8-flash",
      "jev-1.13",
    ];
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id, name: id })) }), { status: 200 })) as typeof fetch;

    const catalog = await getProviderKasiAiModelCatalog(provider, "opencode-key");
    const models = catalog.models.map((model) => model.model);

    expect(models).toContain("deepseek-v4-pro");
    expect(models).toContain("kimi-k3");
    expect(models).toContain("glm-5.3");
    expect(models).toContain("longcat-2.0");
    expect(models).toContain("minimax-m3");
    expect(models).toContain("claude-sonnet-5");
    expect(models).toContain("gpt-6-sol");
    if (provider === "opencode_zen") expect(models).toContain("gemini-3.8-flash");
    if (provider === "opencode_go") expect(models).not.toContain("gemini-3.8-flash");
    expect(models).not.toContain("jev-1.13");
    expect(models).not.toContain("omen-alpha");
  });
});
