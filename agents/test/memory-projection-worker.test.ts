import { describe, expect, it, vi } from "vitest";
import { MemoryProjectionWorker } from "../src/memory/projection-worker";
import type { MemoryProjectionSourceRecord, MemoryProjectionTaskRecord } from "../src/db/repositories/memory-projection-repository";

const task = (kind: MemoryProjectionTaskRecord["projectionKind"]): MemoryProjectionTaskRecord => ({
  id: "outbox-1",
  organizationId: "org-1",
  workspaceId: "workspace-1",
  agentDefinitionId: "agent-1",
  agentVersionId: "version-1",
  installationId: "installation-1",
  factId: "fact-1",
  revisionId: "revision-1",
  projectionKind: kind,
  operation: "upsert",
  projectionVersion: "v1",
  providerName: kind === "provider" ? "provider-a" : "internal",
  idempotencyKey: "projection-1",
  payload: {},
  payloadDigest: "a".repeat(64),
  status: "running",
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
});

const source: MemoryProjectionSourceRecord = {
  revisionId: "revision-1",
  factId: "fact-1",
  organizationId: "org-1",
  workspaceId: "workspace-1",
  agentDefinitionId: "agent-1",
  agentVersionId: "version-1",
  installationId: "installation-1",
  memoryType: "semantic",
  lifecycleState: "active",
  sensitivity: "normal",
  canonicalText: "The customer prefers WhatsApp.",
  validFrom: "2026-09-07T00:00:00.000Z",
  validTo: null,
  eventTime: null,
  eventSummary: null,
  sourceEventIds: ["source-1"],
  contentDigest: "b".repeat(64),
};

const settings = {
  batchSize: 10,
  leaseMs: 120_000,
  pollIntervalMs: 5_000,
  retryBaseDelayMs: 2_000,
  retryMaxDelayMs: 30_000,
};

