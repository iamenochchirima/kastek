import { describe, expect, it, vi } from "vitest";
import { MemoryConsolidationWorker } from "../src/memory/consolidation-worker";
import { extractMemoryCandidates } from "../src/memory/consolidation";
import { MemoryConsolidationJobRepository } from "../src/db/repositories/memory-consolidation-job-repository";
import { MemoryRevisionConsolidationWorker } from "../src/memory/revision-consolidation-worker";

const job = {
  id: "job-worker-loss",
  organization_id: "org-1",
  agent_definition_id: "agent-1",
  agent_version_id: "version-1",
  installation_id: "installation-1",
  conversation_id: "conversation-1",
  trigger_run_id: "run-1",
  extraction_version: "deterministic-v1",
  status: "running" as const,
  attempt_count: 1,
  lease_owner: "worker-1",
  lease_expires_at: null,
  source_message_count: 0,
  candidate_count: 0,
  error: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  completed_at: null,
  flush_reason: "threshold" as const,
  abandonment_count: 0,
  last_abandoned_at: null,
  last_abandoned_by: null,
  last_abandonment_reason: null,
};

const run = {
  organization_id: "org-1",
  agent_definition_id: "agent-1",
  agent_version_id: "version-1",
  installation_id: "installation-1",
  installation_scope_id: "workspace-1",
  conversation_id: "conversation-1",
  created_by: "user-1",
  resolved_model_provider: "test",
  resolved_model: "test-model",
  policy: { memory: { mode: "automatic", maxWritesPerRun: 3 } },
};

const oneCandidateMessage = {
  id: "message-1",
  direction: "inbound" as const,
  content: { text: "I prefer concise updates." },
  created_at: "2026-09-08T00:00:00.000Z",
};

