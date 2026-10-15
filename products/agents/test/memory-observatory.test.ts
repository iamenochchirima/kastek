import { describe, expect, it } from "vitest";
import { projectExecutionJournalEvent, projectExecutionJournalGraph, projectMemoryRevisionLineage } from "../src/memory/observatory";
import type { PersistedExecutionJournalEvent } from "../src/journal";
import { memoryObservatoryFixtures } from "./fixtures/memory-observatory-event-streams";

const event = (sequence: number, type: string, payload: Record<string, unknown> = {}): PersistedExecutionJournalEvent => ({
  id: `event-${sequence}`,
  sequence,
  occurredAt: `2026-09-08T00:00:0${sequence}.000Z`,
  scope: { organizationId: "org-a", installationId: "install-a", runId: "run-a" },
  event: { kind: "memory.integration", data: { type: type as never, runId: "run-a", turnId: "turn-a", ...payload } },
});

describe("memory observatory projection", () => {
  it("projects only real durable stages and redacts arbitrary payload content", () => {
    const node = projectExecutionJournalEvent(event(1, "memory_retrieval_completed", {
      status: "completed",
      diagnostics: { selectedRevisionIds: ["revision-a"], evidenceIds: ["evidence-a"], candidateCount: 2, latencyMs: 12 },
      rawMessage: "must never reach the graph",
    }));
    expect(node.kind).toBe("evidence");
    expect(node.status).toBe("completed");
    expect(node.revisionIds).toEqual(["revision-a"]);
    expect(node.evidenceIds).toEqual(["evidence-a"]);
    expect(node.metadata).not.toHaveProperty("rawMessage");
  });

  it("maps blocked and provider readiness states without inventing completion", () => {
    const blocked = projectExecutionJournalEvent(event(1, "memory_retrieval_blocked", { status: "blocked", errorCode: "MEMORY_SCOPE_BLOCKED" }));
    const indexing = projectExecutionJournalEvent(event(2, "memory_projection_updated", { status: "indexing" }));
    expect(blocked.kind).toBe("retrieval_plan");
    expect(blocked.status).toBe("blocked");
    expect(blocked.errorCode).toBe("MEMORY_SCOPE_BLOCKED");
    expect(indexing.readiness).toBe("indexing");
    expect(indexing.status).toBe("completed");
  });

  it("provides an ordered cursor and causal edges for reconnect", () => {
    const graph = projectExecutionJournalGraph([
      event(1, "memory_checkpoint_requested"),
      event(2, "memory_checkpoint_committed", { status: "committed", checkpointId: "checkpoint-a" }),
      event(3, "memory_retrieval_requested", { status: "requested" }),
    ]);
    expect(graph.cursor).toBe(3);
    expect(graph.hasMore).toBe(false);
    expect(graph.nodes.map((node) => node.sequence)).toEqual([1, 2, 3]);
    expect(graph.edges.filter((edge) => edge.relation === "causes")).toHaveLength(2);
  });

  it("projects source lineage and supersession without exposing canonical text", () => {
    const graph = projectMemoryRevisionLineage([
      {
        revision_id: "revision-new", organization_id: "org-a", installation_id: "install-a", run_id: "run-a",
        memory_type: "semantic", lifecycle_state: "active", transition_type: "correction", valid_from: "2026-09-08T00:00:00.000Z",
        accepted_at: "2026-09-08T00:00:01.000Z", indexed_at: "2026-09-08T00:00:02.000Z", visible_at: null,
        source_event_id: "source-a", source_run_id: "run-a", relation_id: "relation-a", from_revision_id: "revision-new", to_revision_id: "revision-old", relation_type: "supersedes",
      },
      {
        revision_id: "revision-old", organization_id: "org-a", installation_id: "install-a", run_id: "run-a",
        memory_type: "semantic", lifecycle_state: "superseded", transition_type: "assertion", valid_from: "2026-09-07T00:00:00.000Z",
        accepted_at: "2026-09-07T00:00:01.000Z", indexed_at: null, visible_at: null,
        source_event_id: "source-old", source_run_id: "run-a", relation_id: "relation-a", from_revision_id: "revision-new", to_revision_id: "revision-old", relation_type: "supersedes",
      },
    ]);
    expect(graph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["source:source-a", "revision:revision-new", "revision:revision-old"]));
    expect(graph.edges).toEqual(expect.arrayContaining([expect.objectContaining({ relation: "supersedes", from: "revision:revision-new", to: "revision:revision-old" })]));
    expect(graph.nodes.every((node) => !Object.prototype.hasOwnProperty.call(node.metadata, "canonicalText"))).toBe(true);
  });

  it("replays worker failure, provider lag, and deletion hold fixtures", () => {
    expect(projectExecutionJournalGraph(memoryObservatoryFixtures.workerFailure).nodes.map((node) => node.status)).toEqual(["completed", "pending", "failed", "retrying"]);
    expect(projectExecutionJournalGraph(memoryObservatoryFixtures.projectionLag).nodes.map((node) => node.readiness)).toEqual([undefined, "accepted", "indexing"]);
    expect(projectExecutionJournalGraph(memoryObservatoryFixtures.deletionHold).nodes.at(-1)?.status).toBe("blocked");
  });
});
