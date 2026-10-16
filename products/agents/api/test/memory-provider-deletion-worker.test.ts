import { describe, expect, it, vi } from "vitest";
import { MemoryProviderDeletionWorker, memoryProviderDeletionRetryDelay } from "../src/memory/provider-deletion-worker";
import type { MemoryDeletionAnalyticsInput } from "../src/analytics/memory";

const job = {
  id: "provider-job-1",
  deletionJobId: "delete-job-1",
  organizationId: "org-1",
  workspaceId: "workspace-1",
  installationId: "installation-1",
  providerName: "provider-a",
  providerRecordId: "remote-1",
  contentDigest: "digest-1",
  operationId: "delete-op-1",
  status: "running" as const,
  attemptCount: 1,
  maxAttempts: 3,
  nextAttemptAt: new Date().toISOString(),
  leaseOwner: "worker-1",
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  lastErrorCode: null,
  acceptedAt: new Date().toISOString(),
  completedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const settings = {
  batchSize: 10,
  leaseMs: 120_000,
  pollIntervalMs: 5_000,
  maxAttempts: 3,
  retryBaseDelayMs: 2_000,
  retryMaxDelayMs: 30_000,
};

describe("memory provider deletion worker", () => {
  it("deletes remotely, then confirms the parent deletion job", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      markCompleted: vi.fn().mockResolvedValue(true),
      markDeletionJobProviderPendingComplete: vi.fn().mockResolvedValue(true),
      markRetryable: vi.fn(),
    };
    const adapter = { providerName: "provider-a", delete: vi.fn().mockResolvedValue(undefined) };
    const analyticsEvents: MemoryDeletionAnalyticsInput[] = [];
    const analytics = {
      resolveProviderJob: vi.fn().mockResolvedValue({
        deletionId: "delete-job-1",
        targetType: "memory",
        scope: {
          workspaceId: "workspace-1",
          agentDefinitionId: "agent-1",
          agentVersionId: "version-1",
          installationId: "installation-1",
          scopeResolution: "installation",
        },
      }),
      emit: vi.fn(async (event: MemoryDeletionAnalyticsInput) => { analyticsEvents.push(event); }),
    };
    const worker = new MemoryProviderDeletionWorker({} as never, settings, {
      repository: repository as never,
      adapters: [adapter],
      workerId: "worker-1",
      analytics: analytics as never,
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(adapter.delete).toHaveBeenCalledWith({
      providerRecordId: "remote-1",
      contentDigest: "digest-1",
      operationId: "delete-op-1",
      organizationId: "org-1",
      workspaceId: "workspace-1",
      installationId: "installation-1",
    });
    expect(repository.markCompleted).toHaveBeenCalledWith({ jobId: "provider-job-1", workerId: "worker-1" });
    expect(repository.markDeletionJobProviderPendingComplete).toHaveBeenCalledWith("delete-job-1");
    expect(analyticsEvents.map((event) => event.status)).toEqual(["provider_confirmed", "completed"]);
    expect(analyticsEvents.every((event) => event.providerName === "provider-a" && event.installationId === "installation-1")).toBe(true);
  });

  it("dead-letters an unconfigured provider instead of claiming deletion completed", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      markCompleted: vi.fn(),
      markDeletionJobProviderPendingComplete: vi.fn(),
      markRetryable: vi.fn().mockResolvedValue("dead_letter"),
    };
    const worker = new MemoryProviderDeletionWorker({} as never, settings, {
      repository: repository as never,
      workerId: "worker-1",
      analytics: {
        resolveProviderJob: vi.fn().mockResolvedValue({
          deletionId: "delete-job-1",
          targetType: "memory",
          scope: {
            workspaceId: "workspace-1",
            agentDefinitionId: "agent-1",
            agentVersionId: "version-1",
            installationId: "installation-1",
            scopeResolution: "installation",
          },
        }),
        emit: vi.fn(),
      } as never,
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(repository.markCompleted).not.toHaveBeenCalled();
    expect(repository.markRetryable).toHaveBeenCalledWith({
      jobId: "provider-job-1",
      workerId: "worker-1",
      errorCode: "MEMORY_PROVIDER_DELETION_ADAPTER_UNAVAILABLE",
      maxAttempts: 3,
      retryAfterMs: 2_000,
      retryable: false,
    });
  });

  it("retries provider timeouts with the same idempotency operation and confirms the parent only after success", async () => {
    const firstAttempt = { ...job, attemptCount: 1 };
    const secondAttempt = { ...job, attemptCount: 2 };
    const repository = {
      claimDue: vi.fn()
        .mockResolvedValueOnce([firstAttempt])
        .mockResolvedValueOnce([secondAttempt]),
      markCompleted: vi.fn().mockResolvedValue(true),
      markDeletionJobProviderPendingComplete: vi.fn().mockResolvedValue(true),
      markRetryable: vi.fn().mockResolvedValueOnce("queued"),
    };
    const adapter = {
      providerName: "provider-a",
      delete: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("upstream timeout"), { code: "PROVIDER_TIMEOUT" }))
        .mockResolvedValueOnce(undefined),
    };
    const worker = new MemoryProviderDeletionWorker({} as never, settings, {
      repository: repository as never,
      adapters: [adapter],
      workerId: "worker-1",
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(repository.markCompleted).not.toHaveBeenCalled();
    await expect(worker.runOnce()).resolves.toBe(1);
    expect(adapter.delete).toHaveBeenCalledTimes(2);
    expect(adapter.delete.mock.calls[0]?.[0].operationId).toBe("delete-op-1");
    expect(adapter.delete.mock.calls[1]?.[0].operationId).toBe("delete-op-1");
    expect(repository.markRetryable).toHaveBeenCalledWith({
      jobId: "provider-job-1",
      workerId: "worker-1",
      errorCode: "PROVIDER_TIMEOUT",
      maxAttempts: 3,
      retryAfterMs: 2_000,
      retryable: true,
    });
    expect(repository.markCompleted).toHaveBeenCalledWith({ jobId: "provider-job-1", workerId: "worker-1" });
    expect(repository.markDeletionJobProviderPendingComplete).toHaveBeenCalledTimes(1);
  });

  it("does not advance the parent when a stale worker loses the child lease", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      markCompleted: vi.fn().mockResolvedValue(false),
      markDeletionJobProviderPendingComplete: vi.fn(),
      markRetryable: vi.fn(),
    };
    const adapter = { providerName: "provider-a", delete: vi.fn().mockResolvedValue(undefined) };
    const worker = new MemoryProviderDeletionWorker({} as never, settings, {
      repository: repository as never,
      adapters: [adapter],
      workerId: "worker-1",
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(repository.markDeletionJobProviderPendingComplete).not.toHaveBeenCalled();
  });

  it("bounds shutdown while a provider delete is still in flight", async () => {
    let releaseProvider!: () => void;
    const providerPending = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      markCompleted: vi.fn().mockResolvedValue(true),
      markDeletionJobProviderPendingComplete: vi.fn().mockResolvedValue(true),
      markRetryable: vi.fn(),
    };
    const adapter = {
      providerName: "provider-a",
      delete: vi.fn(async () => { await providerPending; }),
    };
    const worker = new MemoryProviderDeletionWorker({} as never, settings, {
      repository: repository as never,
      adapters: [adapter],
      workerId: "worker-1",
    });

    const run = worker.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(worker.shutdown(5)).resolves.toEqual({ drained: false });
    releaseProvider();
    await expect(run).resolves.toBe(1);
  });

  it("uses capped exponential provider deletion delays", () => {
    expect(memoryProviderDeletionRetryDelay(1, 2_000, 10_000)).toBe(2_000);
    expect(memoryProviderDeletionRetryDelay(3, 2_000, 10_000)).toBe(8_000);
    expect(memoryProviderDeletionRetryDelay(6, 2_000, 10_000)).toBe(10_000);
  });
});
