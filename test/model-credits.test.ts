import { describe, expect, it } from "vitest";
import { ModelGateway } from "../src/model/gateway";
import { actualModelCallCredits, estimateModelCallCredits, estimatePromptTokens, shouldChargeModelCredits } from "../src/model/credit-pricing";

const pricing = {
  "openai:test": { inputUsdPerMillion: 2, outputUsdPerMillion: 4 },
};
const policy = { creditsPerUsd: 1_000, version: "model-cost-v1" };

describe("model credit pricing", () => {
  it("uses a conservative request estimate and actual response usage for settlement", () => {
    const gateway = new ModelGateway([], { pricing });
    const request = {
      provider: "openai" as const,
      model: "test",
      messages: [{ role: "user" as const, content: "A short request" }],
      maxTokens: 500,
    };
    expect(estimatePromptTokens(request)).toBeGreaterThan(1);
    expect(estimateModelCallCredits(gateway, pricing, policy, request)).toBeGreaterThan(
      actualModelCallCredits(gateway, pricing, policy, {
        provider: "openai",
        model: "test",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
    );
    expect(actualModelCallCredits(gateway, pricing, policy, {
      provider: "openai",
      model: "test",
      usage: { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 },
    })).toBe(4);
  });

  it("fails closed when a hosted model has no configured pricing", () => {
    const gateway = new ModelGateway([]);
    expect(() => estimateModelCallCredits(gateway, {}, policy, {
      provider: "openai",
      model: "unpriced",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 10,
    })).toThrow("MODEL_CREDIT_PRICING_UNAVAILABLE");
  });

  it("does not charge BYOK calls", () => {
    expect(shouldChargeModelCredits("enforced", "user")).toBe(false);
    expect(shouldChargeModelCredits("enforced", "kasitek")).toBe(true);
    expect(shouldChargeModelCredits("shadow", "kasitek")).toBe(true);
    expect(shouldChargeModelCredits("disabled", "kasitek")).toBe(false);
  });
});
