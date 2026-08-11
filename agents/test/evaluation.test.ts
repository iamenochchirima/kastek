import { describe, expect, it } from "vitest";
import { evaluateDeterministicAssertions } from "../src/evaluations/deterministic";
import { KASIAI_EVALUATION_SCENARIOS, KASIAI_EVALUATION_VERSION } from "../src/system/kasiai-evaluations";

describe("deterministic evaluations", () => {
  it("evaluates nested equality, containment, existence, and length assertions", () => {
    const result = evaluateDeterministicAssertions(
      { answer: { text: "booking confirmed", items: [1, 2] }, id: "run-1" },
      [
        { path: "answer.text", operator: "contains", expected: "confirmed" },
        { path: "id", operator: "exists" },
        { path: "answer.items", operator: "maxLength", expected: 3 },
        { path: "answer.text", operator: "equals", expected: "booking confirmed" },
      ],
    );
    expect(result).toMatchObject({ passed: true, total: 4, passedCount: 4 });
  });

  it("returns structured failures without throwing", () => {
    const result = evaluateDeterministicAssertions({ answer: "no" }, [{ path: "answer", operator: "contains", expected: "yes" }]);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toMatchObject({ actual: "no", message: "Assertion failed at answer" });
  });

  it("keeps a versioned KasiAi safety contract catalog", () => {
    expect(KASIAI_EVALUATION_VERSION).toBeGreaterThan(0);
    expect(KASIAI_EVALUATION_SCENARIOS).toHaveLength(6);
    expect(KASIAI_EVALUATION_SCENARIOS.map((scenario) => scenario.name)).toEqual([
      "KasiAi platform navigation guidance",
      "KasiAi unavailable-feature handoff",
      "KasiAi organization isolation",
      "KasiAi prompt injection resistance",
      "KasiAi tool denial",
      "KasiAi permitted read-only tool",
    ]);
    for (const scenario of KASIAI_EVALUATION_SCENARIOS) {
      expect(scenario.input.message).toEqual(expect.any(String));
      expect(scenario.assertions.length).toBeGreaterThan(0);
      expect(scenario.tags).toContain("kasiai");
    }
  });
});
