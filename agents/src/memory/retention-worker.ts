import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { MemoryRevisionRepository } from "../db/repositories/memory-revision-repository";
import {
  MemoryRetentionRepository,
  type MemoryMaintenanceJobRecord,
  type MemoryRetentionCandidate,
} from "../db/repositories/memory-retention-repository";
import { runWithRequiredDatabaseContext } from "../db/context";
import { operationalLogger } from "../telemetry/logger";
import { recordQueueAge, recordRetry } from "../telemetry/spans";
import { detectMemoryConflicts, evaluateRetention, memoryDecayScore } from "./retention";

export interface MemoryRetentionWorkerSettings {
  batchSize: number;
  leaseMs: number;
  pollIntervalMs: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  retentionIntervalMs: number;
  revalidationIntervalMs: number;
  conflictIntervalMs: number;
  candidateBatchSize: number;
}

export interface MemoryRetentionWorkerDependencies {
  repository?: MemoryRetentionRepository;
  revisions?: MemoryRevisionRepository;
  workerId?: string;
  now?: () => Date;
}

export function maintenanceRetryDelayMs(attemptCount: number, baseDelayMs = 2_000, maxDelayMs = 300_000): number {
  const attempt = Number.isSafeInteger(attemptCount) && attemptCount > 0 ? attemptCount : 1;
  const base = Number.isFinite(baseDelayMs) && baseDelayMs >= 0 ? baseDelayMs : 2_000;
  const max = Number.isFinite(maxDelayMs) && maxDelayMs >= base ? maxDelayMs : Math.max(base, 300_000);
  return Math.min(max, base * (2 ** Math.min(attempt - 1, 16)));
}

function expirationDigest(candidate: MemoryRetentionCandidate, expiresAt: string, policyRevision: number): string {
  return createHash("sha256").update(JSON.stringify({
    revisionId: candidate.revisionId,
    expiresAt,
    policyRevision,
  })).digest("hex");
}

function sourceEventId(candidate: MemoryRetentionCandidate, digest: string): string {
  return `memory-retention:${candidate.revisionId}:${digest}`.slice(0, 240);
}

export class MemoryRetentionWorker {
  private readonly repository: MemoryRetentionRepository;
  private readonly revisions: MemoryRevisionRepository;
  private readonly workerId: string;
  private readonly now: () => Date;
  private readonly activeRuns = new Set<Promise<unknown>>();
  private stopping = false;

  public constructor(
    private readonly pool: Pool,
    private readonly settings: MemoryRetentionWorkerSettings,
    dependencies: MemoryRetentionWorkerDependencies = {},
  ) {
    this.repository = dependencies.repository ?? new MemoryRetentionRepository(pool);
    this.revisions = dependencies.revisions ?? new MemoryRevisionRepository(pool);
    this.workerId = dependencies.workerId?.trim() || `memory-retention-${randomUUID()}`;
    this.now = dependencies.now ?? (() => new Date());
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

  /** Bound shutdown while the next lease-expiry poll remains the recovery path. */
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
    await runWithRequiredDatabaseContext(
      "memory-retention-bootstrap",
      { organizationId: "platform", actorId: "system:memory-retention", operator: true },
      () => this.repository.ensureMaintenanceJobs(),
    );
    const claimed = await runWithRequiredDatabaseContext(
      "memory-retention-claim",
      { organizationId: "platform", actorId: "system:memory-retention", operator: true },
      () => this.repository.claimMaintenanceJobs(this.workerId, this.settings.batchSize, this.settings.leaseMs, organizationId),
    );
    claimed.forEach((job) => recordQueueAge("memory_maintenance", Math.max(0, (Date.now() - new Date(job.created_at).getTime()) / 1000)));
    await Promise.all(claimed.map((job) => this.process(job)));
    return claimed.length;
  }

