import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ConversationRepository } from "../db/repositories/conversation-repository";
import { MemoryConsolidationJobRepository, type MemoryConsolidationJobRecord } from "../db/repositories/memory-consolidation-job-repository";
import { MemoryRevisionRepository } from "../db/repositories/memory-revision-repository";
import { RunRepository } from "../db/repositories/run-repository";
import { runWithRequiredDatabaseContext } from "../db/context";
import { operationalLogger } from "../telemetry/logger";
import { recordMemoryConsolidation, recordQueueAge, withSpan } from "../telemetry/spans";
import { extractMemoryCandidates, MEMORY_EXTRACTION_VERSION, selectConversationEvidence, type ConversationEvidence, type MemoryCandidate } from "./consolidation";
import { canonicalFactKey } from "./contracts";
import { memoryPolicyFromAgentPolicy } from "./policy";
import type { OperatorControlRepository } from "../db/repositories/operator-control-repository";

export interface MemoryRevisionConsolidationWorkerSettings {
  batchSize: number;
  leaseMs: number;
  pollIntervalMs: number;
  maxAttempts: number;
  minInboundMessages: number;
  extractionTimeoutMs?: number;
}

export interface MemoryCandidateExtractor {
  /** Provider/model are optional because the deterministic extractor is local. */
  readonly provider?: string;
  readonly model?: string;
  extract(evidence: readonly ConversationEvidence[]): Promise<readonly MemoryCandidate[]> | readonly MemoryCandidate[];
}

export interface MemoryRevisionConsolidationWorkerDependencies {
  jobs?: MemoryConsolidationJobRepository;
  conversations?: ConversationRepository;
  revisions?: MemoryRevisionRepository;
  runs?: RunRepository;
  extractor?: MemoryCandidateExtractor;
  workerId?: string;
  controls?: Pick<OperatorControlRepository, "isFeatureEnabled">;
}

export interface MemoryConsolidationShutdownResult {
  drained: boolean;
  abandoned: number;
}

function candidateDigest(input: { sourceMessageIds: readonly string[]; canonicalText: string; extractionVersion: string }): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function workspaceIdForRun(run: Awaited<ReturnType<RunRepository["getRuntimeRunById"]>> & object): string {
  const workspaceId = run.installation_scope_id?.trim();
  if (!workspaceId) throw Object.assign(new Error("MEMORY_CONSOLIDATION_WORKSPACE_SCOPE_MISSING"), { code: "MEMORY_CONSOLIDATION_WORKSPACE_SCOPE_MISSING" });
  return workspaceId;
}

function extractorErrorCode(error: unknown): string {
  const candidate = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return (typeof candidate === "string" ? candidate : "MEMORY_REVISION_CONSOLIDATION_FAILED")
    .trim().toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 120) || "MEMORY_REVISION_CONSOLIDATION_FAILED";
}

async function extractWithDeadline(
  extractor: MemoryCandidateExtractor,
  evidence: readonly ConversationEvidence[],
  timeoutMs: number,
): Promise<readonly MemoryCandidate[]> {
  const boundedTimeout = Math.max(100, Math.min(Math.trunc(timeoutMs), 300_000));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Memory extraction exceeded its deadline"), { code: "MEMORY_CONSOLIDATION_EXTRACTOR_TIMEOUT" })), boundedTimeout);
  });
  try {
    return await Promise.race([Promise.resolve(extractor.extract(evidence)), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validString(value: unknown, maximum = 240): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

/**
 * Treat model output as an untrusted boundary.  A malformed response must
 * retry the job, never partially write a candidate or mark the job complete.
 */
function validateExtractedCandidates(value: unknown, evidence: readonly ConversationEvidence[]): readonly MemoryCandidate[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw Object.assign(new Error("Memory extractor returned an invalid candidate list"), { code: "MEMORY_CONSOLIDATION_EXTRACTOR_OUTPUT_INVALID" });
  }
  const evidenceIds = new Set(evidence.map((entry) => entry.id));
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw Object.assign(new Error("Memory extractor returned an invalid candidate"), { code: "MEMORY_CONSOLIDATION_EXTRACTOR_OUTPUT_INVALID" });
    }
    const item = candidate as Partial<MemoryCandidate>;
    const content = item.content;
    const provenance = item.provenance;
    if (item.namespace !== "agent_private"
      || (item.memoryType !== "semantic" && item.memoryType !== "episodic")
      || !validString(item.canonicalText, 16_000)
      || typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1
      || (item.sensitivity !== "normal" && item.sensitivity !== "sensitive" && item.sensitivity !== "restricted")
      || (item.retentionSuggestion !== "standard" && item.retentionSuggestion !== "short" && item.retentionSuggestion !== "long")
      || !content || typeof content !== "object" || Array.isArray(content)
      || (content.category !== "preference" && content.category !== "decision")
      || !validString(content.value, 240)
      || !provenance || typeof provenance !== "object" || Array.isArray(provenance)
      || !Array.isArray(provenance.sourceMessageIds) || provenance.sourceMessageIds.length === 0
      || provenance.sourceMessageIds.some((sourceId) => !validString(sourceId, 240) || !evidenceIds.has(sourceId))
      || provenance.extractionVersion !== MEMORY_EXTRACTION_VERSION
      || !Array.isArray(item.relations)
      || item.relations.some((relation) => !relation || typeof relation !== "object"
        || (relation.type !== "supports" && relation.type !== "contradicts" && relation.type !== "derived_from")
        || !validString(relation.sourceMessageId, 240)
        || !evidenceIds.has(relation.sourceMessageId))) {
      throw Object.assign(new Error("Memory extractor returned an invalid candidate"), { code: "MEMORY_CONSOLIDATION_EXTRACTOR_OUTPUT_INVALID" });
    }
    return item as MemoryCandidate;
  });
}

