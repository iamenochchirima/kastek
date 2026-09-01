import { describe, expect, it } from "vitest";
import {
  DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
  decomposedOperationKey,
  isDecomposedMessage,
  isDecomposedModelResponse,
} from "../src/temporal/decomposed-contracts";

describe("decomposed Temporal activity protocol", () => {
  it("derives stable, phase-specific operation keys without payload data", () => {
    const model = decomposedOperationKey({ runId: "run-1", step: 4, kind: "model" });
    const tool = decomposedOperationKey({ runId: "run-1", step: 4, kind: "tool", operationId: "call-1" });

    expect(model).toBe(`agent:${DECOMPOSED_ACTIVITY_PROTOCOL_VERSION}:run-1:4:model`);
    expect(tool).toBe(`agent:${DECOMPOSED_ACTIVITY_PROTOCOL_VERSION}:run-1:4:tool:call-1`);
    expect(model).not.toContain("prompt");
    expect(tool).not.toContain("secret");
    expect(decomposedOperationKey({ runId: "run-1", step: 4, kind: "model" })).toBe(model);
  });

  it("rejects unsafe identity components before a ledger key is created", () => {
    expect(() => decomposedOperationKey({ runId: "", step: 0, kind: "context" })).toThrow("DECOMPOSED_RUNID_INVALID");
    expect(() => decomposedOperationKey({ runId: "run-1", step: -1, kind: "model" })).toThrow("DECOMPOSED_STEP_INVALID");
    expect(() => decomposedOperationKey({ runId: "run-1\nsecret", step: 0, kind: "tool" })).toThrow("DECOMPOSED_RUNID_INVALID");
  });

  it("accepts only the minimum persisted model/message shapes at the boundary", () => {
    expect(isDecomposedMessage({ role: "user", content: "hello" })).toBe(true);
    expect(isDecomposedMessage({ role: "user", content: 42 })).toBe(false);
    expect(isDecomposedModelResponse({
      provider: "openai",
      model: "test",
      message: { role: "assistant", content: "ok" },
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: "stop",
      latencyMs: 1,
    })).toBe(true);
    expect(isDecomposedModelResponse({ provider: "openai", model: "test", message: { role: "assistant", content: "ok" } })).toBe(false);
  });
});