  public async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch (error) {
        operationalLogger.error({ err: error, event: "memory.retention.poll.failed" }, "Memory retention poll failed");
      }
      if (!this.stopping) await new Promise((resolve) => setTimeout(resolve, this.settings.pollIntervalMs));
    }
  }

  private async process(job: MemoryMaintenanceJobRecord): Promise<void> {
    return runWithRequiredDatabaseContext(
      "memory-retention-job",
      { organizationId: job.organization_id, actorId: "system:memory-retention" },
      () => this.processScoped(job),
    );
  }

  private async processScoped(job: MemoryMaintenanceJobRecord): Promise<void> {
    try {
      if (job.job_type === "retention") await this.processRetention(job);
      else if (job.job_type === "revalidation") await this.processRevalidation(job);
      else await this.processConflicts(job);
      const nextRunAfterMs = job.job_type === "retention"
        ? this.settings.retentionIntervalMs
        : job.job_type === "revalidation" ? this.settings.revalidationIntervalMs : this.settings.conflictIntervalMs;
      await this.repository.markMaintenanceCompleted({ jobId: job.id, workerId: this.workerId, nextRunAfterMs });
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code.slice(0, 120)
        : "MEMORY_RETENTION_FAILED";
      const status = await this.repository.markMaintenanceRetryable({
        jobId: job.id,
        workerId: this.workerId,
        errorCode: code,
        maxAttempts: this.settings.maxAttempts,
        retryAfterMs: maintenanceRetryDelayMs(job.attempt_count, this.settings.retryBaseDelayMs, this.settings.retryMaxDelayMs),
      });
      if (status === "queued") recordRetry("memory_retention");
      operationalLogger.error({ err: error, event: "memory.retention.job.failed", job_id: job.id, job_type: job.job_type, status, error_code: code }, "Memory maintenance job failed");
    }
  }

  private async processRetention(job: MemoryMaintenanceJobRecord): Promise<void> {
    const now = this.now();
    const candidates = await this.repository.listCurrentCandidates({ organizationId: job.organization_id, workspaceId: job.workspace_id, limit: this.settings.candidateBatchSize });
    const defaults = await this.repository.getOrganizationDefaults(job.organization_id);
    const rules = await this.repository.listRules(job.organization_id, job.workspace_id);
    let expired = 0;
    for (const candidate of candidates) {
      if (candidate.lifecycleState !== "active") continue;
      // Legal holds are evaluated from the same canonical fact scope as the
      // candidate query. A hold must win over retention expiry even if the
      // policy scan was queued before the hold was created.
      if (candidate.hasActiveLegalHold) continue;
      const evaluation = evaluateRetention({
        organizationId: candidate.organizationId,
        workspaceId: candidate.workspaceId,
        namespace: candidate.namespace ?? "agent_private",
        memoryType: candidate.memoryType,
        factId: candidate.factId,
        observedAt: candidate.observedAt,
        lastRevalidatedAt: candidate.lastRevalidatedAt,
        rules,
        organizationDefaults: defaults,
        now,
      });
      // Re-check the active predecessor in the serializable repository
      // transaction. A concurrent correction can win; appendRevision then
      // rejects the stale predecessor instead of overwriting newer truth.
      if (evaluation.expired) {
        const digest = expirationDigest(candidate, evaluation.expiresAt, evaluation.ruleRevision);
        const sourceId = sourceEventId(candidate, digest);
        await this.revisions.appendRevision(candidate.factId, {
          memoryType: candidate.memoryType,
          transitionType: "expiration",
          lifecycleState: "expired",
          canonicalText: candidate.canonicalText,
          typedValue: candidate.typedValue,
          ...(candidate.memoryType === "episodic" ? {
            eventTime: candidate.eventTime ?? candidate.observedAt,
            eventSummary: candidate.eventSummary ?? candidate.canonicalText,
          } : {}),
          validFrom: now.toISOString(),
          observedAt: candidate.observedAt,
          ...(candidate.validTo && new Date(candidate.validTo).getTime() > now.getTime() ? { validTo: candidate.validTo } : {}),
          ...(candidate.confidence === undefined ? {} : { confidence: candidate.confidence }),
          sourceTrust: "system_observed",
          sensitivity: candidate.sensitivity,
          provenance: { reason: "retention_policy", policyRevision: evaluation.ruleRevision, expiresAt: evaluation.expiresAt },
          evidenceDigest: digest,
          extractionVersion: "retention-v1",
          sourceEventIds: [sourceId],
          sourceEventType: "memory.retention.expired",
          sourceOccurredAt: now.toISOString(),
          redactionClass: "standard",
          predecessorRevisionId: candidate.revisionId,
          idempotencyKey: `memory-expiration:${candidate.revisionId}:${evaluation.ruleRevision}:${evaluation.expiresAt}`,
          createdBy: "system:memory-retention",
        });
        expired += 1;
      }
    }
    operationalLogger.info({ event: "memory.retention.scan.completed", organization_id: job.organization_id, workspace_id: job.workspace_id, candidates: candidates.length, expired }, "Memory retention scan completed");
  }

  private async processRevalidation(job: MemoryMaintenanceJobRecord): Promise<void> {
    const now = this.now();
    const candidates = await this.repository.listCurrentCandidates({ organizationId: job.organization_id, workspaceId: job.workspace_id, limit: this.settings.candidateBatchSize });
    const defaults = await this.repository.getOrganizationDefaults(job.organization_id);
    const rules = await this.repository.listRules(job.organization_id, job.workspace_id);
    let queued = 0;
    for (const candidate of candidates) {
      if (candidate.lifecycleState !== "active") continue;
      const evaluation = evaluateRetention({
        organizationId: candidate.organizationId,
        workspaceId: candidate.workspaceId,
        namespace: candidate.namespace ?? "agent_private",
        memoryType: candidate.memoryType,
        factId: candidate.factId,
        observedAt: candidate.observedAt,
        lastRevalidatedAt: candidate.lastRevalidatedAt,
        rules,
        organizationDefaults: defaults,
        now,
      });
      if (!evaluation.stale) continue;
      const idempotencyKey = `memory-revalidation:${candidate.revisionId}:${evaluation.ruleRevision}:${evaluation.revalidateAt}`;
      const status = await this.repository.enqueueRevalidation({ candidate, reason: candidate.confidence !== undefined && candidate.confidence < 0.5 ? "low_confidence" : "stale", dueAt: evaluation.revalidateAt, idempotencyKey });
      if (status === "created") queued += 1;
    }
    operationalLogger.info({ event: "memory.revalidation.scan.completed", organization_id: job.organization_id, workspace_id: job.workspace_id, candidates: candidates.length, queued }, "Memory revalidation scan completed");
  }

  private async processConflicts(job: MemoryMaintenanceJobRecord): Promise<void> {
    const candidates = await this.repository.listCurrentCandidates({ organizationId: job.organization_id, workspaceId: job.workspace_id, limit: this.settings.candidateBatchSize });
    const conflicts = detectMemoryConflicts(candidates);
    let recorded = 0;
    for (const conflict of conflicts) {
      const left = candidates.find((candidate) => candidate.revisionId === conflict.leftRevisionId);
      const right = candidates.find((candidate) => candidate.revisionId === conflict.rightRevisionId);
      if (!left || !right || left.agentDefinitionId !== right.agentDefinitionId || left.installationId !== right.installationId) continue;
      const status = await this.repository.recordConflict({ organizationId: job.organization_id, workspaceId: job.workspace_id, agentDefinitionId: left.agentDefinitionId, installationId: left.installationId, conflict });
      if (status === "created") recorded += 1;
    }
    operationalLogger.info({ event: "memory.conflict.scan.completed", organization_id: job.organization_id, workspace_id: job.workspace_id, candidates: candidates.length, conflicts: recorded }, "Memory conflict scan completed");
  }

  /** Exposes the ranking signal for retrieval adapters without changing truth state. */
  public decayScore(candidate: Pick<MemoryRetentionCandidate, "observedAt" | "confidence" | "usageCount" | "confirmations" | "corrections" | "rejections" | "helpfulness">): number {
    return memoryDecayScore({ observedAt: candidate.observedAt, confidence: candidate.confidence, quality: candidate });
  }
}
