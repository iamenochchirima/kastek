import { describe, expect, it, vi } from "vitest";
import { ProviderMetadataClient } from "../src/model/provider-metadata";

const credentials = { apiKey: "secret-key", fundingSource: "kasitek" as const, credentialReference: "workspace-key" };

function route(overrides: Partial<Parameters<ProviderMetadataClient["resolve"]>[0]["route"]> = {}) {
  return {
    provider: "gemini" as const,
    model: "gemini-3.1-flash",
    endpointId: "gemini:default",
    credentialRouteId: "workspace-key",
    runtimeEnvironment: "playground",
    ...overrides,
  };
}

describe("provider model metadata", () => {
  it("parses Gemini limits and authenticates with a query key without returning the key", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toContain("models?key=secret-key");
      expect(init?.headers).toEqual({ accept: "application/json" });
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.1-flash", inputTokenLimit: 1_048_576, outputTokenLimit: 8_192 }] }), { status: 200 });
    });
    const client = new ProviderMetadataClient({ fetcher, now: () => Date.parse("2026-09-08T00:00:00.000Z") });

    const result = await client.resolve({ route: route(), credentials });

    expect(result).toMatchObject({
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 8_192,
      source: "provider_metadata",
      credentialRouteId: "workspace-key",
    });
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("parses OpenRouter context metadata and caches the exact credential route", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ id: "openai/gpt-5", context_length: 400_000, top_provider: { max_completion_tokens: 32_000 } }] }), { status: 200 }));
    const client = new ProviderMetadataClient({ fetcher, now: () => Date.parse("2026-09-08T00:00:00.000Z") });
    const openRouterRoute = route({ provider: "openrouter", model: "openai/gpt-5", endpointId: "openrouter:default" });

    await expect(client.resolve({ route: openRouterRoute, credentials })).resolves.toMatchObject({ contextWindowTokens: 400_000 });
    await expect(client.resolve({ route: openRouterRoute, credentials })).resolves.toMatchObject({ contextWindowTokens: 400_000 });

    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("uses the provider's x-api-key metadata contract without treating model ids as capacity", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toEqual({ "x-api-key": "secret-key", "anthropic-version": "2023-06-01", accept: "application/json" });
      return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-5", context_window: 200_000 }] }), { status: 200 });
    });
    const client = new ProviderMetadataClient({ fetcher });

    await expect(client.resolve({
      route: route({ provider: "anthropic", model: "claude-sonnet-5", endpointId: "anthropic:default" }),
      credentials,
    })).resolves.toMatchObject({ contextWindowTokens: 200_000 });
  });

  it("returns no capacity for a model endpoint that exposes only an id", async () => {
    const client = new ProviderMetadataClient({
      fetcher: async () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 }),
    });

    await expect(client.resolve({
      route: route({ provider: "openai", model: "gpt-5", endpointId: "openai:default" }),
      credentials,
    })).resolves.toBeUndefined();
  });

  it("does not query custom endpoints or leak credentials on provider failures", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error("provider response contained secret-key"); });
    const client = new ProviderMetadataClient({ fetcher });

    await expect(client.resolve({ route: route({ endpointId: "custom:endpoint" }), credentials })).resolves.toBeUndefined();
    await expect(client.resolve({ route: route(), credentials })).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
