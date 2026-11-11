import { describe, expect, it } from "vitest";
import { hasKnownPrice, isFreeModel, reservationMicros } from "../src/execution/models/admission-budget";
import type { AcceptedModelRoutes } from "../src/contracts/model-bindings";

const route = (pricing: { inputMicrosPerMillionTokens: number; outputMicrosPerMillionTokens: number } | null, maxRootTokens: number | null = 10_000) => ({
  model: { pricing },
  policy: { maxRootTokens, maxInputTokens: 4_000, maxOutputTokens: 1_000 },
}) as unknown as AcceptedModelRoutes["primary"];

describe("admission dollar budget", () => {
  it("treats a zero-priced model as free", () => {
    const free = route({ inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 });
    expect(isFreeModel(free)).toBe(true);
    expect(reservationMicros(free)).toBe(0n);
  });

  it("prices a paid model from its root token budget and the higher price", () => {
    const paid = route({ inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 2 }, 1_000_000);
    expect(isFreeModel(paid)).toBe(false);
    expect(reservationMicros(paid)).toBe(2n);
  });

  it("does not pretend an unknown price is free", () => {
    expect(hasKnownPrice(route(null))).toBe(false);
    expect(isFreeModel(route(null))).toBe(false);
    expect(reservationMicros(route(null))).toBe(0n);
  });
});
