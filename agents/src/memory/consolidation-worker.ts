import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ConversationRepository } from "../db/repositories/conversation-repository";
import { runWithRequiredDatabaseContext } from "../db/context";
import { MemoryConsolidationJobRepository, type MemoryConsolidationJobRecord } from "../db/repositories/memory-consolidation-job-repository";
import { MemoryRepository } from "../db/repositories/memory-repository";
import { RunRepository } from "../db/repositories/run-repository";
import { operationalLogger } from "../telemetry/logger";
import { recordMemoryConsolidation, recordQueueAge, withSpan } from "../telemetry/spans";
import { MemoryLifecycle } from "./lifecycle";
import { extractMemoryCandidates, MEMORY_EXTRACTION_VERSION, selectConversationEvidence } from "./consolidation";

export interface MemoryConsolidationWorkerSettings {
  batchSize: number;
  leaseMs: number;
  pollIntervalMs: number;
  maxAttempts: number;
  minInboundMessages: number;
}

export interface MemoryConsolidationWorkerDependencies {
  jobs?: MemoryConsolidationJobRepository;
  conversations?: ConversationRepository;
  memory?: MemoryRepository;
  runs?: RunRepository;
  workerId?: string;
}

export class MemoryConsolidationWorker {
  private readonly jobs: MemoryConsolidationJobRepository;
  private readonly conversations: ConversationRepository;
  private readonly memory: MemoryRepository;
  private readonly runs: RunRepository;
  private readonly lifecycle: MemoryLifecycle;
  private readonly workerId: string;
  private stopping = false;

  public constructor(
    private readonly pool: Pool,
    private readonly settings: MemoryConsolidationWorkerSettings,
    dependencies: MemoryConsolidationWorkerDependencies = {},
  ) {
    this.jobs = dependencies.jobs ?? new MemoryConsolidationJobRepository(pool);
    this.conversations = dependencies.conversations ?? new ConversationRepository(pool);
    this.memory = dependencies.memory ?? new MemoryRepository(pool);
    this.runs = dependencies.runs ?? new RunRepository(pool);
    this.lifecycle = new MemoryLifecycle(this.memory);
    this.workerId = dependencies.workerId?.trim() || `memory-consolidation-${randomUUID()}`;
  }

  public stop(): void {
    this.stopping = true;
  }

  public async runOnce(organizationId?: string): Promise<number> {
    const claimed = await runWithRequiredDatabaseContext(
      "memory-consolidation-claim",
      { organizationId: "platform", actorId: "system:memory-consolidation", operator: true },
      () => this.jobs.claimDue(this.workerId, this.settings.batchSize, this.settings.leaseMs, organizationId),
    );
    claimed.forEach((job) => recordQueueAge("memory_consolidation", Math.max(0, (Date.now() - new Date(job.created_at).getTime()) / 1000)));
    await Promise.all(claimed.map((job) => withSpan(
      "memory.consolidation.job",
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
        operationalLogger.error({ err: error, event: "memory.consolidation.poll.failed" }, "Memory consolidation poll failed");
      }
      if (!this.stopping) await new Promise((resolve) => setTimeout(resolve, this.settings.pollIntervalMs));
    }
  }

  private async process(job: MemoryConsolidationJobRecord): Promise<void> {
    return runWithRequiredDatabaseContext("memory-consolidation-job", { organizationId: job.organization_id, actorId: "system:memory-consolidation" }, () => this.processScoped(job));
  }

  private async processScoped(job: MemoryConsolidationJobRecord): Promise<void> {
    try {
      if (job.extraction_version !== MEMORY_EXTRACTION_VERSION) {
        throw new Error(`Unsupported memory extraction version: ${job.extraction_version}`);
      }
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
      const policy = this.lifecycle.policy(run.policy);
      if (policy.mode !== "reviewed" && policy.mode !== "automatic") {
        await this.jobs.markCompleted({ jobId: job.id, workerId: this.workerId, sourceMessageCount: inboundEvidenceCount, candidateCount: 0 });
        recordMemoryConsolidation("policy_skipped");
        return;
      }
      if (inboundEvidenceCount < this.settings.minInboundMessages) {
        await this.jobs.markCompleted({ jobId: job.id, workerId: this.workerId, sourceMessageCount: inboundEvidenceCount, candidateCount: 0 });
        recordMemoryConsolidation("threshold_skipped");
        return;
      }

      const candidates = extractMemoryCandidates(evidence);
      let persisted = 0;
      for (const candidate of candidates) {
        const sourceMessageIds = candidate.provenance.sourceMessageIds;
        const scope = {
          organizationId: job.organization_id,
          agentId: job.agent_definition_id,
          installationId: job.installation_id,
          conversationId: job.conversation_id,
          actorId: run.created_by,
          runId: job.trigger_run_id,
        };
        if (await this.memory.hasConsolidationCandidate({ scope, sourceMessageIds, extractionVersion: candidate.provenance.extractionVersion })) continue;
        await this.lifecycle.rememberInferred(scope, candidate, run.policy);
        persisted += 1;
      }
      await this.jobs.markCompleted({ jobId: job.id, workerId: this.workerId, sourceMessageCount: inboundEvidenceCount, candidateCount: persisted });
      recordMemoryConsolidation(persisted ? "candidates_proposed" : "no_candidates", persisted);
    } catch (error) {
      const status = await this.jobs.markRetryable({
        jobId: job.id,
        workerId: this.workerId,
        maxAttempts: this.settings.maxAttempts,
        error: { code: "MEMORY_CONSOLIDATION_FAILED", message: error instanceof Error ? error.message : "Memory consolidation failed" },
      });
      recordMemoryConsolidation(status === "failed" ? "failed" : "retryable_error");
      if (status === "failed") {
        operationalLogger.error({ err: error, event: "memory.consolidation.failed", job_id: job.id }, "Memory consolidation job failed permanently");
      }
    }
  }
}
