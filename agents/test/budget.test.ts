import { describe, expect, it } from "vitest";
import { createAgentBudgetLedger } from "../src/runtime/budget";

describe("agent budget ledger", () => {
  it("shares model, tool, graph, and child limits through one typed ledger", () => {
    const ledger = createAgentBudgetLedger({ modelTokens: 10, toolCalls: 1, graphSteps: 1, childInvocations: 1 });
    ledger.consume("model", 10);
    ledger.consume("tool");
    ledger.consume("graph");
    ledger.consume("child");
    expect(ledger.snapshot().usage).toMatchObject({ modelTokens: 10, toolCalls: 1, graphSteps: 1, childInvocations: 1 });
    expect(ledger.admit("tool")).toBe(false);
  });
});
