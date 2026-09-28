import {
  createExecutionJournalEvent,
  type ExecutionJournal,
  type ExecutionJournalEventInput,
  type ExecutionJournalListener,
  type ExecutionJournalRead,
  type PersistedExecutionJournalEvent,
} from "./contracts";

interface Subscription {
  readonly query: ExecutionJournalRead;
  readonly listener: ExecutionJournalListener;
}

/**
 * A deterministic adapter for journal conformance tests and local callers.
 * Subscriber failures are intentionally isolated: evidence was already
 * appended and one broken projection must not block later subscribers.
 */
export class InMemoryExecutionJournal implements ExecutionJournal {
  private readonly events: PersistedExecutionJournalEvent[] = [];
  private readonly subscriptions = new Set<Subscription>();
  private nextSequence = 1;

  public async append(input: ExecutionJournalEventInput): Promise<PersistedExecutionJournalEvent> {
    const event = createExecutionJournalEvent(input, this.nextSequence++);
    this.events.push(event);
    await Promise.allSettled(
      [...this.subscriptions]
        .filter((subscription) => matches(subscription.query, event))
        .map((subscription) => Promise.resolve().then(() => subscription.listener(event))),
    );
    return event;
  }

  public async read(query: ExecutionJournalRead): Promise<ReadonlyArray<PersistedExecutionJournalEvent>> {
    const limit = query.limit === undefined ? undefined : Math.max(0, query.limit);
    return this.events
      .filter((event) => matches(query, event))
      .slice(0, limit);
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
