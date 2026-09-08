import { describe, expect, it } from "vitest";
import { decideMemoryRetrievalWithGate, type RetrievalGateClassifier } from "../src/memory/retrieval-gate";

function classifier(result: { retrieve: boolean; query?: string; confidence: number }): RetrievalGateClassifier {
  return { model: "test-small", classify: async () => result };
}

describe("memory retrieval gate", () => {
  it("does not call the classifier for an obvious acknowledgement", async () => {
    let calls = 0;
    const gate: RetrievalGateClassifier = {
      model: "test-small",
      classify: async () => {
        calls += 1;
        return { retrieve: true, query: "should not run", confidence: 1 };
      },
    };
    const result = await decideMemoryRetrievalWithGate("Thanks!", { classifier: gate });
    expect(result.decision.requested).toBe(false);
    expect(result.metadata.source).toBe("deterministic_prefilter");
    expect(calls).toBe(0);
  });

  it("uses the small classifier only when confidence clears the threshold", async () => {
    const result = await decideMemoryRetrievalWithGate("Please take care of this when you can", {
      classifier: classifier({ retrieve: true, query: "my request context", confidence: 0.91 }),
      minConfidence: 0.8,
    });
    expect(result.decision.requested).toBe(true);
    expect(result.decision.reasonCode).toBe("contextual_question");
    expect(result.metadata.source).toBe("small_model");
  });

  it("falls back deterministically when the gate fails", async () => {
    const gate: RetrievalGateClassifier = {
      model: "test-small",
      classify: async () => { throw new Error("provider unavailable"); },
    };
    const result = await decideMemoryRetrievalWithGate("Please take care of this when you can", { classifier: gate });
    expect(result.decision.requested).toBe(false);
    expect(result.metadata.source).toBe("bounded_fallback");
    expect(result.metadata.errorCode).toBe("Error");
  });
});
