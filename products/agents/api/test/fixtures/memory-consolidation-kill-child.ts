import { Pool } from "pg";
import { ConversationRepository } from "../../src/db/repositories/conversation-repository";
import { MemoryConsolidationJobRepository } from "../../src/db/repositories/memory-consolidation-job-repository";
import { MemoryRevisionRepository } from "../../src/db/repositories/memory-revision-repository";
import { MemoryRevisionConsolidationWorker } from "../../src/memory/revision-consolidation-worker";
import { RunRepository } from "../../src/db/repositories/run-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const organizationId = process.env.MEMORY_KILL_ORGANIZATION_ID;
const workerId = process.env.MEMORY_KILL_WORKER_ID ?? "memory-kill-worker";

if (!databaseUrl || !organizationId) throw new Error("MEMORY_CONSOLIDATION_KILL_FIXTURE_CONFIGURATION_REQUIRED");

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const baseRevisions = new MemoryRevisionRepository(pool);
  let signalled = false;
  const revisions = {
    createFact: (input: Parameters<MemoryRevisionRepository["createFact"]>[0]) => baseRevisions.createFact(input),
    appendRevision: async (...args: Parameters<MemoryRevisionRepository["appendRevision"]>) => {
      const result = await baseRevisions.appendRevision(...args);
      if (!signalled) {
        signalled = true;
        process.send?.({ type: "revision-committed" });
        // Keep the lease owner between the canonical revision commit and the
        // job completion mutation. The parent kills this process to exercise
        // successor fencing and idempotent revision replay.
        await new Promise<void>(() => undefined);
      }
      return result;
    },
  };
  const worker = new MemoryRevisionConsolidationWorker(pool, {
    batchSize: 1,
    leaseMs: 500,
    pollIntervalMs: 5_000,
    maxAttempts: 5,
    minInboundMessages: 1,
    extractionTimeoutMs: 2_000,
  }, {
    workerId,
    jobs: new MemoryConsolidationJobRepository(pool),
    conversations: new ConversationRepository(pool),
    revisions,
    runs: new RunRepository(pool),
  });
  await worker.runOnce(organizationId);
}

void main().catch(error => {
  process.send?.({ type: "child-error", error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