describe("memory projection worker", () => {
  it("applies local FTS work and records visible readiness", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([task("fts")]),
      getSource: vi.fn().mockResolvedValue(source),
      applyFts: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(true),
      markRetryable: vi.fn(),
      markBlocked: vi.fn(),
    };
    const worker = new MemoryProjectionWorker({} as never, settings, { repository: repository as never, workerId: "worker-1" });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(repository.applyFts).toHaveBeenCalledWith(source, "upsert");
    expect(repository.markCompleted).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ projectionKind: "fts" }),
      workerId: "worker-1",
      result: { readiness: "visible" },
    }));
    expect(repository.markRetryable).not.toHaveBeenCalled();
  });

  it("returns a claimed task to accepted readiness when the projection rollout is paused", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([task("fts")]),
      releaseLease: vi.fn().mockResolvedValue(true),
      getSource: vi.fn(),
      markCompleted: vi.fn(),
      markRetryable: vi.fn(),
      markBlocked: vi.fn(),
    };
    const controls = { isFeatureEnabled: vi.fn().mockResolvedValue(false) };
    const worker = new MemoryProjectionWorker({} as never, settings, {
      repository: repository as never,
      controls,
      workerId: "worker-1",
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(controls.isFeatureEnabled).toHaveBeenCalledWith("org-1", "memory_projection_enabled", "installation-1");
    expect(repository.releaseLease).toHaveBeenCalledWith({
      task: expect.objectContaining({ projectionKind: "fts" }),
      workerId: "worker-1",
      reason: "MEMORY_PROJECTION_ROLLOUT_DISABLED",
    });
    expect(repository.getSource).not.toHaveBeenCalled();
    expect(repository.markCompleted).not.toHaveBeenCalled();
  });

  it("blocks vector work when no embedding provider is configured instead of silently creating lexical-only state", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([task("vector")]),
      getSource: vi.fn().mockResolvedValue(source),
      applyVector: vi.fn(),
      markCompleted: vi.fn(),
      markRetryable: vi.fn(),
      markBlocked: vi.fn().mockResolvedValue(true),
    };
    const worker = new MemoryProjectionWorker({} as never, settings, { repository: repository as never, workerId: "worker-1" });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(repository.markBlocked).toHaveBeenCalledWith({
      task: expect.objectContaining({ projectionKind: "vector" }),
      workerId: "worker-1",
      errorCode: "MEMORY_VECTOR_PROVIDER_UNAVAILABLE",
    });
    expect(repository.markCompleted).not.toHaveBeenCalled();
  });

  it("blocks restricted memory before it reaches an embedding provider", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([task("vector")]),
      getSource: vi.fn().mockResolvedValue({ ...source, sensitivity: "restricted" }),
      applyVector: vi.fn(),
      markCompleted: vi.fn(),
      markRetryable: vi.fn(),
      markBlocked: vi.fn().mockResolvedValue(true),
    };
    const embeddingProvider = { provider: "openrouter", model: "test", dimensions: 1_536, embed: vi.fn() };
    const worker = new MemoryProjectionWorker({} as never, settings, {
      repository: repository as never,
      embeddingProvider,
      workerId: "worker-1",
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(embeddingProvider.embed).not.toHaveBeenCalled();
    expect(repository.markBlocked).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "MEMORY_VECTOR_SENSITIVITY_BLOCKED" }));
  });

  it("preserves provider accepted/indexing semantics through a provider adapter", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([task("provider")]),
      getSource: vi.fn().mockResolvedValue(source),
      markCompleted: vi.fn().mockResolvedValue(true),
      markRetryable: vi.fn(),
      markBlocked: vi.fn(),
    };
    const provider = {
      providerName: "provider-a",
      project: vi.fn().mockResolvedValue({
        readiness: "accepted",
        providerState: "accepted",
        providerRecordId: "remote-1",
        providerOperationId: "operation-1",
      }),
    };
    const worker = new MemoryProjectionWorker({} as never, settings, {
      repository: repository as never,
      providers: [provider],
      workerId: "worker-1",
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(repository.markCompleted).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ readiness: "accepted", providerState: "accepted", providerRecordId: "remote-1" }),
    }));
  });

  it("dead-letters a provider acknowledgement that collapses readiness states", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([task("provider")]),
      getSource: vi.fn().mockResolvedValue(source),
      markCompleted: vi.fn(),
      markRetryable: vi.fn(),
      markBlocked: vi.fn().mockResolvedValue(true),
    };
    const provider = {
      providerName: "provider-a",
      project: vi.fn().mockResolvedValue({
        readiness: "visible",
        providerState: "accepted",
        providerRecordId: "remote-1",
      }),
    };
    const worker = new MemoryProjectionWorker({} as never, settings, {
      repository: repository as never,
      providers: [provider],
      workerId: "worker-1",
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(repository.markCompleted).not.toHaveBeenCalled();
    expect(repository.markRetryable).not.toHaveBeenCalled();
    expect(repository.markBlocked).toHaveBeenCalledWith({
      task: expect.objectContaining({ projectionKind: "provider" }),
      workerId: "worker-1",
      errorCode: "MEMORY_PROVIDER_READINESS_STATE_MISMATCH",
    });
  });

  it("leases retryable provider failures without persisting provider payloads", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([task("provider")]),
      getSource: vi.fn().mockResolvedValue(source),
      markCompleted: vi.fn(),
      markRetryable: vi.fn().mockResolvedValue("queued"),
      markBlocked: vi.fn(),
    };
    const provider = {
      providerName: "provider-a",
      project: vi.fn().mockRejectedValue(Object.assign(new Error("provider body must not be logged"), { code: "PROVIDER_TIMEOUT" })),
    };
    const worker = new MemoryProjectionWorker({} as never, settings, {
      repository: repository as never,
      providers: [provider],
      workerId: "worker-1",
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(repository.markRetryable).toHaveBeenCalledWith({
      task: expect.objectContaining({ projectionKind: "provider" }),
      workerId: "worker-1",
      errorCode: "PROVIDER_TIMEOUT",
      retryAfterMs: 2_000,
    });
    expect(repository.markBlocked).not.toHaveBeenCalled();
  });

  it("bounds shutdown while an external provider call is still in flight", async () => {
    let releaseProvider!: () => void;
    const providerPending = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const repository = {
      claimDue: vi.fn().mockResolvedValue([task("provider")]),
      getSource: vi.fn().mockResolvedValue(source),
      markCompleted: vi.fn().mockResolvedValue(true),
      markRetryable: vi.fn(),
      markBlocked: vi.fn(),
    };
    const provider = {
      providerName: "provider-a",
      project: vi.fn(async () => { await providerPending; return { readiness: "accepted" as const, providerState: "accepted" as const, providerRecordId: "remote-1" }; }),
    };
    const worker = new MemoryProjectionWorker({} as never, settings, { repository: repository as never, providers: [provider], workerId: "worker-1" });
    const run = worker.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(worker.shutdown(5)).resolves.toEqual({ drained: false });
    releaseProvider();
    await expect(run).resolves.toBe(1);
  });
});
