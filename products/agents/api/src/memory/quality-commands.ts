import { createHash } from "node:crypto";
import type { MemoryRevisionRepository } from "../db/repositories/memory-revision-repository";
import { MemoryRetentionRepository, type MemoryRetentionCandidate } from "../db/repositories/memory-retention-repository";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Explicit quality signals are append-only and scoped. They are intentionally
 * separate from revision commands so a retrieval/read path cannot silently
 * mutate memory truth.
 */
export class MemoryQualityCommandService {
  public constructor(
    private readonly repository: MemoryRetentionRepository,
    private readonly revisions: MemoryRevisionRepository,
  ) {}

  public async recordUsage(input: Omit<Parameters<MemoryRetentionRepository["recordQualityEvent"]>[0], "eventType" | "sourceDigest"> & { sourceDigest?: string }): Promise<void> {
    await this.repository.recordQualityEvent({
      ...input,
      eventType: "usage",
      sourceDigest: input.sourceDigest ?? digest({ type: "usage", target: input.revisionId ?? input.factId, run: input.sourceRunId }),
    });
  }

  public async recordConfirmation(input: Omit<Parameters<MemoryRetentionRepository["recordQualityEvent"]>[0], "eventType" | "sourceDigest"> & { sourceDigest?: string }): Promise<void> {
    await this.repository.recordQualityEvent({
      ...input,
      eventType: "confirmation",
      sourceDigest: input.sourceDigest ?? digest({ type: "confirmation", target: input.revisionId ?? input.factId, actor: input.actorId }),
    });
  }

  public async recordCorrection(input: Omit<Parameters<MemoryRetentionRepository["recordQualityEvent"]>[0], "eventType" | "sourceDigest"> & { sourceDigest?: string }): Promise<void> {
    await this.repository.recordQualityEvent({
      ...input,
      eventType: "correction",
      sourceDigest: input.sourceDigest ?? digest({ type: "correction", target: input.revisionId ?? input.factId, run: input.sourceRunId }),
    });
  }

  public async recordRejection(input: Omit<Parameters<MemoryRetentionRepository["recordQualityEvent"]>[0], "eventType" | "sourceDigest"> & { sourceDigest?: string }): Promise<void> {
    await this.repository.recordQualityEvent({
      ...input,
      eventType: "rejection",
      sourceDigest: input.sourceDigest ?? digest({ type: "rejection", target: input.revisionId ?? input.factId, actor: input.actorId }),
    });
  }

  public async recordHelpfulness(input: Omit<Parameters<MemoryRetentionRepository["recordQualityEvent"]>[0], "eventType" | "sourceDigest" | "helpfulness"> & { helpfulness: -1 | 0 | 1; sourceDigest?: string }): Promise<void> {
    await this.repository.recordQualityEvent({
      ...input,
      eventType: "helpfulness",
      sourceDigest: input.sourceDigest ?? digest({ type: "helpfulness", target: input.revisionId ?? input.factId, value: input.helpfulness }),
    });
  }

  /**
   * Revalidation is an explicit assertion of continued truth. It appends a
   * revision rather than updating or resetting the original revision.
   */
  public async revalidate(input: {
    candidate: Pick<MemoryRetentionCandidate, "factId" | "revisionId" | "memoryType" | "canonicalText" | "typedValue" | "eventTime" | "eventSummary" | "observedAt" | "confidence" | "sensitivity" | "organizationId" | "workspaceId" | "agentDefinitionId" | "installationId" | "conversationId" | "endUserId" | "provenance" | "evidenceDigest" | "extractionVersion"> & { conversationId?: string; endUserId?: string };
    actorId: string;
    idempotencyKey: string;
    now?: string;
  }): Promise<{ status: "created" | "replayed"; revisionId: string }> {
    const now = input.now ?? new Date().toISOString();
    const sourceEventId = `memory-revalidation:${input.candidate.revisionId}:${digest({ idempotencyKey: input.idempotencyKey })}`;
    const result = await this.revisions.appendRevision(input.candidate.factId, {
      memoryType: input.candidate.memoryType,
      transitionType: "revalidation",
      lifecycleState: "active",
      canonicalText: input.candidate.canonicalText,
      typedValue: input.candidate.typedValue,
      ...(input.candidate.memoryType === "episodic" ? {
        eventTime: input.candidate.eventTime ?? input.candidate.observedAt,
        eventSummary: input.candidate.eventSummary ?? input.candidate.canonicalText,
      } : {}),
      validFrom: now,
      observedAt: now,
      ...(input.candidate.confidence === undefined ? {} : { confidence: input.candidate.confidence }),
      sourceTrust: "user_explicit",
      sensitivity: input.candidate.sensitivity,
      provenance: { ...input.candidate.provenance, revalidatedFrom: input.candidate.revisionId },
      evidenceDigest: digest({ source: input.candidate.revisionId, now, idempotencyKey: input.idempotencyKey }),
      extractionVersion: input.candidate.extractionVersion,
      sourceEventIds: [sourceEventId],
      sourceEventType: "memory.revalidation",
      sourceOccurredAt: now,
      redactionClass: "standard",
      predecessorRevisionId: input.candidate.revisionId,
      idempotencyKey: input.idempotencyKey,
      createdBy: input.actorId,
    });
    await this.repository.recordQualityEvent({
      organizationId: input.candidate.organizationId,
      workspaceId: input.candidate.workspaceId,
      agentDefinitionId: input.candidate.agentDefinitionId,
      installationId: input.candidate.installationId,
      ...(input.candidate.conversationId ? { conversationId: input.candidate.conversationId } : {}),
      ...(input.candidate.endUserId ? { endUserId: input.candidate.endUserId } : {}),
      revisionId: result.revision.id,
      eventType: "revalidation_completed",
      actorType: "operator",
      actorId: input.actorId,
      sourceDigest: digest({ type: "revalidation_completed", revisionId: result.revision.id }),
      idempotencyKey: `${input.idempotencyKey}:quality`,
      occurredAt: now,
    });
    await this.repository.completeRevalidation({
      organizationId: input.candidate.organizationId,
      revisionId: input.candidate.revisionId,
      outcome: "revalidated",
    });
    return { status: result.status, revisionId: result.revision.id };
  }
}
