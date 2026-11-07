import { describe, it, expect } from "vitest";
import { ESTIMATED_BYTES_PER_TOKEN, estimatedTokensFromSerialized } from "../src/execution/context/serialized-tokens";

describe("serialized token accounting", () => {
  // Observed request sizes and provider input counts from a Growth Content conversation.
  const observed = [
    { label: "greeting, cold start", estimatedBytes: 65307, providerTokens: 21546 },
    { label: "tool selection", estimatedBytes: 66830, providerTokens: 21838 },
    { label: "answer after tool", estimatedBytes: 80595, providerTokens: 24640 },
  ];

  it("stays at or just above the observed provider count", () => {
    for (const sample of observed) {
      const estimated = estimatedTokensFromSerialized(sample.estimatedBytes);
      expect(estimated).toBeGreaterThanOrEqual(sample.providerTokens);
      // The serialized form is under 3.3 bytes per token, so the estimate never drifts far above.
      expect(estimated / sample.providerTokens).toBeLessThan(1.12);
    }
  });

  it("no longer counts bytes as tokens", () => {
    expect(ESTIMATED_BYTES_PER_TOKEN).toBe(3);
    expect(estimatedTokensFromSerialized(65307)).toBe(21769);
    // The previous implementation returned the byte count itself.
    expect(estimatedTokensFromSerialized(65307)).toBeLessThan(65307 / 2);
  });

  it("adds the measured native correction in the estimated-token unit", () => {
    const base = estimatedTokensFromSerialized(30000);
    expect(estimatedTokensFromSerialized(30000, 250)).toBe(base + 250);
    expect(estimatedTokensFromSerialized(0, 0)).toBe(0);
  });

  it("rejects unsafe sizes instead of producing a negative or fractional estimate", () => {
    expect(() => estimatedTokensFromSerialized(-1)).toThrow(RangeError);
    expect(() => estimatedTokensFromSerialized(1.5)).toThrow(RangeError);
    expect(() => estimatedTokensFromSerialized(100, -5)).toThrow(RangeError);
  });
});
