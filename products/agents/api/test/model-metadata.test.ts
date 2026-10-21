import { describe, expect, it } from "vitest";
import { enrichModelMetadata } from "../src/adapters/models/model-metadata";
import type { ModelDescriptor } from "../src/contracts/model-providers";
import type { BundledProviderModel } from "../src/adapters/models/pi-transport";

const unknown = { value: null, source: null, evidence: "unknown" as const };
const discovered: ModelDescriptor = { id: "model", providerId: "openai", name: "Model", protocol: "openai_responses", revision: "discovery",
  contextTokens: { value: null, source: null }, maxInputTokens: { value: null, source: null }, maxOutputTokens: { value: null, source: null },
  capabilities: { tools: unknown, reasoning: unknown, structuredOutput: unknown }, inputModalities: [], outputModalities: [], pricing: null, lifecycle: "unknown" };
const bundled: BundledProviderModel = { id: "model", name: "Model", api: "openai-responses", contextWindow: 128000, maxTokens: 16000,
  input: ["text", "image"], reasoning: true, cost: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 } };
const observedAt = "2026-10-21T00:00:00Z";
describe("sourced model metadata enrichment", () => {
  it("fills missing fields without inventing tool verification or account access", () => {
    const model = enrichModelMetadata(discovered, [bundled], observedAt);
    expect(model.contextTokens.value).toBe(128000); expect(model.maxOutputTokens.value).toBe(16000);
    expect(model.contextTokens.source?.kind).toBe("registry");
    expect(model.capabilities.tools).toEqual(unknown); expect(model.capabilities.reasoning.evidence).toBe("declared");
    expect(model.inputModalities).toEqual(["text", "image"]); expect(model.outputModalities).toEqual(["text"]);
    expect(model.pricing?.inputMicrosPerMillionTokens).toBe(1000000); expect(model.pricing?.cachedInputMicrosPerMillionTokens).toBeNull();
    expect(discovered.contextTokens.value).toBeNull();
  });
  it("preserves discovered values and rejects accidental protocol or model alias matching", () => {
    const source = { kind: "discovery" as const, reference: "https://api.example.test/models", observedAt };
    expect(enrichModelMetadata({ ...discovered, contextTokens: { value: 64000, source } }, [bundled], observedAt).contextTokens.value).toBe(64000);
    for (const profile of [{ ...bundled, id: "model:free" }, { ...bundled, api: "anthropic-messages" }]) {
      expect(enrichModelMetadata(discovered, [profile], observedAt)).toEqual(discovered);
    }
  });
  it("matches reviewed Mistral metadata to its native adapter API without accepting other providers", () => {
    const mistral = { ...discovered, providerId: "mistral", protocol: "openai_chat_completions" as const };
    const native = { ...bundled, api: "mistral-conversations" };
    expect(enrichModelMetadata(mistral, [native], observedAt).contextTokens.value).toBe(128000);
    expect(enrichModelMetadata({ ...mistral, providerId: "groq" }, [native], observedAt).contextTokens.value).toBeNull();
  });
  it("does not interpret generated zero prices as a free model", () => {
    expect(enrichModelMetadata(discovered, [{ ...bundled, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], observedAt).pricing).toBeNull();
  });
});
