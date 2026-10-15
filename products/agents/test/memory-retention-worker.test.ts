import { describe, expect, it, vi } from "vitest";
import { MemoryRetentionWorker, maintenanceRetryDelayMs } from "../src/memory/retention-worker";

const job = {
  id: "maintenance-1",
  organization_id: "org-1",
  workspace_id: "workspace-1",
  job_type: "revalidation" as const,
  status: "running" as const,
  next_run_at: new Date().toISOString(),
  attempt_count: 1,
  lease_owner: "worker-1",
  lease_expires_at: null,
  last_error_code: null,
  last_completed_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const candidate = {
  organizationId: "org-1",
  workspaceId: "workspace-1",
  agentDefinitionId: "agent-1",
  installationId: "installation-1",
  namespace: "agent_private" as const,
  memoryType: "semantic" as const,
  revisionId: "revision-1",
  factId: "fact-1",
  factKey: "fact-key",
  subjectKey: "subject",
  predicateKey: "preference",
  canonicalText: "The customer prefers concise replies.",
  lifecycleState: "active" as const,
  transitionType: "assertion" as const,
  validFrom: "2025-01-01T00:00:00.000Z",
  observedAt: "2025-01-01T00:00:00.000Z",
  typedValue: { value: "concise" },
  participants: [],
  sourceTrust: "user_explicit" as const,
  sensitivity: "normal" as const,
  provenance: {},
  evidenceDigest: "digest",
  extractionVersion: "v1",
  sourceEventIds: ["event-1"],
  usageCount: 0,
  confirmations: 0,
  corrections: 0,
  rejections: 0,
  helpfulness: 0,
};

const settings = {
  batchSize: 10,
  leaseMs: 120_000,
  pollIntervalMs: 5_000,
  maxAttempts: 3,
  retryBaseDelayMs: 2_000,
  retryMaxDelayMs: 300_000,
  retentionIntervalMs: 3_600_000,
  revalidationIntervalMs: 900_000,
  conflictIntervalMs: 300_000,
  candidateBatchSize: 100,
};

describe("memory retention worker", () => {
  it("queues stale revisions into durable revalidation jobs", async () => {
    const repository = {
      ensureMaintenanceJobs: vi.fn(),
      claimMaintenanceJobs: vi.fn().mockResolvedValue([job]),
      listCurrentCandidates: vi.fn().mockResolvedValue([candidate]),
      getOrganizationDefaults: vi.fn().mockResolvedValue({ memoryDays: 365, revalidateAfterDays: 30, revision: 1 }),
      listRules: vi.fn().mockResolvedValue([]),
      enqueueRevalidation: vi.fn().mockResolvedValue("created"),
      markMaintenanceCompleted: vi.fn().mockResolvedValue(true),
      markMaintenanceRetryable: vi.fn(),
    };
    const worker = new MemoryRetentionWorker({} as never, settings, { repository: repository as never, revisions: {} as never, workerId: "worker-1", now: () => new Date("2026-01-01T00:00:00.000Z") });
    await expect(worker.runOnce()).resolves.toBe(1);
    expect(repository.enqueueRevalidation).toHaveBeenCalledWith(expect.objectContaining({ candidate, reason: "stale" }));
    expect(repository.markMaintenanceCompleted).toHaveBeenCalledWith(expect.objectContaining({ jobId: "maintenance-1", workerId: "worker-1" }));
  });

  it("detects and records conflicts without exposing them as retrieval-ready state", async () => {
    const second = { ...candidate, revisionId: "revision-2", factId: "fact-2", canonicalText: "The customer prefers detailed replies.", transitionType: "assertion" as const };
    const conflictJob = { ...job, job_type: "conflict" as const };
    const repository = {
      ensureMaintenanceJobs: vi.fn(),
      claimMaintenanceJobs: vi.fn().mockResolvedValue([conflictJob]),
      listCurrentCandidates: vi.fn().mockResolvedValue([candidate, second]),
      recordConflict: vi.fn().mockResolvedValue("created"),
      markMaintenanceCompleted: vi.fn().mockResolvedValue(true),
      markMaintenanceRetryable: vi.fn(),
    };
    const worker = new MemoryRetentionWorker({} as never, settings, { repository: repository as never, revisions: {} as never, workerId: "worker-1" });
    await expect(worker.runOnce()).resolves.toBe(1);
    expect(repository.recordConflict).toHaveBeenCalled();
    expect(repository.markMaintenanceCompleted).toHaveBeenCalled();
  });

  it("uses bounded exponential maintenance retry delays", () => {
    expect(maintenanceRetryDelayMs(1, 2_000, 10_000)).toBe(2_000);
    expect(maintenanceRetryDelayMs(3, 2_000, 10_000)).toBe(8_000);
    expect(maintenanceRetryDelayMs(6, 2_000, 10_000)).toBe(10_000);
  });

  it("bounds shutdown while a maintenance scan is still in flight", async () => {
    let releaseScan!: () => void;
    const scanPending = new Promise<void>((resolve) => { releaseScan = resolve; });
    const repository = {
      ensureMaintenanceJobs: vi.fn().mockResolvedValue(undefined),
      claimMaintenanceJobs: vi.fn().mockResolvedValue([{ ...job, job_type: "conflict" as const }]),
      listCurrentCandidates: vi.fn(async () => {
        await scanPending;
        return [];
      }),
      markMaintenanceCompleted: vi.fn().mockResolvedValue(true),
      markMaintenanceRetryable: vi.fn(),
    };
    const worker = new MemoryRetentionWorker({} as never, settings, {
      repository: repository as never,
      revisions: {} as never,
      workerId: "worker-1",
    });

    const run = worker.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(worker.shutdown(5)).resolves.toEqual({ drained: false });
    releaseScan();
    await expect(run).resolves.toBe(1);
  });
});
