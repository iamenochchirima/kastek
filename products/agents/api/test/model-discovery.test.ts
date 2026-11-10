import { afterEach, describe, expect, it, vi } from "vitest";
import { getProviderDefinition } from "../src/adapters/models/registry";
import {
  discoverProviderModels, ModelDiscoveryError, usdPerTokenToMicrosPerMillion,
  type ModelDiscoveryOptions, type ModelDiscoveryRequest,
} from "../src/adapters/models/discovery";

const observedAt = "2026-10-21T00:00:00.000Z";
const privateKey = "private-test-credential-do-not-return";
function setup(providerId: string, body: unknown, changes: Partial<ModelDiscoveryOptions> = {}) {
  const provider = getProviderDefinition(providerId)!;
  const fetch = vi.fn(async (_request: ModelDiscoveryRequest) => ({ status: 200, body: JSON.stringify(body) }));
  const options: ModelDiscoveryOptions = {
    apiKey: privateKey, endpoint: provider.baseUrl, fetch, observedAt, maxResponseBytes: 1000000, maxModels: 1000, ...changes,
  };
  return { provider, options, fetch };
}

afterEach(() => vi.unstubAllGlobals());

describe("bounded provider model discovery", () => {
  it("uses the injected transport, preserves versioned paths and does not infer generic model capabilities", async () => {
    const ambient = vi.fn(() => { throw new Error("Ambient network forbidden"); });
    vi.stubGlobal("fetch", ambient);
    const { provider, options, fetch } = setup("openai", {
      data: [{ id: "model-a", object: "model", tools: true, context_length: 1000000 }, { id: "embedding-model" }],
    });
    const result = await discoverProviderModels(provider, options);
    expect(fetch).toHaveBeenCalledExactlyOnceWith({
      url: "https://api.openai.com/v1/models", method: "GET", redirect: "error", maxResponseBytes: 1000000,
      headers: { Accept: "application/json", Authorization: `Bearer ${privateKey}` },
    });
    expect(ambient).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "discovered", visibility: "credential_scoped", complete: true, observedAt });
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({
      contextTokens: { value: null, source: null }, maxInputTokens: { value: null, source: null },
      maxOutputTokens: { value: null, source: null }, inputModalities: [], outputModalities: [], pricing: null,
      capabilities: {
        tools: { value: null, evidence: "unknown", source: null },
        reasoning: { value: null, evidence: "unknown", source: null },
        structuredOutput: { value: null, evidence: "unknown", source: null },
      },
    });
    expect(JSON.stringify(result)).not.toContain(privateKey);
  });

  it("normalizes OpenRouter metadata as discovered public catalogue evidence without claiming inference verification", async () => {
    const { provider, options } = setup("openrouter", { data: [{
      id: "lab/model", name: "Lab model", context_length: 128000,
      top_provider: { context_length: 100000, max_completion_tokens: 16000 },
      supported_parameters: ["tools", "reasoning_effort", "structured_outputs"],
      architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
      pricing: { prompt: "0.0000001", completion: "0.0000004", input_cache_read: "0.000000025", input_cache_write: "0.000000125" },
    }] });
    const result = await discoverProviderModels(provider, options);
    const model = result.models[0]!;
    const source = { kind: "discovery", reference: "https://openrouter.ai/api/v1/models", observedAt };
    expect(result).toMatchObject({ kind: "discovered", visibility: "public_catalog" });
    expect(model).toMatchObject({
      id: "lab/model", contextTokens: { value: 100000, source }, maxInputTokens: { value: null, source: null },
      maxOutputTokens: { value: 16000, source }, inputModalities: ["text", "image"], outputModalities: ["text"],
      capabilities: {
        tools: { value: true, evidence: "discovered", source }, reasoning: { value: true, evidence: "discovered", source },
        structuredOutput: { value: true, evidence: "discovered", source },
      },
      pricing: { currency: "USD", inputMicrosPerMillionTokens: 100000, outputMicrosPerMillionTokens: 400000, cachedInputMicrosPerMillionTokens: 25000, cacheWriteMicrosPerMillionTokens: 125000, source },
    });
    expect(model.revision).toMatch(/^[a-f0-9]{64}$/);
    expect((await discoverProviderModels(provider, options)).models[0]!.revision).toBe(model.revision);
    expect(JSON.stringify(model)).not.toContain("verified");
  });

  it("distinguishes absent capabilities and unrepresentable prices from explicitly unsupported and free", async () => {
    const { provider, options } = setup("openrouter", { data: [
      { id: "unknown-model", pricing: { prompt: "0.0000000000001", completion: "-1" } },
      { id: "free-model", supported_parameters: [], pricing: { prompt: "0", completion: "0" } },
      { id: "json-object-model", supported_parameters: ["response_format"] },
    ] });
    const result = await discoverProviderModels(provider, options);
    expect(result.models[0]!.capabilities.tools.value).toBeNull();
    expect(result.models[0]!.pricing).toMatchObject({ inputMicrosPerMillionTokens: null, outputMicrosPerMillionTokens: null });
    expect(result.models[1]!.capabilities.tools).toMatchObject({ value: false, evidence: "discovered" });
    expect(result.models[1]!.pricing).toMatchObject({ inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 });
    expect(result.models[2]!.capabilities.structuredOutput.value).toBe(false);
  });

  it("uses native Anthropic authentication and preserves independently discovered input/output limits", async () => {
    const { provider, options, fetch } = setup("anthropic", { data: [{
      id: "claude-model", display_name: "Claude model", max_input_tokens: 200000, max_tokens: 64000, lifecycle: "deprecated",
      capabilities: { thinking: { supported: true }, structured_outputs: { supported: false }, server_tools: { supported: true } },
    }], has_more: true });
    const result = await discoverProviderModels(provider, options);
    expect(fetch.mock.calls[0]![0]).toMatchObject({
      url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": privateKey, "anthropic-version": "2023-06-01" },
    });
    expect(fetch.mock.calls[0]![0].headers).not.toHaveProperty("Authorization");
    expect(result).toMatchObject({ kind: "discovered", complete: false });
    expect(result.models[0]).toMatchObject({
      contextTokens: { value: null }, maxInputTokens: { value: 200000 }, maxOutputTokens: { value: 64000 }, lifecycle: "deprecated",
      capabilities: { tools: { value: null }, reasoning: { value: true }, structuredOutput: { value: false } },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("normalizes Gemini names and filters explicitly unrelated model methods without guessing combined context", async () => {
    const { provider, options, fetch } = setup("google", { models: [
      { name: "models/gemini-model", displayName: "Gemini model", inputTokenLimit: 1000000, outputTokenLimit: 65000, thinking: true, supportedGenerationMethods: ["generateContent", "countTokens"] },
      { name: "models/embedding-model", supportedGenerationMethods: ["embedContent"] },
    ], nextPageToken: "opaque-provider-cursor" });
    const result = await discoverProviderModels(provider, options);
    expect(fetch.mock.calls[0]![0]).toMatchObject({
      url: "https://generativelanguage.googleapis.com/v1beta/models", headers: { "x-goog-api-key": privateKey },
    });
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({ id: "gemini-model", contextTokens: { value: null }, maxInputTokens: { value: 1000000 }, maxOutputTokens: { value: 65000 }, capabilities: { reasoning: { value: true }, tools: { value: null } } });
    expect(result).toMatchObject({ complete: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["fireworks", "zai"])("requires manual model records for curated %s without inventing an endpoint", async providerId => {
    const { provider, options, fetch } = setup(providerId, {});
    expect(await discoverProviderModels(provider, options)).toEqual({ kind: "manual_required", models: [], observedAt });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses only the explicit connection endpoint and refuses redirects without forwarding credentials", async () => {
    const { provider, options, fetch } = setup("openai", { data: [] }, { endpoint: "https://approved-relay.example.com/service/v1/" });
    await discoverProviderModels(provider, options);
    expect(fetch.mock.calls[0]![0].url).toBe("https://approved-relay.example.com/service/v1/models");
    fetch.mockResolvedValue({ status: 302, body: JSON.stringify({ location: "https://attacker.example.com", apiKey: privateKey }) });
    await expect(discoverProviderModels(provider, options)).rejects.toMatchObject({ code: "redirect_rejected", status: 302 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    "http://api.example.com", "https://user:secret@api.example.com", "https://api.example.com?api_key=secret", "https://api.example.com/#secret",
  ])("refuses invalid endpoint configuration before passing any credential to transport: %s", async endpoint => {
    const { provider, options, fetch } = setup("openai", { data: [] }, { endpoint });
    await expect(discoverProviderModels(provider, options)).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("requires explicit safe byte and model-count budgets: %s", async bound => {
    for (const field of ["maxResponseBytes", "maxModels"] as const) {
      const { provider, options, fetch } = setup("openai", { data: [] }, { [field]: bound });
      await expect(discoverProviderModels(provider, options)).rejects.toMatchObject({ code: "invalid_configuration" });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("bounds actual UTF-8 bytes and catalogue size before normalization", async () => {
    const body = { data: [{ id: "model", name: "é".repeat(100) }] };
    const fixture = setup("openai", body, { maxResponseBytes: JSON.stringify(body).length });
    await expect(discoverProviderModels(fixture.provider, fixture.options)).rejects.toMatchObject({ code: "response_too_large" });
    const catalogue = setup("openai", { data: [{ id: "first" }, { id: "second" }] }, { maxModels: 1 });
    await expect(discoverProviderModels(catalogue.provider, catalogue.options)).rejects.toMatchObject({ code: "catalogue_limit_exceeded" });
  });

  it.each([
    null, [], {}, { data: {} }, { data: [null] }, { data: [{ id: "" }] }, { data: [{ id: "x".repeat(513) }] },
    { data: [{ id: "model", name: "x".repeat(257) }] }, { data: [{ id: "same" }, { id: "same" }] },
    { data: [], has_more: "true" }, { data: [], nextPageToken: 1 },
  ])("rejects malformed envelopes and unbounded/duplicate identity fields", async body => {
    const { provider, options } = setup("openai", body);
    await expect(discoverProviderModels(provider, options)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    [401, "authentication_rejected"], [403, "access_denied"], [429, "rate_limited"], [503, "unavailable"], [400, "http_rejected"],
  ])("classifies HTTP %s without returning raw provider failures or credentials", async (status, code) => {
    const { provider, options, fetch } = setup("openai", {});
    fetch.mockResolvedValue({ status: status as number, body: JSON.stringify({ error: `Provider echoed ${privateKey}` }) });
    const error = await discoverProviderModels(provider, options).catch(error => error);
    expect(error).toBeInstanceOf(ModelDiscoveryError);
    expect(error).toMatchObject({ code, status });
    expect(String(error)).not.toContain(privateKey);
    expect(JSON.stringify(error)).not.toContain(privateKey);
  });

  it("sanitizes transport exceptions, malformed JSON and a provider echoing credentials into model metadata", async () => {
    const { provider, options, fetch } = setup("openai", {});
    fetch.mockRejectedValue(new Error(`request Authorization: Bearer ${privateKey}`));
    const network = await discoverProviderModels(provider, options).catch(error => error);
    expect(network).toMatchObject({ code: "network_failed" });
    expect(String(network)).not.toContain(privateKey);
    fetch.mockResolvedValue({ status: 200, body: `invalid JSON ${privateKey}` });
    await expect(discoverProviderModels(provider, options)).rejects.toMatchObject({ code: "invalid_response" });
    fetch.mockResolvedValue({ status: 200, body: JSON.stringify({ data: [{ id: "model", name: privateKey }] }) });
    await expect(discoverProviderModels(provider, options)).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("exact decimal model price normalization", () => {
  it.each([
    ["0", 0], ["0.0000001", 100000], ["0.000000025", 25000], ["1e-12", 1], ["1e-13", null],
    ["0.0000000000010", 1], ["1e-7", 100000], ["9007.199254740991", Number.MAX_SAFE_INTEGER],
    ["9007.199254740992", null], ["-1", null], ["Infinity", null], ["", null], ["1e999999999999999999999999", null],
    ["0e999999999999999999999999", 0], [0.0000001, null], [null, null],
  ])("converts USD/token %s without floating-point rounding", (input, expected) => {
    expect(usdPerTokenToMicrosPerMillion(input)).toBe(expected);
  });
});
