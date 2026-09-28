import { describe, expect, it } from "vitest";
import {
  ContextAttemptBudgetExhaustedError,
  InMemoryContextAttemptBudget,
  type ContextAttemptBudgetRequest,
} from "../src/runtime/context-attempt-budget";

const request = (overrides: Partial<ContextAttemptBudgetRequest> = {}): ContextAttemptBudgetRequest => ({
  budgetId: "run-budget:run-1:turn-1",
  runId: "run-1",
  turnId: "turn-1",
  operationKey: "context:run-1:turn-1:compaction:1",
  kind: "proactive_compaction",
  ...overrides,
});

describe("context attempt budget contract", () => {
  it("reserves once and replays the same receipt for a stable operation key", async () => {
    const budget = new InMemoryContextAttemptBudget({ maxAttempts: 2 });

    const first = await budget.reserve(request());
    const replay = await budget.reserve(request());

    expect(first.status).toBe("reserved");
    expect(replay).toEqual({ ...first, status: "replayed" });
    expect(first.status === "reserved" && replay.status === "replayed" && first.receipt.attemptNumber === replay.receipt.attemptNumber).toBe(true);
    expect(budget.snapshot()).toMatchObject({ reservedAttempts: 1, consumedAttempts: 0, remainingAttempts: 1 });
  });

  it("consumes a reservation once and replays both consume and recovery reads", async () => {
    const budget = new InMemoryContextAttemptBudget({ maxAttempts: 2 });
    const reserved = await budget.reserve(request());

    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") return;

    const consumed = await budget.consume(reserved.receipt);
    const consumeReplay = await budget.consume(reserved.receipt);
    const recoveryReplay = await budget.replay({
      budgetId: reserved.receipt.budgetId,
      operationKey: reserved.receipt.operationKey,
    });

    expect(consumed.status).toBe("consumed");
    expect(consumeReplay).toEqual({ ...consumed, status: "replayed" });
    expect(recoveryReplay).toEqual({ ...consumed, status: "replayed" });
    expect(budget.snapshot()).toMatchObject({ reservedAttempts: 1, consumedAttempts: 1, remainingAttempts: 1 });
  });

  it("shares one bound across compaction, overflow recovery, retries, and worker replacement", async () => {
    const budget = new InMemoryContextAttemptBudget({ maxAttempts: 4 });
    const kinds = [
      "proactive_compaction",
      "overflow_recovery",
      "provider_retry",
      "worker_replacement",
    ] as const;

    for (const [index, kind] of kinds.entries()) {
      const result = await budget.reserve(request({ operationKey: `context:run-1:turn-1:${kind}:${index + 1}`, kind }));
      expect(result.status).toBe("reserved");
    }

    const exhausted = await budget.reserve(request({ operationKey: "context:run-1:turn-1:provider-retry:5", kind: "provider_retry" }));

    expect(exhausted).toMatchObject({
      status: "exhausted",
      outcome: {
        code: "CONTEXT_ATTEMPT_BUDGET_EXHAUSTED",
        budgetId: "run-budget:run-1:turn-1",
        maxAttempts: 4,
        attemptedAttempts: 4,
      },
    });
  });

  it("does not spend a slot when a worker replays an already admitted operation", async () => {
    const budget = new InMemoryContextAttemptBudget({ maxAttempts: 1 });
    const first = await budget.reserve(request({ operationKey: "context:worker-loss:1", kind: "provider_retry" }));
    const replacement = await budget.reserve(request({ operationKey: "context:worker-loss:1", kind: "worker_replacement" }));

    expect(first.status).toBe("reserved");
    expect(replacement.status).toBe("replayed");
    expect(budget.snapshot()).toMatchObject({ reservedAttempts: 1, remainingAttempts: 0 });
  });

  it("returns a typed exhausted outcome without throwing", async () => {
    const budget = new InMemoryContextAttemptBudget({ maxAttempts: 1 });
    await budget.reserve(request());

    const result = await budget.reserve(request({ operationKey: "context:run-1:turn-1:overflow:2", kind: "overflow_recovery" }));

    expect(result.status).toBe("exhausted");
    if (result.status !== "exhausted") return;
    expect(result.outcome).toBeInstanceOf(ContextAttemptBudgetExhaustedError);
    expect(result.outcome.code).toBe("CONTEXT_ATTEMPT_BUDGET_EXHAUSTED");
    expect(result.outcome.retryable).toBe(false);
  });

  it("rejects a stable key reused with a different operation identity", async () => {
    const budget = new InMemoryContextAttemptBudget({ maxAttempts: 2 });
    await budget.reserve(request());

    await expect(budget.reserve(request({ turnId: "turn-2" }))).rejects.toMatchObject({
      code: "CONTEXT_ATTEMPT_OPERATION_CONFLICT",
    });
  });
});
