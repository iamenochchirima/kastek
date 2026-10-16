import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createEnvironmentEmbeddingProvider, type EmbeddingProvider } from "./embeddings";
import { MemoryProjectionRepository, type MemoryProjectionApplyResult, type MemoryProjectionSourceRecord, type MemoryProjectionTaskRecord } from "../db/repositories/memory-projection-repository";
import { operationalLogger } from "../telemetry/logger";
import { recordQueueAge, withSpan } from "../telemetry/spans";
import { runWithRequiredDatabaseContext } from "../db/context";
import { withTransaction } from "../db/pool";
import { enqueueMemoryProjectionEvent } from "../analytics/memory";
import { assertMemoryProviderProjectionResult } from "./provider";
import type { OperatorControlRepository } from "../db/repositories/operator-control-repository";

export interface MemoryProviderProjectionAdapter {
  readonly providerName: string;
  /** Restricted memory requires an explicit provider capability declaration. */
  readonly allowRestricted?: boolean;
  project(input: {
    task: MemoryProjectionTaskRecord;
    source: MemoryProjectionSourceRecord;
  }): Promise<MemoryProjectionApplyResult>;
}

export interface MemoryProjectionWorkerSettings {
  batchSize: number;
  leaseMs: number;
  pollIntervalMs: number;
  maxAttempts?: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

export interface MemoryProjectionWorkerDependencies {
  repository?: MemoryProjectionRepository;
  embeddingProvider?: EmbeddingProvider;
  providers?: readonly MemoryProviderProjectionAdapter[];
  analyticsPool?: Pool;
  workerId?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  controls?: Pick<OperatorControlRepository, "isFeatureEnabled">;
}

export class MemoryProjectionWorkerError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(code: string, message: string, retryable = true) {
    super(message);
    this.name = "MemoryProjectionWorkerError";
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
  if (error instanceof MemoryProjectionWorkerError) return { code: error.code, retryable: error.retryable };
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; retryable?: unknown };
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code.trim().toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 120) || "MEMORY_PROJECTION_FAILED",
        retryable: candidate.retryable !== false,
      };
    }
  }
  return { code: "MEMORY_PROJECTION_FAILED", retryable: true };
}

/**
 * Projects canonical revisions asynchronously.  Canonical revision writes
 * never wait for this worker and a provider outage never deletes evidence.
 */
export class MemoryProjectionWorker {
  private readonly repository: MemoryProjectionRepository;
  private readonly embeddingProvider: EmbeddingProvider | undefined;
  private readonly providers: Map<string, MemoryProviderProjectionAdapter>;
  private readonly analyticsPool: Pool | undefined;
  private readonly workerId: string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly controls: Pick<OperatorControlRepository, "isFeatureEnabled"> | undefined;
  private readonly activeRuns = new Set<Promise<unknown>>();
  private stopping = false;

  public constructor(
    private readonly pool: Pool,
    private readonly settings: MemoryProjectionWorkerSettings,
    dependencies: MemoryProjectionWorkerDependencies = {},
  ) {
    this.repository = dependencies.repository ?? new MemoryProjectionRepository(pool);
    this.embeddingProvider = dependencies.embeddingProvider ?? createEnvironmentEmbeddingProvider();
    this.providers = new Map((dependencies.providers ?? []).map((provider) => [provider.providerName.trim(), provider]));
    this.analyticsPool = dependencies.analyticsPool;
    this.workerId = dependencies.workerId?.trim() || "memory-projection-" + randomUUID();
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.controls = dependencies.controls;
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

  /** Stop polling and wait for in-flight provider calls up to a bound. Leases
   * remain fenced in the database and are reclaimed by the next poll after
   * their lease expiry; shutdown never invents a completion state. */
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
    const claimed = await runWithRequiredDatabaseContext(
      "memory-projection-claim",
      { organizationId: "platform", actorId: "system:memory-projection", operator: true },
      () => this.repository.claimDue(this.workerId, this.settings.batchSize, this.settings.leaseMs, organizationId),
    );
    for (const task of claimed) {
      recordQueueAge("memory_projection", Math.max(0, (Date.now() - new Date(task.createdAt).getTime()) / 1000));
    }
    await Promise.all(claimed.map((task) => withSpan(
      "memory.projection.job",
      { "memory.projection.kind": task.projectionKind, "memory.projection.provider": task.providerName },
      () => this.process(task),
    )));
    return claimed.length;
  }

