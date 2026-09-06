import { describe, expect, it, vi } from "vitest";

import {
  PostgresExecutionJournal,
  type ExecutionJournalRead,
  type PendingExecutionJournalEvent,
  type PersistedExecutionJournalEvent,
  type PostgresExecutionJournalStore,
} from "../src/journal";

class FakePostgresJournalStore implements PostgresExecutionJournalStore {
  public readonly persisted: PendingExecutionJournalEvent[] = [];

  public async persist(event: PendingExecutionJournalEvent): Promise<PersistedExecutionJournalEvent> {
    this.persisted.push(event);
    return { ...event, sequence: this.persisted.length };
  }

  public async replay(query: ExecutionJournalRead): Promise<ReadonlyArray<PersistedExecutionJournalEvent>> {
    return this.persisted
      .map((event, index) => ({ ...event, sequence: index + 1 }))
      .filter((event) => query.runId === undefined || event.scope.runId === query.runId)
      .filter((event) => query.afterSequence === undefined || event.sequence > query.afterSequence)
      .slice(0, query.limit);
  }
}

describe("PostgresExecutionJournal", () => {
  it("persists a typed record through the injected store and replays its durable sequence", async () => {
    const store = new FakePostgresJournalStore();
    const journal = new PostgresExecutionJournal(store);

    const appended = await journal.append({
      scope: { runId: "run-1", operationId: "turn-1" },
      event: {
        kind: "tool.invoked",
        data: { toolCallId: "call-1", capability: "booking.list", outcome: "completed" },
      },
      occurredAt: "2026-09-06T12:00:00.000Z",
    });

    expect(store.persisted).toEqual([
      expect.objectContaining({
        id: appended.id,
        occurredAt: "2026-09-06T12:00:00.000Z",
        scope: { runId: "run-1", operationId: "turn-1" },
        event: { kind: "tool.invoked", data: { toolCallId: "call-1", capability: "booking.list", outcome: "completed" } },
      }),
    ]);
    expect(appended.sequence).toBe(1);
    expect(await journal.read({ runId: "run-1" })).toEqual([appended]);
  });

  it("replays only the requested run cursor even when a store returns a broader result", async () => {
    const store = new FakePostgresJournalStore();
    const journal = new PostgresExecutionJournal({
      ...store,
      replay: vi.fn(async () => [
        {
          id: "event-1",
          sequence: 1,
          occurredAt: "2026-09-06T12:00:00.000Z",
          scope: { runId: "run-1" },
          event: { kind: "run.transition", data: { to: "running" } },
        },
        {
          id: "event-2",
          sequence: 2,
          occurredAt: "2026-09-06T12:01:00.000Z",
          scope: { runId: "run-2" },
          event: { kind: "run.transition", data: { to: "running" } },
        },
        {
          id: "event-3",
          sequence: 3,
          occurredAt: "2026-09-06T12:02:00.000Z",
          scope: { runId: "run-1" },
          event: { kind: "run.transition", data: { to: "completed" } },
        },
      ]),
    });

    const replayed = await journal.read({ runId: "run-1", afterSequence: 1 });
    expect(replayed.map((event) => event.id)).toEqual(["event-3"]);
  });

  it("isolates subscriber faults after persistence and keeps healthy subscribers running", async () => {
    const store = new FakePostgresJournalStore();
    const journal = new PostgresExecutionJournal(store);
    const healthy = vi.fn();
    journal.subscribe({}, () => {
      throw new Error("projection failed");
    });
    journal.subscribe({ runId: "run-1" }, healthy);

    const appended = await journal.append({
      scope: { runId: "run-1" },
      event: { kind: "delivery.obligation", data: { deliveryId: "delivery-1", status: "sent", channel: "telegram" } },
    });

    expect(store.persisted).toHaveLength(1);
    expect(healthy).toHaveBeenCalledWith(appended);
  });

  it("rejects a store response that changes the durable event identity", async () => {
    const journal = new PostgresExecutionJournal({
      persist: async (event) => ({ ...event, id: "different-id", sequence: 1 }),
      replay: async () => [],
    });

    await expect(journal.append({
      scope: { runId: "run-1" },
      event: { kind: "run.transition", data: { to: "queued" } },
      occurredAt: "2026-09-06T12:00:00.000Z",
    })).rejects.toThrow("Execution journal store changed the event identity");
  });
});
