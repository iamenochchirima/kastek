import { describe, expect, it } from "vitest";
import { evaluateDeterministicAssertions } from "../src/evaluations/deterministic";

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
});
