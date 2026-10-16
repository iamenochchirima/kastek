import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  OpenAICompatibleEmbeddingProvider,
  createEnvironmentEmbeddingProvider,
  formatPgVector,
} from "../src/memory/embeddings";

function vector(value: number): number[] {
  return Array.from({ length: DEFAULT_EMBEDDING_DIMENSIONS }, (_, index) => index === 0 ? value : 0);
}

describe("memory embeddings", () => {
  it("orders batched provider results and validates the released dimension", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { index: 1, embedding: vector(0.2) },
        { index: 0, embedding: vector(0.1) },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new OpenAICompatibleEmbeddingProvider({
      provider: "openrouter",
      baseUrl: "https://embedding.example/v1",
      apiKey: "test-key",
      model: "openai/text-embedding-3-small",
      dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
      fetchImpl,
    });

    await expect(provider.embed(["first", "second"])).resolves.toEqual([vector(0.1), vector(0.2)]);
    expect(fetchImpl).toHaveBeenCalledWith("https://embedding.example/v1/embeddings", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ model: "openai/text-embedding-3-small", input: ["first", "second"] });
  });

  it("rejects provider responses with the wrong dimension", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), { status: 200 }));
    const provider = new OpenAICompatibleEmbeddingProvider({ provider: "openrouter", baseUrl: "https://embedding.example/v1", apiKey: "test-key", model: "test", dimensions: DEFAULT_EMBEDDING_DIMENSIONS, fetchImpl });
    await expect(provider.embed(["wrong dimension"])).rejects.toThrow("wrong dimension");
  });

  it("keeps embeddings disabled unless explicitly enabled and configured", () => {
    expect(createEnvironmentEmbeddingProvider({ OPENROUTER_API_KEY: "key" })).toBeUndefined();
    expect(createEnvironmentEmbeddingProvider({ EMBEDDINGS_ENABLED: "true" })).toBeUndefined();
    expect(createEnvironmentEmbeddingProvider({ EMBEDDINGS_ENABLED: "true", OPENROUTER_API_KEY: "key" })).toMatchObject({ provider: "openrouter", model: "openai/text-embedding-3-small", dimensions: 1536 });
  });

  it("formats only finite released-dimension vectors for PostgreSQL", () => {
    expect(formatPgVector(vector(0.25))).toMatch(/^\[0\.25,0,0/);
    expect(formatPgVector([0.1, 0.2, 0.3])).toBeNull();
    expect(formatPgVector([Number.NaN, ...vector(0).slice(1)])).toBeNull();
  });
});
