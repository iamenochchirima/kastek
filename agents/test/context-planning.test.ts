import { describe, expect, it } from "vitest";
import {
  accountProviderUsage,
  estimateApproximateTokens,
  planProviderRequest,
  type ProviderContextProfile,
} from "../src/runtime/context-planning";

const profile: ProviderContextProfile = {
  provider: "openai",
  model: "test-model",
  contextWindowTokens: 1_000,
  maxOutputTokens: 200,
  safetyMarginTokens: 50,
  charsPerToken: 4,
};

const policy = {
  requestedOutputTokens: 120,
  maxToolSchemaTokens: 500,
  maxToolResultTokens: 20,
};

describe("provider context planning", () => {
  it("plans against provider capacity and exposes approximate accounting", () => {
    const plan = planProviderRequest({
      profile,
      policy: { ...policy, requestedOutputTokens: 250 },
      messages: [
        { role: "system", content: "policy" },
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "current question" },
      ],
      tools: [{ name: "read", description: "Read a record", inputSchema: { type: "object" } }],
    });

    expect(plan.status).toBe("fits");
    expect(plan.accounting.method).toBe("approximate_characters");
    expect(plan.accounting.categories.output_reservation).toBe(200);
    expect(plan.accounting.categories.tool_schemas).toBeGreaterThan(0);
    expect(plan.diagnostics.reasons).toContain("provider_output_cap");
    expect(plan.accounting.categories.safety_margin).toBe(50);
    expect(plan.accounting.reservedRequestTokens).toBeLessThanOrEqual(1_000);
  });

  it("compacts older message units without splitting an assistant tool pair", () => {
    const plan = planProviderRequest({
      profile: { ...profile, contextWindowTokens: 180, safetyMarginTokens: 20 },
      policy: { ...policy, requestedOutputTokens: 40, maxToolResultTokens: 50 },
      messages: [
        { role: "system", content: "policy" },
        { role: "user", content: "old ".repeat(120) },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "lookup", arguments: { query: "x" } }] },
        { role: "tool", name: "lookup", toolCallId: "call-1", content: "result" },
        { role: "user", content: "latest" },
      ],
    });

    expect(plan.status).toBe("compacted");
    expect(plan.diagnostics.protectedPairCount).toBe(1);
    expect(plan.messages.some((message) => message.toolCallId === "call-1")).toBe(true);
    expect(plan.messages.some((message) => message.role === "assistant" && message.toolCalls?.some((call) => call.id === "call-1"))).toBe(true);
    expect(plan.diagnostics.omittedMessageCount).toBeGreaterThan(0);
  });

  it("limits tool schemas and tool results instead of allowing either to consume the request", () => {
    const plan = planProviderRequest({
      profile,
      policy: { ...policy, maxToolSchemaTokens: 30, maxToolResultTokens: 4 },
      tools: [
        { name: "first", description: "x".repeat(100), inputSchema: { type: "object" } },
        { name: "second", description: "y".repeat(100), inputSchema: { type: "object" } },
      ],
      messages: [{ role: "system", content: "policy" }, { role: "tool", name: "first", toolCallId: "call-1", content: "result ".repeat(20) }, { role: "user", content: "current" }],
    });

    expect(plan.tools).toHaveLength(0);
    expect(plan.diagnostics.omittedToolCount).toBe(2);
    expect(plan.diagnostics.truncatedToolResultCount).toBe(1);
    expect(plan.messages.find((message) => message.role === "tool")?.content.length).toBeLessThanOrEqual(16);
  });

  it("returns a typed rejection when the current user message cannot fit", () => {
    const plan = planProviderRequest({
      profile: { ...profile, contextWindowTokens: 100, safetyMarginTokens: 20 },
      policy: { ...policy, requestedOutputTokens: 60 },
      messages: [{ role: "system", content: "policy" }, { role: "user", content: "x".repeat(1_000) }],
    });

    expect(plan.status).toBe("rejected");
    if (plan.status === "rejected") expect(plan.rejection.code).toBe("current_message_cannot_fit");
  });

  it("accounts provider usage separately from the approximate plan", () => {
    const plan = planProviderRequest({ profile, policy, messages: [{ role: "user", content: "hello" }] });
    const accepted = accountProviderUsage(plan, { inputTokens: 100, outputTokens: 20 });
    expect(accepted.status).toBe("accepted");
    expect(accepted.source).toBe("provider_reported");

    const overrun = accountProviderUsage(plan, { inputTokens: plan.accounting.inputBudgetTokens + 1, outputTokens: 20 });
    expect(overrun.status).toBe("provider_overrun");
    expect(overrun.issues).toContain("provider_input_exceeded_planned_budget");

    expect(accountProviderUsage(plan, { inputTokens: -1, outputTokens: 2 }).status).toBe("invalid_usage");
  });

  it("labels the estimator as approximate and remains deterministic", () => {
    expect(estimateApproximateTokens("1234")).toBe(1);
    expect(estimateApproximateTokens("12345")).toBe(2);
  });
});
