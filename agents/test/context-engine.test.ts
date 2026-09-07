import { describe, expect, it, vi } from "vitest";
import { ContextEngine, ContextEngineError, type ContextEngineJournalEvent } from "../src/runtime/context-engine";
import { InMemoryContextEngineStateAdapter } from "../src/runtime/context-engine-state";

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
  it("runs a typed lifecycle with stable, content-free diagnostics", async () => {
    const events: ContextEngineJournalEvent[] = [];
    const engine = new ContextEngine({ journal: (event) => events.push(event) });

    const started = await engine.startTurn({ turnId: "turn-1", request });
    const planned = await engine.requestPlan(started.handle);
    const accounted = await engine.accountProviderUsage(started.handle, { inputTokens: 42, outputTokens: 8, totalTokens: 50 });
    const completed = await engine.completeTurn(started.handle, { outcome: "completed" });

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
    await expect(engine.diagnostics(started.handle)).rejects.toThrowError(ContextEngineError);
  });

  it("keeps plan and usage accounting idempotent for the same lifecycle input", async () => {
    const engine = new ContextEngine();
    const started = await engine.startTurn({ turnId: "turn-2", request });
    const firstPlan = await engine.requestPlan(started.handle);
    const secondPlan = await engine.requestPlan(started.handle);
    const firstUsage = await engine.accountProviderUsage(started.handle, { inputTokens: 20, outputTokens: 5 });
    const secondUsage = await engine.accountProviderUsage(started.handle, { inputTokens: 20, outputTokens: 5 });
    const planAfterUsage = await engine.requestPlan(started.handle);

    expect(secondPlan.diagnostics).toBe(firstPlan.diagnostics);
    expect(planAfterUsage.diagnostics).toBe(firstPlan.diagnostics);
    expect(secondUsage.diagnostics).toBe(firstUsage.diagnostics);
    await expect(engine.accountProviderUsage(started.handle, { inputTokens: 21, outputTokens: 5 })).rejects.toThrowError(
      expect.objectContaining({ code: "provider_usage_already_accounted" }),
    );
  });

  it("prevents invalid lifecycle transitions and keeps a rejected plan explicit", async () => {
    const engine = new ContextEngine();
    const started = await engine.startTurn({
      turnId: "turn-3",
      request: {
        ...request,
        profile: { ...request.profile, contextWindowTokens: 100, safetyMarginTokens: 20 },
        policy: { ...request.policy, requestedOutputTokens: 80 },
        messages: [{ role: "user", content: "x".repeat(2_000) }],
      },
    });

    await expect(engine.accountProviderUsage(started.handle, { inputTokens: 1, outputTokens: 1 })).rejects.toThrowError(
      expect.objectContaining({ code: "invalid_lifecycle_transition" }),
    );
    const planned = await engine.requestPlan(started.handle);
    expect(planned.diagnostics.planStatus).toBe("rejected");
    expect(planned.diagnostics.planRejectionCode).toBe("current_message_cannot_fit");
    await expect(engine.accountProviderUsage(started.handle, { inputTokens: 1, outputTokens: 1 })).rejects.toThrowError(
      expect.objectContaining({ code: "provider_usage_not_allowed" }),
    );
    const completed = await engine.completeTurn(started.handle, { outcome: "rejected", errorCode: "CONTEXT_PLAN_REJECTED" });
    expect(completed.diagnostics).toMatchObject({ outcome: "rejected", completionErrorCode: "CONTEXT_PLAN_REJECTED" });
  });

  it("does not let an observer failure change the lifecycle result", async () => {
    const journal = vi.fn(() => {
      throw new Error("observer unavailable");
    });
    const engine = new ContextEngine({ journal });
    const started = await engine.startTurn({ turnId: "turn-4", request });
    const planned = await engine.requestPlan(started.handle);

    expect(planned.plan.status).toBe("fits");
    expect(journal).toHaveBeenCalledTimes(2);
  });

  it("reloads an active lifecycle from the state adapter without replaying transitions", async () => {
    const state = new InMemoryContextEngineStateAdapter();
    const firstEvents: ContextEngineJournalEvent[] = [];
    const first = new ContextEngine({ state, journal: (event) => firstEvents.push(event) });
    const started = await first.startTurn({ turnId: "durable-turn", request });
    const planned = await first.requestPlan(started.handle);

    const resumedEvents: ContextEngineJournalEvent[] = [];
    const resumed = new ContextEngine({ state, journal: (event) => resumedEvents.push(event) });
    const replayedPlan = await resumed.requestPlan({ turnId: "durable-turn" });
    const replayedDiagnostics = await resumed.diagnostics({ turnId: "durable-turn" });

    expect(replayedPlan.plan).toEqual(planned.plan);
    expect(replayedDiagnostics.phase).toBe("planned");
    expect(replayedDiagnostics.eventSequence).toBe(1);
    expect(resumedEvents).toEqual([]);

    const usage = await resumed.accountProviderUsage({ turnId: "durable-turn" }, { inputTokens: 20, outputTokens: 5 });
    expect(usage.accounting.status).toBe("accepted");
    await resumed.completeTurn({ turnId: "durable-turn" }, { outcome: "completed" });
    await expect(new ContextEngine({ state }).diagnostics({ turnId: "durable-turn" })).rejects.toMatchObject({ code: "turn_not_found" });
    expect(firstEvents.map((event) => event.lifecycle)).toEqual(["turn_start", "request_plan"]);
  });

  it("uses the adapter's atomic create to reject a duplicate start across engine instances", async () => {
    const state = new InMemoryContextEngineStateAdapter();
    const first = new ContextEngine({ state });
    const second = new ContextEngine({ state });

    await first.startTurn({ turnId: "duplicate-turn", request });
    await expect(second.startTurn({ turnId: "duplicate-turn", request })).rejects.toMatchObject({
      code: "turn_already_started",
    });
  });
});
