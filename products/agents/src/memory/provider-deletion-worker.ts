import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { MemoryProviderDeletionRepository, type MemoryProviderDeletionJob } from "../db/repositories/memory-provider-deletion-repository";
import { runWithRequiredDatabaseContext } from "../db/context";
import { operationalLogger } from "../telemetry/logger";
import { recordQueueAge, recordRetry, withSpan } from "../telemetry/spans";
import { createMemoryDeletionAnalyticsSink, scopeInput, type MemoryDeletionAnalyticsSink } from "./deletion-analytics";

export interface MemoryProviderDeletionAdapter {
  readonly providerName: string;
  /** The adapter must make operationId idempotent and report only after the
   * provider has accepted a durable delete. */
  delete(input: {
    providerRecordId: string;
    contentDigest: string;
    operationId: string;
    organizationId: string;
    workspaceId: string;
    installationId: string;
  }): Promise<void>;
}

export interface MemoryProviderDeletionWorkerSettings {
  batchSize: number;
  leaseMs: number;
  pollIntervalMs: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

export interface MemoryProviderDeletionWorkerDependencies {
  repository?: MemoryProviderDeletionRepository;
  adapters?: readonly MemoryProviderDeletionAdapter[];
  workerId?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  analytics?: MemoryDeletionAnalyticsSink;
  analyticsPool?: Pool;
}

export class MemoryProviderDeletionWorkerError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(code: string, message: string, retryable = true) {
    super(message);
    this.name = "MemoryProviderDeletionWorkerError";
    this.code = code;
    this.retryable = retryable;
  }
}

function retryDelay(attempt: number, base: number, max: number): number {
  const safeBase = Math.max(1_000, Math.min(Math.trunc(base), 3_600_000));
  const safeMax = Math.max(safeBase, Math.min(Math.trunc(max), 86_400_000));
  return Math.min(safeMax, safeBase * 2 ** Math.max(0, Math.min(attempt - 1, 20)));
}

function errorInfo(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof MemoryProviderDeletionWorkerError) return { code: error.code, retryable: error.retryable };
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; retryable?: unknown };
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code.trim().toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 120) || "MEMORY_PROVIDER_DELETION_FAILED",
        retryable: candidate.retryable !== false,
      };
    }
  }
  return { code: "MEMORY_PROVIDER_DELETION_FAILED", retryable: true };
}

/** Deletes remote provider records after canonical purge without losing the
 * provider identifier. A missing adapter is an explicit dead-letter, never a
 * silent success. */
export class MemoryProviderDeletionWorker {
  private readonly repository: MemoryProviderDeletionRepository;
  private readonly adapters: Map<string, MemoryProviderDeletionAdapter>;
  private readonly workerId: string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly analytics?: MemoryDeletionAnalyticsSink;
  private readonly activeRuns = new Set<Promise<unknown>>();
  private stopping = false;

  public constructor(
    private readonly pool: Pool,
    private readonly settings: MemoryProviderDeletionWorkerSettings,
    dependencies: MemoryProviderDeletionWorkerDependencies = {},
  ) {
    this.repository = dependencies.repository ?? new MemoryProviderDeletionRepository(pool);
    this.adapters = new Map((dependencies.adapters ?? []).map((adapter) => [adapter.providerName.trim(), adapter]));
    this.workerId = dependencies.workerId?.trim() || `memory-provider-deletion-${randomUUID()}`;
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.analytics = dependencies.analytics
      ?? (dependencies.analyticsPool ? createMemoryDeletionAnalyticsSink(dependencies.analyticsPool) : undefined);
  }

  public stop(): void {
    this.stopping = true;
  }

  public async runOnce(organizationId?: string): Promise<number> {
    const operation = this.runOnceInternal(organizationId);
    this.activeRuns.add(operation);
    try {
      return await operation;
    } finally {
      this.activeRuns.delete(operation);
    }
  }