/**
 * Canonical consolidation worker. It consumes the existing durable job queue,
 * but commits only immutable v2 facts/revisions; legacy memory rows are not a
 * write target for this worker.
 */
export class MemoryRevisionConsolidationWorker {
  private readonly jobs: MemoryConsolidationJobRepository;
  private readonly conversations: ConversationRepository;
  private readonly revisions: MemoryRevisionRepository;
  private readonly runs: RunRepository;
  private readonly extractor: MemoryCandidateExtractor;
  private readonly workerId: string;
  private readonly controls?: Pick<OperatorControlRepository, "isFeatureEnabled">;
  private readonly activeRuns = new Set<Promise<unknown>>();
  private stopping = false;

  public constructor(
    private readonly pool: Pool,
    private readonly settings: MemoryRevisionConsolidationWorkerSettings,
    dependencies: MemoryRevisionConsolidationWorkerDependencies = {},
  ) {
    this.jobs = dependencies.jobs ?? new MemoryConsolidationJobRepository(pool);
    this.conversations = dependencies.conversations ?? new ConversationRepository(pool);
    this.revisions = dependencies.revisions ?? new MemoryRevisionRepository(pool);
    this.runs = dependencies.runs ?? new RunRepository(pool);
    this.extractor = dependencies.extractor ?? { extract: extractMemoryCandidates };
    this.workerId = dependencies.workerId?.trim() || `memory-revision-consolidation-${randomUUID()}`;
    this.controls = dependencies.controls;
  }

  public stop(): void {
    this.stopping = true;
  }

  /**
   * Stop polling and wait for currently claimed jobs up to a bounded deadline.
   * Any leases still running after the deadline are requeued with an explicit
   * abandonment record so a successor can reclaim them without losing source
   * evidence.  The method intentionally does not pretend a timed-out job was
   * cancelled: the database lease is the authority for successor fencing.
   */
  public async shutdown(timeoutMs = 30_000): Promise<MemoryConsolidationShutdownResult> {
    this.stop();
    const active = [...this.activeRuns];
    if (!active.length) return { drained: true, abandoned: 0 };
    const timeout = Math.max(1, Math.min(Math.trunc(timeoutMs), 300_000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.allSettled(active).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeout);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (drained) return { drained: true, abandoned: 0 };
    const abandoned = await this.jobs.abandonLeases({
      workerId: this.workerId,
      reason: "MEMORY_WORKER_SHUTDOWN_TIMEOUT",
    });
    return { drained: false, abandoned };
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

  private async runOnceInternal(organizationId?: string): Promise<number> {
    const claimed = await runWithRequiredDatabaseContext(
      "memory-revision-consolidation-claim",
      { organizationId: "platform", actorId: "system:memory-revision-consolidation", operator: true },
      () => this.jobs.claimDue(this.workerId, this.settings.batchSize, this.settings.leaseMs, organizationId),
    );
    claimed.forEach((job) => recordQueueAge("memory_consolidation", Math.max(0, (Date.now() - new Date(job.created_at).getTime()) / 1000)));
    await Promise.all(claimed.map((job) => withSpan(
      "memory.revision.consolidation.job",
      { "memory.consolidation.version": job.extraction_version },
      () => this.process(job),
    )));
    return claimed.length;
  }

  public async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch (error) {
        operationalLogger.error({ err: error, event: "memory.revision.consolidation.poll.failed" }, "Memory revision consolidation poll failed");
      }
      if (!this.stopping) await new Promise((resolve) => setTimeout(resolve, this.settings.pollIntervalMs));
    }
  }

