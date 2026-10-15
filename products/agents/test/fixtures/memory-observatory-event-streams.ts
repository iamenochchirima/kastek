import type { PersistedExecutionJournalEvent } from "../../src/journal";

const makeEvent = (sequence: number, type: string, payload: Record<string, unknown> = {}): PersistedExecutionJournalEvent => ({
  id: `fixture-event-${sequence}`,
  sequence,
  occurredAt: `2026-09-08T00:00:${String(sequence).padStart(2, "0")}.000Z`,
  scope: { organizationId: "fixture-org", installationId: "fixture-installation", runId: "fixture-run" },
  event: { kind: "memory.integration", data: { type: type as never, runId: "fixture-run", turnId: "fixture-turn", ...payload } },
});

/** Content-free event streams used to replay every backend observatory state. */
export const memoryObservatoryFixtures = {
  workerFailure: [
    makeEvent(1, "memory_checkpoint_committed", { status: "committed" }),
    makeEvent(2, "memory_consolidation_requested", { status: "requested" }),
    makeEvent(3, "memory_consolidation_failed", { status: "failed", errorCode: "MEMORY_MODEL_TIMEOUT", retryCount: 1 }),
    makeEvent(4, "memory_consolidation_retrying", { status: "retrying", retryCount: 2 }),
  ],
  projectionLag: [
    makeEvent(1, "memory_revision_committed", { status: "completed", revisionIds: ["fixture-revision"] }),
    makeEvent(2, "memory_projection_accepted", { status: "accepted", revisionIds: ["fixture-revision"] }),
    makeEvent(3, "memory_projection_indexing", { status: "indexing", revisionIds: ["fixture-revision"] }),
  ],
  deletionHold: [
    makeEvent(1, "memory_deletion_requested", { status: "requested" }),
    makeEvent(2, "memory_deletion_blocked", { status: "blocked", errorCode: "MEMORY_LEGAL_HOLD" }),
  ],
};
