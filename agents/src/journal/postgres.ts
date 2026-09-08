import { randomUUID } from "node:crypto";

import {
  type ExecutionJournal,
  type ExecutionJournalEventInput,
  type ExecutionJournalListener,
  type ExecutionJournalRead,
  type PersistedExecutionJournalEvent,
} from "./contracts";

/**
 * The data passed to the PostgreSQL persistence boundary before its durable
 * sequence has been allocated. A concrete store can map this directly to an
 * INSERT ... RETURNING sequence_number statement, without exposing a database
 * client to the runtime layer.
 */
export interface PendingExecutionJournalEvent extends ExecutionJournalEventInput {
  readonly id: string;
  readonly occurredAt: string;
}

/**
 * Minimal persistence boundary for the PostgreSQL journal adapter.
 *
 * The application-specific implementation may delegate to RunRepository, but
 * the journal does not depend on that repository or on PostgreSQL types. The
 * store must allocate a durable sequence when it persists an event and replay
 * events in ascending sequence order.
 */
export interface PostgresExecutionJournalStore {
  persist(event: PendingExecutionJournalEvent): Promise<PersistedExecutionJournalEvent>;
  replay(query: ExecutionJournalRead): Promise<ReadonlyArray<PersistedExecutionJournalEvent>>;
}

interface Subscription {
  readonly query: ExecutionJournalRead;
  readonly listener: ExecutionJournalListener;
}

/**
 * Durable execution journal backed by a PostgreSQL-oriented persistence
 * boundary. Persistence succeeds before projections are notified, so a broken
 * subscriber cannot turn a recorded execution fact into a failed operation.
 */
export class PostgresExecutionJournal implements ExecutionJournal {
  private readonly subscriptions = new Set<Subscription>();

  public constructor(
    private readonly store: PostgresExecutionJournalStore,
    private readonly durableObservers: readonly ExecutionJournalListener[] = [],
  ) {}

  public async append(input: ExecutionJournalEventInput): Promise<PersistedExecutionJournalEvent> {
    const pending: PendingExecutionJournalEvent = {
      ...input,
      id: randomUUID(),
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    };
    const persisted = await this.store.persist(pending);
    assertPersistedEventMatches(pending, persisted);

    await Promise.allSettled([
      ...this.durableObservers.map((listener) => Promise.resolve().then(() => listener(persisted))),
      ...[...this.subscriptions]
        .filter((subscription) => matches(subscription.query, persisted))
        .map((subscription) => Promise.resolve().then(() => subscription.listener(persisted))),
    ]);
    return persisted;
  }

  public async read(query: ExecutionJournalRead): Promise<ReadonlyArray<PersistedExecutionJournalEvent>> {
    const replayed = await this.store.replay(query);
    return replayed.filter((event) => matches(query, event));
  }

  public subscribe(query: ExecutionJournalRead, listener: ExecutionJournalListener): () => void {
    const subscription: Subscription = { query, listener };
    this.subscriptions.add(subscription);
    return () => this.subscriptions.delete(subscription);
  }
}

function matches(query: ExecutionJournalRead, event: PersistedExecutionJournalEvent): boolean {
  if (event.scope.organizationId !== query.organizationId || event.scope.runId !== query.runId) return false;
  if (query.afterSequence !== undefined && event.sequence <= query.afterSequence) return false;
  return true;
}

function assertPersistedEventMatches(
  pending: PendingExecutionJournalEvent,
  persisted: PersistedExecutionJournalEvent,
): void {
  if (persisted.id !== pending.id || persisted.occurredAt !== pending.occurredAt) {
    throw new Error("Execution journal store changed the event identity");
  }
  if (!Number.isSafeInteger(persisted.sequence) || persisted.sequence < 1) {
    throw new Error("Execution journal store returned an invalid durable sequence");
  }
}
