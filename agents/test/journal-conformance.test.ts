import { describe, expect, it, vi } from "vitest";
import { InMemoryExecutionJournal, type ExecutionJournalEventInput } from "../src/journal";

const scope = { runId: "run-1", operationId: "turn-1", correlationId: "corr-1" } as const;

function event(input: ExecutionJournalEventInput["event"]): ExecutionJournalEventInput {
  return { scope, event: input, occurredAt: "2026-09-06T10:00:00.000Z" };
}

describe("execution journal conformance", () => {
  it("persists every lifecycle category in monotonic order", async () => {
    const journal = new InMemoryExecutionJournal();
    const inputs: ExecutionJournalEventInput[] = [
      event({ kind: "run.transition", data: { to: "running" } }),
      event({ kind: "context.assembled", data: { contextId: "context-1", messageCount: 3, tokenCount: 420, compacted: false } }),
      event({ kind: "model.completed", data: { modelCallId: "model-1", provider: "openai", model: "gpt-5", inputTokens: 420, outputTokens: 91 } }),
      event({ kind: "tool.invoked", data: { toolCallId: "tool-1", capability: "booking.list", outcome: "completed" } }),
      event({ kind: "operation.waiting", data: { reason: "approval", resumeKey: "approval-1" } }),
      event({ kind: "effect.uncertain", data: { effectId: "effect-1", capability: "post.publish", reason: "provider timeout", reconciliationRequired: true } }),
      event({ kind: "delivery.obligation", data: { deliveryId: "delivery-1", status: "queued", channel: "whatsapp" } }),
    ];

    for (const input of inputs) await journal.append(input);

    const persisted = await journal.read({ runId: "run-1" });
    expect(persisted.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(persisted.map((item) => item.event.kind)).toEqual(inputs.map((item) => item.event.kind));
    expect(persisted.every((item) => item.id.length > 0)).toBe(true);
  });

  it("reads a run-scoped cursor without leaking other runs", async () => {
    const journal = new InMemoryExecutionJournal();
    const first = await journal.append(event({ kind: "run.transition", data: { to: "queued" } }));
    await journal.append({ scope: { runId: "run-2" }, event: { kind: "run.transition", data: { to: "running" } } });
    await journal.append(event({ kind: "run.transition", data: { from: "queued", to: "running" } }));

    const later = await journal.read({ runId: "run-1", afterSequence: first.sequence });
    expect(later).toHaveLength(1);
    expect(later[0]?.event).toEqual({ kind: "run.transition", data: { from: "queued", to: "running" } });
  });

  it("notifies only matching future events and supports unsubscribe", async () => {
    const journal = new InMemoryExecutionJournal();
    const listener = vi.fn();
    const unsubscribe = journal.subscribe({ runId: "run-1" }, listener);

    await journal.append({ scope: { runId: "run-2" }, event: { kind: "run.transition", data: { to: "running" } } });
    await journal.append(event({ kind: "delivery.obligation", data: { deliveryId: "delivery-1", status: "sent", channel: "telegram" } }));
    unsubscribe();
    await journal.append(event({ kind: "run.transition", data: { to: "completed" } }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ scope: { runId: "run-1" }, event: { kind: "delivery.obligation" } });
  });

  it("isolates a failing subscriber from durable append and other projections", async () => {
    const journal = new InMemoryExecutionJournal();
    const healthy = vi.fn();
    journal.subscribe({}, () => { throw new Error("projection failed"); });
    journal.subscribe({}, healthy);

    const appended = await journal.append(event({ kind: "run.transition", data: { to: "failed", reason: "MODEL_TOKEN_BUDGET_EXCEEDED" } }));

    expect(appended.sequence).toBe(1);
    expect(healthy).toHaveBeenCalledWith(appended);
    expect(await journal.read()).toEqual([appended]);
  });
});