  public async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch (error) {
        operationalLogger.error({ err: error, event: "memory.projection.poll.failed" }, "Memory projection poll failed");
      }
      if (!this.stopping) await this.sleep(this.settings.pollIntervalMs);
    }
  }

  private async process(task: MemoryProjectionTaskRecord): Promise<void> {
    return runWithRequiredDatabaseContext(
      "memory-projection-job",
      { organizationId: task.organizationId, actorId: "system:memory-projection" },
      () => this.processScoped(task),
    );
  }

  private async processScoped(task: MemoryProjectionTaskRecord): Promise<void> {
    try {
      if (this.controls && !(await this.controls.isFeatureEnabled(task.organizationId, "memory_projection_enabled", task.installationId))) {
        await this.repository.releaseLease({ task, workerId: this.workerId, reason: "MEMORY_PROJECTION_ROLLOUT_DISABLED" });
        return;
      }
      const source = await this.repository.getSource(task);
      if (!source) throw new MemoryProjectionWorkerError("MEMORY_PROJECTION_SOURCE_NOT_FOUND", "Canonical revision is missing", false);
      const result = await this.apply(task, source);
      const completed = await this.repository.markCompleted({ task, workerId: this.workerId, result });
      if (completed) await this.recordProjectionAnalytics(task, result, source, result.readiness);
    } catch (error) {
      const info = errorInfo(error);
      if (!info.retryable) {
        const blocked = await this.repository.markBlocked({ task, workerId: this.workerId, errorCode: info.code });
        if (blocked) await this.recordProjectionAnalytics(task, undefined, undefined, "blocked", info.code, false);
        return;
      }
      const status = await this.repository.markRetryable({
        task,
        workerId: this.workerId,
        errorCode: info.code,
        retryAfterMs: retryDelay(task.attemptCount, this.settings.retryBaseDelayMs, this.settings.retryMaxDelayMs),
      });
      if (status) await this.recordProjectionAnalytics(task, undefined, undefined, "failed", info.code, true);
    }
  }

  private async recordProjectionAnalytics(
    task: MemoryProjectionTaskRecord,
    result: MemoryProjectionApplyResult | undefined,
    source: MemoryProjectionSourceRecord | undefined,
    status: "accepted" | "indexing" | "indexed" | "visible" | "failed" | "blocked" | "deleted",
    errorCode?: string,
    retryable?: boolean,
  ): Promise<void> {
    if (!this.analyticsPool) return;
    try {
      await withTransaction(this.analyticsPool, (client) => enqueueMemoryProjectionEvent(client, {
        organizationId: task.organizationId,
        workspaceId: task.workspaceId,
        agentDefinitionId: task.agentDefinitionId,
        agentVersionId: task.agentVersionId,
        installationId: task.installationId,
        projectionId: task.id,
        revisionId: task.revisionId,
        projectionKind: task.projectionKind,
        operation: task.operation,
        status,
        providerName: task.providerName,
        ...(result?.providerState ? { providerState: result.providerState } : {}),
        projectionVersion: task.projectionVersion,
        attemptCount: task.attemptCount,
        maxAttempts: task.maxAttempts,
        ...(retryable !== undefined ? { retryable } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(source ? { causationId: source.contentDigest } : {}),
        occurredAt: new Date(),
      }));
    } catch (error) {
      operationalLogger.warn({
        event: "memory.projection.analytics.enqueue.failed",
        projection_id: task.id,
        error_code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "MEMORY_ANALYTICS_ENQUEUE_FAILED",
      }, "Memory projection analytics enqueue failed");
    }
  }

  private async apply(task: MemoryProjectionTaskRecord, source: MemoryProjectionSourceRecord): Promise<MemoryProjectionApplyResult> {
    if (task.projectionKind === "fts") {
      await this.repository.applyFts(source, task.operation);
      return { readiness: task.operation === "delete" ? "deleted" : "visible" };
    }
    if (task.projectionKind === "temporal") {
      await this.repository.applyTemporal(source, task.operation);
      return { readiness: task.operation === "delete" ? "deleted" : "visible" };
    }
    if (task.projectionKind === "vector") {
      if (task.operation === "delete") {
        await this.repository.applyVector(source, task.operation, undefined, undefined);
        return { readiness: "deleted" };
      }
      if (source.sensitivity === "restricted") {
        throw new MemoryProjectionWorkerError("MEMORY_VECTOR_SENSITIVITY_BLOCKED", "Restricted memory cannot be sent to a vector provider", false);
      }
      if (!this.embeddingProvider) {
        throw new MemoryProjectionWorkerError("MEMORY_VECTOR_PROVIDER_UNAVAILABLE", "Vector projection requires a configured embedding provider", false);
      }
      const vectors = await this.embeddingProvider.embed([source.canonicalText]);
      if (vectors.length !== 1) throw new MemoryProjectionWorkerError("MEMORY_VECTOR_PROVIDER_INCOMPLETE", "Embedding provider returned an incomplete result");
      await this.repository.applyVector(source, task.operation, vectors[0], this.embeddingProvider.model);
      return { readiness: "visible" };
    }
    const provider = this.providers.get(task.providerName);
    if (!provider) {
      throw new MemoryProjectionWorkerError("MEMORY_PROVIDER_ADAPTER_UNAVAILABLE", "No adapter is registered for the requested memory provider", false);
    }
    if (source.sensitivity === "restricted" && provider.allowRestricted !== true) {
      throw new MemoryProjectionWorkerError("MEMORY_PROVIDER_SENSITIVITY_BLOCKED", "Restricted memory cannot be sent to this provider", false);
    }
    const result = await provider.project({ task, source });
    try {
      assertMemoryProviderProjectionResult(task.operation, result);
    } catch (error) {
      const code = error instanceof Error ? error.message : "MEMORY_PROVIDER_RESULT_INVALID";
      throw new MemoryProjectionWorkerError(code, "Provider returned an invalid projection acknowledgement", false);
    }
    return result;
  }
}

export { retryDelay as memoryProjectionRetryDelay };
