import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import { availableKasiAiModels, clearKasiAiModelCatalogCacheForTests, getKasiAiModelCatalog, isAllowedKasiAiModel } from "../src/system/kasiai-models";

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

const originalKey = process.env.OPENROUTER_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
  clearKasiAiModelCatalogCacheForTests();
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
  globalThis.fetch = originalFetch;
});

describe("KasiAi OpenRouter model catalog", () => {
  it("uses the live OpenRouter text catalog and preserves model metadata", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          id: "vendor/tool-model",
          name: "Tool Model",
          description: "A capable model.",
          context_length: 128_000,
          pricing: { prompt: "0.000001", completion: "0.000002" },
          supported_parameters: ["tools", "tool_choice", "reasoning"],
        },
        {
          id: "vendor/free-model:free",
          name: "Free Model",
          pricing: { prompt: "0", completion: "0" },
          supported_parameters: [],
        },
      ],
    }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const catalog = await getKasiAiModelCatalog(config);
    expect(catalog.source).toBe("live");
    expect(catalog.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "openrouter", model: "vendor/tool-model", supportsTools: true, supportsReasoning: true, contextWindow: 128_000, inputUsdPerMillion: 1 }),
      expect.objectContaining({ model: "vendor/free-model:free", isFree: true, supportsTools: false }),
    ]));
    expect(catalog.models[0]).toMatchObject({ model: "openai/gpt-4o-mini", isWorkspaceDefault: true });
    await availableKasiAiModels(config);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(isAllowedKasiAiModel(config, "openrouter", "vendor/tool-model")).resolves.toBe(true);
  });

  it("uses a short-lived safe fallback when the live catalog cannot be read", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = vi.fn(async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    const catalog = await getKasiAiModelCatalog(config);
    expect(catalog).toMatchObject({ source: "fallback", error: expect.stringContaining("503") });
    expect(catalog.models).toEqual(expect.arrayContaining([expect.objectContaining({ model: "google/gemma-3-27b-it:free" })]));
  });
});
