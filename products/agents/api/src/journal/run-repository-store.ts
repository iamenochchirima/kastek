import type { RunRepository } from "../db/repositories/run-repository";
import type { ExecutionJournalRead, PersistedExecutionJournalEvent } from "./contracts";
import type { PendingExecutionJournalEvent, PostgresExecutionJournalStore } from "./postgres";

/**
 * Concrete PostgreSQL store for the journal. Keeping this adapter at the
 * composition edge prevents the harness from importing a database repository.
 */
export class RunRepositoryExecutionJournalStore implements PostgresExecutionJournalStore {
  public constructor(private readonly runs: RunRepository) {}

  public persist(event: PendingExecutionJournalEvent): Promise<PersistedExecutionJournalEvent> {
    return this.runs.appendJournalEvent(event);
  }

  public replay(query: ExecutionJournalRead): Promise<ReadonlyArray<PersistedExecutionJournalEvent>> {
    return this.runs.listJournalEvents(
      query.organizationId,
      query.runId,
      query.afterSequence ?? 0,
      query.limit ?? 200,
    );
  }
}