  private async process(job: MemoryConsolidationJobRecord): Promise<void> {
    return runWithRequiredDatabaseContext("memory-revision-consolidation-job", { organizationId: job.organization_id, actorId: "system:memory-revision-consolidation" }, () => this.processScoped(job));
  }

  private async processScoped(job: MemoryConsolidationJobRecord): Promise<void> {
    try {
      if (this.controls && !(await this.controls.isFeatureEnabled(job.organization_id, "memory_consolidation_enabled", job.installation_id))) {
        await this.jobs.releaseLease({ jobId: job.id, workerId: this.workerId, reason: "MEMORY_CONSOLIDATION_ROLLOUT_DISABLED" });
        recordMemoryConsolidation("rollout_disabled");
        return;
      }
      if (job.extraction_version !== MEMORY_EXTRACTION_VERSION) throw new Error(`Unsupported memory extraction version: ${job.extraction_version}`);
      const run = await this.runs.getRuntimeRunById(job.trigger_run_id);
      if (!run
        || run.organization_id !== job.organization_id
        || run.agent_definition_id !== job.agent_definition_id
        || run.agent_version_id !== job.agent_version_id
        || run.installation_id !== job.installation_id
        || run.conversation_id !== job.conversation_id) {
        throw new Error("Memory consolidation source run is outside the job scope");
      }
      const messages = await this.conversations.listMessages(job.organization_id, job.conversation_id);
      const evidence = selectConversationEvidence(messages);
      const inboundEvidenceCount = evidence.filter((entry) => entry.direction === "inbound").length;
      const memoryPolicy = memoryPolicyFromAgentPolicy(run.policy);
      const providerProjection = memoryPolicy.providerProjection;
      const mode = memoryPolicy.mode;
      if (mode !== "reviewed" && mode !== "automatic") {
        await this.jobs.markCompleted({ jobId: job.id, workerId: this.workerId, sourceMessageCount: inboundEvidenceCount, candidateCount: 0 });
        recordMemoryConsolidation("policy_skipped");
        return;
      }
      if (inboundEvidenceCount < this.settings.minInboundMessages && (!job.flush_reason || job.flush_reason === "threshold")) {
        await this.jobs.markCompleted({ jobId: job.id, workerId: this.workerId, sourceMessageCount: inboundEvidenceCount, candidateCount: 0 });
        recordMemoryConsolidation("threshold_skipped");
        return;
      }

      const evidenceById = new Map(evidence.map((item) => [item.id, item]));
      const evidenceDigest = createHash("sha256").update(JSON.stringify(evidence.map((item) => item.id))).digest("hex");
      const evidenceTimes = evidence.map((item) => item.createdAt).sort();
      if (typeof this.jobs.recordEvidenceWindow === "function") {
        const evidenceWindowRecorded = await this.jobs.recordEvidenceWindow({
          jobId: job.id,
          workerId: this.workerId,
          evidenceDigest,
          windowStart: evidenceTimes[0],
          windowEnd: evidenceTimes.at(-1),
          extractorModel: this.extractor.model ?? (run.resolved_model
            ? run.resolved_model.slice(0, 160)
            : undefined),
          extractorProvider: this.extractor.provider ?? run.resolved_model_provider?.slice(0, 160),
          parserVersion: MEMORY_EXTRACTION_VERSION,
        });
        if (!evidenceWindowRecorded) {
          throw Object.assign(new Error("Memory consolidation lease is no longer owned by this worker"), {
            code: "MEMORY_CONSOLIDATION_LEASE_LOST",
          });
        }
      }
      const workspaceId = workspaceIdForRun(run);
      const extractedCandidates = await extractWithDeadline(
        this.extractor,
        evidence,
        this.settings.extractionTimeoutMs ?? 30_000,
      );
      const candidates = validateExtractedCandidates(extractedCandidates, evidence);
      let persisted = 0;
      for (const candidate of candidates) {
        const sourceMessageIds = candidate.provenance.sourceMessageIds;
        const digest = candidateDigest({ sourceMessageIds, canonicalText: candidate.canonicalText, extractionVersion: candidate.provenance.extractionVersion });
        const subjectKey = candidate.content.category === "preference" ? `actor:${run.created_by}` : `conversation:${job.conversation_id}`;
        const predicateKey = candidate.content.category;
        const fact = await this.revisions.createFact({
          organizationId: job.organization_id,
          workspaceId,
          agentDefinitionId: job.agent_definition_id,
          installationId: job.installation_id,
          agentVersionId: job.agent_version_id,
          namespace: "agent_private",
          memoryType: candidate.memoryType,
          subjectKey,
          predicateKey,
          factKey: canonicalFactKey({ organizationId: job.organization_id, workspaceId, agentDefinitionId: job.agent_definition_id, installationId: job.installation_id, namespace: "agent_private", subject: subjectKey, predicate: predicateKey }),
        });
        const lastSource = [...sourceMessageIds].map((id) => evidenceById.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item)).sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1);
        const sourceOccurredAt = lastSource?.createdAt ?? new Date().toISOString();
        const revisionInput = {
          memoryType: candidate.memoryType,
          lifecycleState: "review_pending",
          canonicalText: candidate.canonicalText,
          typedValue: candidate.content,
          ...(candidate.memoryType === "episodic" ? { eventTime: sourceOccurredAt, eventSummary: candidate.canonicalText } : {}),
          validFrom: sourceOccurredAt,
          observedAt: sourceOccurredAt,
          confidence: candidate.confidence,
          sourceTrust: "model_inferred",
          sensitivity: candidate.sensitivity,
          provenance: { ...candidate.provenance, sourceRunId: job.trigger_run_id, workspaceId, retentionSuggestion: candidate.retentionSuggestion, relations: candidate.relations },
          evidenceDigest: digest,
          extractionVersion: candidate.provenance.extractionVersion,
          sourceEventIds: sourceMessageIds,
          sourceEventType: "conversation.message",
          sourceRunId: job.trigger_run_id,
          sourceOccurredAt,
          // The evidence digest is the replay boundary.  Do not include the
          // triggering run: one conversation can enqueue several threshold
          // jobs while the same bounded evidence window is still current.
          idempotencyKey: `memory-revision:${digest}`,
          createdBy: "system:memory-revision-consolidation",
          ...(providerProjection ? { providerProjection } : {}),
        } as const;
        const sourceRelations = candidate.relations.map((relation) => ({
          relationType: relation.type === "supports"
            ? "supports" as const
            : relation.type === "contradicts"
              ? "contradicts" as const
              : "derived_from" as const,
          sourceEventId: relation.sourceMessageId,
        }));
        if (sourceRelations.length) {
          await this.revisions.appendRevision(fact.id, revisionInput, undefined, sourceRelations);
        } else {
          await this.revisions.appendRevision(fact.id, revisionInput);
        }
        persisted += 1;
      }
      await this.jobs.markCompleted({ jobId: job.id, workerId: this.workerId, sourceMessageCount: inboundEvidenceCount, candidateCount: persisted });
      recordMemoryConsolidation(persisted ? "v2_candidates_proposed" : "v2_no_candidates", persisted);
    } catch (error) {
      const errorCode = extractorErrorCode(error);
      const status = await this.jobs.markRetryable({
        jobId: job.id,
        workerId: this.workerId,
        maxAttempts: this.settings.maxAttempts,
        errorCode,
        retryAfterMs: Math.min(86_400_000, 2_000 * (2 ** Math.min(Math.max(0, job.attempt_count - 1), 12))),
        error: { code: errorCode, message: error instanceof Error ? error.message : "Memory revision consolidation failed" },
      });
      recordMemoryConsolidation(status === "dead_letter" ? "failed" : "retryable_error");
      if (status === "dead_letter") operationalLogger.error({ err: error, event: "memory.revision.consolidation.failed", job_id: job.id }, "Memory revision consolidation job dead-lettered");
    }
  }
}