describe("memory worker loss and recovery contracts", () => {
  it("replays a revision after loss immediately after its canonical commit", async () => {
    const jobs = {
      claimDue: vi.fn()
        .mockResolvedValueOnce([{ ...job, lease_owner: "worker-1" }])
        .mockResolvedValueOnce([{ ...job, lease_owner: "worker-2", attempt_count: 2 }]),
      recordEvidenceWindow: vi.fn().mockResolvedValue(true),
      markRetryable: vi.fn().mockResolvedValue("queued"),
      markCompleted: vi.fn().mockResolvedValue(true),
    };
    const revisions = {
      createFact: vi.fn().mockResolvedValue({ id: "fact-1" }),
      appendRevision: vi.fn(),
    };
    const extracted = extractMemoryCandidates([{
      id: oneCandidateMessage.id,
      direction: oneCandidateMessage.direction,
      text: oneCandidateMessage.content.text,
      createdAt: oneCandidateMessage.created_at,
    }]);
    expect(extracted).toHaveLength(1);

    let canonicalCommitObserved = false;
    revisions.appendRevision.mockImplementation(async (_factId: string, input: { idempotencyKey: string }) => {
      if (!canonicalCommitObserved) {
        canonicalCommitObserved = true;
        // The write committed, but the worker lost the response before it could
        // observe the result. A retry must receive the repository's replay.
        throw Object.assign(new Error("worker lost after revision commit"), {
          code: "WORKER_LOST_AFTER_REVISION_COMMIT",
        });
      }
      return { status: "replayed", revision: { id: "revision-1", idempotencyKey: input.idempotencyKey } };
    });

    const dependencies = {
      jobs: jobs as never,
      conversations: { listMessages: vi.fn().mockResolvedValue([oneCandidateMessage]) } as never,
      revisions: revisions as never,
      runs: { getRuntimeRunById: vi.fn().mockResolvedValue(run) } as never,
      extractor: { extract: vi.fn().mockResolvedValue(extracted) },
    };
    const settings = {
      batchSize: 1,
      leaseMs: 120_000,
      pollIntervalMs: 5_000,
      maxAttempts: 5,
      minInboundMessages: 1,
    };

    const crashedWorker = new MemoryRevisionConsolidationWorker({} as never, settings, {
      ...dependencies,
      workerId: "worker-1",
    });
    await expect(crashedWorker.runOnce()).resolves.toBe(1);
    expect(jobs.markRetryable).toHaveBeenCalledWith(expect.objectContaining({
      jobId: job.id,
      workerId: "worker-1",
      errorCode: "WORKER_LOST_AFTER_REVISION_COMMIT",
    }));
    expect(jobs.markCompleted).not.toHaveBeenCalled();

    const successorWorker = new MemoryRevisionConsolidationWorker({} as never, settings, {
      ...dependencies,
      workerId: "worker-2",
    });
    await expect(successorWorker.runOnce()).resolves.toBe(1);

    expect(revisions.createFact).toHaveBeenCalledTimes(2);
    expect(revisions.appendRevision).toHaveBeenCalledTimes(2);
    expect(revisions.appendRevision.mock.calls[0]?.[1].idempotencyKey)
      .toBe(revisions.appendRevision.mock.calls[1]?.[1].idempotencyKey);
    expect(jobs.markCompleted).toHaveBeenCalledWith(expect.objectContaining({
      jobId: job.id,
      workerId: "worker-2",
      sourceMessageCount: 1,
      candidateCount: 1,
    }));
  });

  it("does not duplicate a legacy candidate when a successor fences stale completion", async () => {
    const jobs = {
      claimDue: vi.fn()
        .mockResolvedValueOnce([{ ...job, lease_owner: "worker-1" }])
        .mockResolvedValueOnce([{ ...job, lease_owner: "worker-2", attempt_count: 2 }]),
      markCompleted: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      markRetryable: vi.fn(),
    };
    let candidateCommitted = false;
    const memory = {
      countWritesForRun: vi.fn().mockResolvedValue(0),
      hasConsolidationCandidate: vi.fn().mockImplementation(async () => candidateCommitted),
      createMemory: vi.fn().mockImplementation(async () => {
        candidateCommitted = true;
        return { id: "legacy-memory-1" };
      }),
    };
    const dependencies = {
      jobs: jobs as never,
      conversations: { listMessages: vi.fn().mockResolvedValue([oneCandidateMessage]) } as never,
      memory: memory as never,
      runs: { getRuntimeRunById: vi.fn().mockResolvedValue(run) } as never,
    };
    const settings = {
      batchSize: 1,
      leaseMs: 120_000,
      pollIntervalMs: 5_000,
      maxAttempts: 5,
      minInboundMessages: 1,
    };

    const staleWorker = new MemoryConsolidationWorker({} as never, settings, {
      ...dependencies,
      workerId: "worker-1",
    });
    await expect(staleWorker.runOnce()).resolves.toBe(1);
    expect(jobs.markCompleted).toHaveBeenNthCalledWith(1, expect.objectContaining({
      workerId: "worker-1",
      candidateCount: 1,
    }));
    await expect(jobs.markCompleted.mock.results[0]?.value).resolves.toBe(false);

    const successorWorker = new MemoryConsolidationWorker({} as never, settings, {
      ...dependencies,
      workerId: "worker-2",
    });
    await expect(successorWorker.runOnce()).resolves.toBe(1);

    expect(memory.createMemory).toHaveBeenCalledTimes(1);
    expect(memory.hasConsolidationCandidate).toHaveBeenCalledTimes(2);
    expect(jobs.markCompleted).toHaveBeenNthCalledWith(2, expect.objectContaining({
      workerId: "worker-2",
      sourceMessageCount: 1,
      candidateCount: 0,
    }));
  });

  it("does not write revisions after the lease fence is lost", async () => {
    const jobs = {
      claimDue: vi.fn().mockResolvedValue([{ ...job, lease_owner: "worker-expired" }]),
      recordEvidenceWindow: vi.fn().mockResolvedValue(false),
      markRetryable: vi.fn().mockResolvedValue("queued"),
      markCompleted: vi.fn(),
    };
    const revisions = {
      createFact: vi.fn(),
      appendRevision: vi.fn(),
    };
    const worker = new MemoryRevisionConsolidationWorker({} as never, {
      batchSize: 1,
      leaseMs: 120_000,
      pollIntervalMs: 5_000,
      maxAttempts: 5,
      minInboundMessages: 1,
    }, {
      jobs: jobs as never,
      conversations: { listMessages: vi.fn().mockResolvedValue([oneCandidateMessage]) } as never,
      revisions: revisions as never,
      runs: { getRuntimeRunById: vi.fn().mockResolvedValue(run) } as never,
      workerId: "worker-expired",
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(jobs.markRetryable).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "MEMORY_CONSOLIDATION_LEASE_LOST" }));
    expect(revisions.createFact).not.toHaveBeenCalled();
    expect(revisions.appendRevision).not.toHaveBeenCalled();
    expect(jobs.markCompleted).not.toHaveBeenCalled();
  });

  it("requires an unexpired lease for every owner mutation", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    const repository = new MemoryConsolidationJobRepository(pool as never);

    await repository.markCompleted({ jobId: job.id, workerId: "worker-1", sourceMessageCount: 1, candidateCount: 1 });
    await repository.recordEvidenceWindow({ jobId: job.id, workerId: "worker-1", evidenceDigest: "digest-1" });
    await repository.markRetryable({ jobId: job.id, workerId: "worker-1", maxAttempts: 3, error: { code: "TEST_RETRY" } });

    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(pool.query.mock.calls.every(([sql]) => String(sql).includes("lease_expires_at > now()"))).toBe(true);
  });
});
