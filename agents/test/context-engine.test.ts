import { describe, expect, it, vi } from "vitest";
import { ContextEngine, ContextEngineError, type ContextEngineJournalEvent } from "../src/runtime/context-engine";

const request = {
  profile: {
    provider: "openai",
    model: "test-model",
    contextWindowTokens: 1_000,
    maxOutputTokens: 200,
    safetyMarginTokens: 20,
  },
  policy: {
    requestedOutputTokens: 100,
    maxToolSchemaTokens: 200,
    maxToolResultTokens: 100,
  },
  messages: [
    { role: "system" as const, content: "Use the configured policy." },
    { role: "user" as const, content: "What is the current status?" },
  ],
};

describe("ContextEngine", () => {
  it("runs a typed lifecycle with stable, content-free diagnostics", () => {
    const events: ContextEngineJournalEvent[] = [];
    const engine = new ContextEngine({ journal: (event) => events.push(event) });

    const started = engine.startTurn({ turnId: "turn-1", request });
    const planned = engine.requestPlan(started.handle);
    const accounted = engine.accountProviderUsage(started.handle, { inputTokens: 42, outputTokens: 8, totalTokens: 50 });
    const completed = engine.completeTurn(started.handle, { outcome: "completed" });

    expect(started.diagnostics).toMatchObject({
      turnId: "turn-1",
      phase: "started",
      planStatus: "not_planned",
      usageStatus: "not_reported",
      outcome: undefined,
    });
    expect(planned.diagnostics).toMatchObject({ phase: "planned", planStatus: "fits" });
    expect(accounted.diagnostics).toMatchObject({
      phase: "usage_accounted",
      usageStatus: "accepted",
      providerInputTokens: 42,
      providerOutputTokens: 8,
      providerTotalTokens: 50,
    });
    expect(completed.diagnostics).toMatchObject({ phase: "completed", outcome: "completed" });
    expect(completed.diagnostics).not.toHaveProperty("messages");
    expect(events.map((event) => event.lifecycle)).toEqual([
      "turn_start",
      "request_plan",
      "provider_usage_accounting",
      "turn_complete",
    ]);
    expect(events.map((event) => event.diagnostics.eventSequence)).toEqual([1, 2, 3, 4]);
    expect(() => engine.diagnostics(started.handle)).toThrowError(ContextEngineError);
  });

  it("keeps plan and usage accounting idempotent for the same lifecycle input", () => {
    const engine = new ContextEngine();
    const started = engine.startTurn({ turnId: "turn-2", request });
    const firstPlan = engine.requestPlan(started.handle);
    const secondPlan = engine.requestPlan(started.handle);
    const firstUsage = engine.accountProviderUsage(started.handle, { inputTokens: 20, outputTokens: 5 });
    const secondUsage = engine.accountProviderUsage(started.handle, { inputTokens: 20, outputTokens: 5 });
    const planAfterUsage = engine.requestPlan(started.handle);

    expect(secondPlan.diagnostics).toBe(firstPlan.diagnostics);
    expect(planAfterUsage.diagnostics).toBe(firstPlan.diagnostics);
    expect(secondUsage.diagnostics).toBe(firstUsage.diagnostics);
    expect(() => engine.accountProviderUsage(started.handle, { inputTokens: 21, outputTokens: 5 })).toThrowError(
      expect.objectContaining({ code: "provider_usage_already_accounted" }),
    );
  });

  it("prevents invalid lifecycle transitions and keeps a rejected plan explicit", () => {
    const engine = new ContextEngine();
    const started = engine.startTurn({
      turnId: "turn-3",
      request: {
        ...request,
        profile: { ...request.profile, contextWindowTokens: 100, safetyMarginTokens: 20 },
        policy: { ...request.policy, requestedOutputTokens: 80 },
        messages: [{ role: "user", content: "x".repeat(2_000) }],
      },
    });

    expect(() => engine.accountProviderUsage(started.handle, { inputTokens: 1, outputTokens: 1 })).toThrowError(
      expect.objectContaining({ code: "invalid_lifecycle_transition" }),
    );
    const planned = engine.requestPlan(started.handle);
    expect(planned.diagnostics.planStatus).toBe("rejected");
    expect(planned.diagnostics.planRejectionCode).toBe("current_message_cannot_fit");
    expect(() => engine.accountProviderUsage(started.handle, { inputTokens: 1, outputTokens: 1 })).toThrowError(
      expect.objectContaining({ code: "provider_usage_not_allowed" }),
    );
    const completed = engine.completeTurn(started.handle, { outcome: "rejected", errorCode: "CONTEXT_PLAN_REJECTED" });
    expect(completed.diagnostics).toMatchObject({ outcome: "rejected", completionErrorCode: "CONTEXT_PLAN_REJECTED" });
  });

  it("does not let an observer failure change the lifecycle result", () => {
    const journal = vi.fn(() => {
      throw new Error("observer unavailable");
    });
    const engine = new ContextEngine({ journal });
    const started = engine.startTurn({ turnId: "turn-4", request });
    const planned = engine.requestPlan(started.handle);

    expect(planned.plan.status).toBe("fits");
    expect(journal).toHaveBeenCalledTimes(2);
  });
});
