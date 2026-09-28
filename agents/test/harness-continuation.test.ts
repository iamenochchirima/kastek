import { describe, expect, it } from "vitest";
import { continuationFromLoopResult } from "../src/runtime/continuation";
import type { AgentLoopResult } from "../src/runtime/loop";

function result(status: AgentLoopResult["status"], code?: string): AgentLoopResult {
  return {
    status,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
    iterations: 0,
    toolCalls: 0,
    ...(code ? { error: { code, message: code } } : {}),
  };
}

describe("harness continuations", () => {
  it("maps every waiting state to one typed workflow continuation", () => {
    expect(continuationFromLoopResult(result("awaiting_approval"))).toMatchObject({ status: "waiting", reason: "approval" });
    expect(continuationFromLoopResult(result("awaiting_human"))).toMatchObject({ status: "waiting", reason: "human" });
    expect(continuationFromLoopResult(result("awaiting_external_event"))).toMatchObject({ status: "waiting", reason: "external_event" });
  });

  it("does not let uncertain effects become ordinary failures", () => {
    expect(continuationFromLoopResult(result("failed", "EFFECT_OUTCOME_UNKNOWN"))).toMatchObject({ status: "reconciliation_required" });
    expect(continuationFromLoopResult(result("failed", "OTHER_FAILURE"))).toMatchObject({ status: "failed", code: "OTHER_FAILURE" });
  });
});
