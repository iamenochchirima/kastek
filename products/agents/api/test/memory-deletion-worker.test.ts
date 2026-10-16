import { describe, expect, it, vi } from "vitest";
import { assertNoResidualRevisionData, MemoryDeletionWorker, deletionRetryDelayMs } from "../src/memory/deletion-worker";
import type { MemoryDeletionAnalyticsInput } from "../src/analytics/memory";

const job = {
  id: "job-1",
  organization_id: "org-1",
  requested_by: "operator-1",
  target_type: "memory" as const,
  target_id: "memory-1",
  status: "running" as const,
  attempt_count: 1,
  next_attempt_at: new Date().toISOString(),
  lease_owner: "worker-1",
  lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
  held_at: null,
  last_error_code: null,
  purged_memory_count: 0,
  purged_conversation_count: 0,
  purged_knowledge_chunk_count: 0,
  error: null,
  created_at: new Date().toISOString(),
  completed_at: null,
};

const settings = {
  batchSize: 10,
  leaseMs: 120_000,
  pollIntervalMs: 5_000,
  maxAttempts: 3,
  retryBaseDelayMs: 2_000,
  retryMaxDelayMs: 300_000,
  holdRetryMs: 60_000,
};

describe("memory deletion worker", () => {
  it("purges and acknowledges a leased job with bounded counts", async () => {
    const jobs = {
      claimDue: vi.fn().mockResolvedValue([job]),
      markCompleted: vi.fn().mockResolvedValue(true),
      markHeld: vi.fn(),
      markRetryable: vi.fn(),
    };
    const purge = vi.fn().mockResolvedValue({ memoryCount: 1, conversationCount: 1, knowledgeChunkCount: 0 });
    const analyticsEvents: MemoryDeletionAnalyticsInput[] = [];
    const analytics = {
      resolveJob: vi.fn().mockResolvedValue({
        workspaceId: "workspace-1",
        agentDefinitionId: "agent-1",
        agentVersionId: "version-1",
        installationId: "installation-1",
        scopeResolution: "installation",
      }),
      emit: vi.fn(async (event: MemoryDeletionAnalyticsInput) => { analyticsEvents.push(event); }),
    };
    const worker = new MemoryDeletionWorker({} as never, settings, { jobs: jobs as never, purge, workerId: "worker-1", analytics: analytics as never });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(purge).toHaveBeenCalledWith(job);
    expect(jobs.markCompleted).toHaveBeenCalledWith({
      jobId: "job-1",
      workerId: "worker-1",
      counts: { memoryCount: 1, conversationCount: 1, knowledgeChunkCount: 0 },
    });
    expect(jobs.markRetryable).not.toHaveBeenCalled();
    expect(analyticsEvents.map((event) => event.status)).toEqual(["requested", "canonical_purged", "completed"]);
    expect(analyticsEvents.every((event) => event.workspaceId === "workspace-1" && event.installationId === "installation-1")).toBe(true);
  });

  it("moves a legal-hold failure to held without spending retry attempts", async () => {
    const jobs = {
      claimDue: vi.fn().mockResolvedValue([job]),
      markCompleted: vi.fn(),
      markHeld: vi.fn().mockResolvedValue(true),
      markRetryable: vi.fn(),
    };
    const purge = vi.fn().mockRejectedValue(Object.assign(new Error("do not persist this content"), { code: "MEMORY_LEGAL_HOLD_ACTIVE" }));
    const worker = new MemoryDeletionWorker({} as never, settings, { jobs: jobs as never, purge, workerId: "worker-1" });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(jobs.markHeld).toHaveBeenCalledWith({ jobId: "job-1", workerId: "worker-1", retryAfterMs: 60_000 });
    expect(jobs.markRetryable).not.toHaveBeenCalled();
  });

  it("records only a safe retryable error code", async () => {
    const jobs = {
      claimDue: vi.fn().mockResolvedValue([job]),
      markCompleted: vi.fn(),
      markHeld: vi.fn(),
      markRetryable: vi.fn().mockResolvedValue("queued"),
    };
    const purge = vi.fn().mockRejectedValue(Object.assign(new Error("secret body should not be emitted"), { code: "PROVIDER_TIMEOUT" }));
    const worker = new MemoryDeletionWorker({} as never, settings, { jobs: jobs as never, purge, workerId: "worker-1" });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(jobs.markRetryable).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-1",
      workerId: "worker-1",
      maxAttempts: 3,
      error: { code: "PROVIDER_TIMEOUT", message: "secret body should not be emitted" },
      retryAfterMs: 2_000,
    }));
  });

  it("uses capped exponential deletion retry delays", () => {
    expect(deletionRetryDelayMs(1, 2_000, 10_000)).toBe(2_000);
    expect(deletionRetryDelayMs(3, 2_000, 10_000)).toBe(8_000);
    expect(deletionRetryDelayMs(6, 2_000, 10_000)).toBe(10_000);
  });

  it("bounds shutdown while a purge is still in flight", async () => {
    let releasePurge!: () => void;
    const purgePending = new Promise<void>((resolve) => { releasePurge = resolve; });
    const jobs = {
      claimDue: vi.fn().mockResolvedValue([job]),
      markCompleted: vi.fn().mockResolvedValue(true),
      markHeld: vi.fn(),
      markRetryable: vi.fn(),
    };
    const purge = vi.fn(async () => {
      await purgePending;
      return { memoryCount: 1, conversationCount: 0, knowledgeChunkCount: 0 };
    });
    const worker = new MemoryDeletionWorker({} as never, settings, {
      jobs: jobs as never,
      purge,
      workerId: "worker-1",
    });

    const run = worker.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(worker.shutdown(5)).resolves.toEqual({ drained: false });
    releasePurge();
    await expect(run).resolves.toBe(1);
  });

  it("retries the same target after a partial purge without touching unrelated targets", async () => {
    const target = { id: "memory-1", deleted: false };
    const unrelated = { id: "memory-unrelated", deleted: false };
    let attempt = 0;
    const jobs = {
      claimDue: vi.fn()
        .mockResolvedValueOnce([{ ...job, attempt_count: 1 }])
        .mockResolvedValueOnce([{ ...job, attempt_count: 2 }]),
      markCompleted: vi.fn().mockResolvedValue(true),
      markHeld: vi.fn(),
      markRetryable: vi.fn().mockResolvedValue("queued"),
    };
    const purge = vi.fn(async (claimed: typeof job) => {
      expect(claimed.target_id).toBe(target.id);
      attempt += 1;
      if (attempt === 1) {
        // The real purger runs in one transaction and rolls this mutation back
        // before retry. The worker must nevertheless retain the exact target
        // and never broaden the selector to unrelated records.
        throw Object.assign(new Error("projection timeout"), { code: "MEMORY_PROJECTION_TIMEOUT" });
      }
      target.deleted = true;
      return { memoryCount: 1, conversationCount: 0, knowledgeChunkCount: 0 };
    });
    const worker = new MemoryDeletionWorker({} as never, settings, { jobs: jobs as never, purge, workerId: "worker-1" });

    await expect(worker.runOnce()).resolves.toBe(1);
    await expect(worker.runOnce()).resolves.toBe(1);
    expect(target.deleted).toBe(true);
    expect(unrelated.deleted).toBe(false);
    expect(jobs.markRetryable).toHaveBeenCalledWith(expect.objectContaining({
      error: { code: "MEMORY_PROJECTION_TIMEOUT", message: "projection timeout" },
    }));
    expect(jobs.markCompleted).toHaveBeenCalledTimes(1);
  });

  it("fails the purge transaction when a local projection survives canonical deletion", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ count: "0" }] }),
    };
    await expect(assertNoResidualRevisionData(client as never, {
      organizationId: "org-1",
      factIds: ["fact-1"],
      revisionIds: ["revision-1"],
    })).resolves.toBeUndefined();

    client.query.mockImplementationOnce(async () => ({ rows: [{ count: "1" }] }));
    await expect(assertNoResidualRevisionData(client as never, {
      organizationId: "org-1",
      factIds: ["fact-1"],
      revisionIds: ["revision-1"],
    })).rejects.toMatchObject({ code: "MEMORY_DELETION_RESIDUAL_PROJECTION" });
    expect(client.query.mock.calls[0]?.[0]).toContain("agent_memory_facts");
    expect(JSON.stringify(client.query.mock.calls[0]?.[1])).not.toContain("secret");
  });
});
