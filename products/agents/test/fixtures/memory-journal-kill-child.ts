import { Pool } from "pg";
import { RunRepository } from "../../src/db/repositories/run-repository";
import { PostgresExecutionJournal, RunRepositoryExecutionJournalStore } from "../../src/journal";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const organizationId = process.env.MEMORY_KILL_ORGANIZATION_ID;
const installationId = process.env.MEMORY_KILL_INSTALLATION_ID;
const runId = process.env.MEMORY_KILL_RUN_ID;

if (!databaseUrl || !organizationId || !installationId || !runId) {
  throw new Error("MEMORY_KILL_FIXTURE_CONFIGURATION_REQUIRED");
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const runs = new RunRepository(pool);
  const store = new RunRepositoryExecutionJournalStore(runs);
  let admitted = false;

  const journal = new PostgresExecutionJournal({
    persist: async (event) => {
      const persisted = await store.persist(event);
      if (!admitted) {
        admitted = true;
        process.send?.({ type: "journal-admitted", sequence: persisted.sequence, eventId: persisted.id });
      }
      return persisted;
    },
    replay: query => store.replay(query),
  }, [async () => new Promise<void>(() => {
    // Hold the observer open. The parent kills this process after the journal
    // transaction has committed, before the memory observer can run.
  })]);

  await journal.append({
    scope: { organizationId, installationId, runId, operationId: "process-kill-boundary" },
    event: { kind: "run.transition", data: { to: "running" } },
  });

  // The observer intentionally prevents a normal exit. The parent terminates
  // this child after receiving journal-admitted over IPC.
  await new Promise<void>(() => undefined);
}

void main().catch(error => {
  process.send?.({ type: "child-error", error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