  /** Bound shutdown while leaving leased work for expiry/reclaim. */
  public async shutdown(timeoutMs = 30_000): Promise<{ drained: boolean }> {
    this.stop();
    const active = [...this.activeRuns];
    if (!active.length) return { drained: true };
    const timeout = Math.max(1, Math.min(Math.trunc(timeoutMs), 300_000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.allSettled(active).then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeout); }),
    ]);
    if (timer) clearTimeout(timer);
    return { drained };
  }

  private async runOnceInternal(organizationId?: string): Promise<number> {
    const jobs = await runWithRequiredDatabaseContext(
      "memory-provider-deletion-claim",
      { organizationId: "platform", actorId: "system:memory-provider-deletion", operator: true },
      () => this.repository.claimDue(this.workerId, this.settings.batchSize, this.settings.leaseMs, organizationId),
    );
    jobs.forEach((job) => recordQueueAge("memory_provider_deletion", Math.max(0, (Date.now() - new Date(job.createdAt).getTime()) / 1000)));
    await Promise.all(jobs.map((job) => withSpan("memory.provider.deletion.job", { "memory.provider": job.providerName }, () => this.process(job))));
    return jobs.length;
  }

  public async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch (error) {
        operationalLogger.error({ err: error, event: "memory.provider.deletion.poll.failed" }, "Memory provider deletion poll failed");
      }
      if (!this.stopping) await this.sleep(this.settings.pollIntervalMs);
    }
  }

  private async process(job: MemoryProviderDeletionJob): Promise<void> {
    return runWithRequiredDatabaseContext(
      "memory-provider-deletion-job",
      { organizationId: job.organizationId, actorId: "system:memory-provider-deletion" },
      () => this.processScoped(job),
    );
  }

  private async processScoped(job: MemoryProviderDeletionJob): Promise<void> {
    const startedAt = Date.now();
    const analytics = this.analytics
      ? await this.analytics.resolveProviderJob({
        organizationId: job.organizationId,
        installationId: job.installationId,
        deletionJobId: job.deletionJobId,
        providerJobId: job.id,
      })
      : undefined;
    try {
      const adapter = this.adapters.get(job.providerName);
      if (!adapter) throw new MemoryProviderDeletionWorkerError("MEMORY_PROVIDER_DELETION_ADAPTER_UNAVAILABLE", "No provider deletion adapter is registered", false);
      await adapter.delete({
        providerRecordId: job.providerRecordId,
        contentDigest: job.contentDigest,
        operationId: job.operationId,
        organizationId: job.organizationId,
        workspaceId: job.workspaceId,
        installationId: job.installationId,
      });
      // A lease can expire while the adapter is waiting on the remote
      // provider.  Only the worker that still owns the child lease may
      // advance its state and attempt parent completion.  Otherwise a stale
      // worker could mark the parent complete while a successor is still
      // responsible for the child.
      const completed = await this.repository.markCompleted({ jobId: job.id, workerId: this.workerId });
      if (completed) {
        const parentCompleted = job.deletionJobId
          ? await this.repository.markDeletionJobProviderPendingComplete(job.deletionJobId)
          : false;
        if (analytics && (parentCompleted || !job.deletionJobId)) {
          await this.emitAnalytics(job, analytics, "provider_confirmed", {
            attemptCount: job.attemptCount,
            providerName: job.providerName,
            providerJobCount: 1,
            latencyMs: elapsedMs(startedAt),
          });
          if (parentCompleted || !job.deletionJobId) {
            await this.emitAnalytics(job, analytics, "completed", {
              attemptCount: job.attemptCount,
              providerName: job.providerName,
              providerJobCount: 1,
              latencyMs: elapsedMs(startedAt),
            });
          }
        }
      }
    } catch (error) {
      const info = errorInfo(error);
      const status = await this.repository.markRetryable({
        jobId: job.id,
        workerId: this.workerId,
        errorCode: info.code,
        maxAttempts: this.settings.maxAttempts,
        retryAfterMs: retryDelay(job.attemptCount, this.settings.retryBaseDelayMs, this.settings.retryMaxDelayMs),
        retryable: info.retryable,
      });
      if (status === "queued") {
        if (analytics) {
          await this.emitAnalytics(job, analytics, "retrying", {
            attemptCount: job.attemptCount,
            providerName: job.providerName,
            retryable: true,
            errorCode: info.code,
            latencyMs: elapsedMs(startedAt),
          });
        }
        recordRetry("memory_provider_deletion");
      } else if (status === "dead_letter") {
        if (analytics) {
          await this.emitAnalytics(job, analytics, "failed", {
            attemptCount: job.attemptCount,
            providerName: job.providerName,
            retryable: false,
            errorCode: info.code,
            latencyMs: elapsedMs(startedAt),
          });
        }
      }
      operationalLogger.warn({ event: "memory.provider.deletion.failed", job_id: job.id, provider: job.providerName, status, error_code: info.code }, "Memory provider deletion attempt failed");
    }
  }

  private async emitAnalytics(
    job: MemoryProviderDeletionJob,
    resolved: Awaited<ReturnType<MemoryDeletionAnalyticsSink["resolveProviderJob"]>>,
    status: Parameters<MemoryDeletionAnalyticsSink["emit"]>[0]["status"],
    details: Partial<Parameters<MemoryDeletionAnalyticsSink["emit"]>[0]> = {},
  ): Promise<void> {
    if (!this.analytics || !resolved) return;
    try {
      await this.analytics.emit({
        ...scopeInput(job.organizationId, resolved.scope),
        deletionId: resolved.deletionId,
        targetType: resolved.targetType,
        status,
        legalHold: false,
        attemptCount: job.attemptCount,
        occurredAt: new Date(),
        ...details,
      });
    } catch (error) {
      operationalLogger.warn({
        event: "memory.deletion.analytics.enqueue.failed",
        job_id: job.id,
        deletion_id: resolved.deletionId,
        status,
        error_code: "MEMORY_DELETION_ANALYTICS_ENQUEUE_FAILED",
      }, "Memory deletion analytics enqueue failed");
      void error;
    }
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.trunc(Date.now() - startedAt));
}

export { retryDelay as memoryProviderDeletionRetryDelay };
