import type { Pool } from "pg";
import type { PersistedExecutionJournalEvent } from "../journal";
import { query } from "../db/pool";

/**
 * Content-free graph vocabulary consumed by the future Studio observatory.
 * The graph is a projection of durable journal and memory rows; the browser
 * must never manufacture a stage or infer readiness from timing.
 */
export type MemoryObservatoryNodeKind =
  | "capture"
  | "working_context"
  | "compaction_checkpoint"
  | "consolidation_job"
  | "candidate_extraction"
  | "policy_decision"
  | "review"
  | "semantic_revision"
  | "episodic_revision"
  | "relation"
  | "projection"
  | "provider_visibility"
  | "retrieval_plan"
  | "evidence"
  | "retention"
  | "deletion"
  | "model"
  | "tool"
  | "run_stage";

export type MemoryObservatoryNodeStatus =
  | "pending"
  | "accepted"
  | "indexing"
  | "completed"
  | "blocked"
  | "failed"
  | "retrying"
  | "replayed";

export interface MemoryObservatoryScope {
  readonly organizationId: string;
  readonly installationId: string;
  readonly runId?: string;
}

export interface MemoryObservatoryNode {
  readonly id: string;
  readonly sequence?: number;
  readonly kind: MemoryObservatoryNodeKind;
  readonly status: MemoryObservatoryNodeStatus;
  readonly occurredAt: string;
  readonly scope: MemoryObservatoryScope;
  readonly sourceEventIds: readonly string[];
  readonly revisionIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly readiness?: "accepted" | "indexing" | "indexed" | "visible" | "blocked" | "deleted";
  readonly retryCount: number;
  readonly errorCode?: string;
  /** Bounded, content-free metadata safe for operator views and logs. */
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export interface MemoryObservatoryEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly relation: "causes" | "supports" | "contradicts" | "supersedes" | "derived_from" | "about";
}

export interface MemoryObservatoryGraph {
  readonly organizationId: string;
  readonly runId?: string;
  readonly cursor: number;
  readonly hasMore: boolean;
  readonly nodes: readonly MemoryObservatoryNode[];
  readonly edges: readonly MemoryObservatoryEdge[];
}

interface EventPayload {
  readonly type?: string;
  readonly runId?: string;
  readonly turnId?: string;
  readonly status?: string;
  readonly checkpointId?: string;
  readonly packId?: string;
  readonly errorCode?: string;
  readonly attemptId?: string;
  readonly diagnostics?: {
    readonly selectedRevisionIds?: readonly string[];
    readonly evidenceIds?: readonly string[];
    readonly candidateCount?: number;
    readonly latencyMs?: number;
  };
  readonly payload?: Record<string, unknown>;
}

const boundedId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 240 ? trimmed : undefined;
};

const idList = (value: unknown): string[] => Array.isArray(value)
  ? value.map(boundedId).filter((value): value is string => Boolean(value)).slice(0, 100)
  : [];

function payloadOf(event: PersistedExecutionJournalEvent): EventPayload {
  const data = event.event.data as unknown;
  return data && typeof data === "object" ? data as EventPayload : {};
}

function eventType(event: PersistedExecutionJournalEvent): string {
  const data = payloadOf(event);
  if (event.event.kind === "memory.integration") return data.type ?? "memory.integration";
  if (event.event.kind === "harness.turn") return data.type ?? "harness.turn";
  if (event.event.kind === "runtime.fact") return data.type ?? "runtime.fact";
  return event.event.kind;
}

function statusFor(type: string, payload: EventPayload): MemoryObservatoryNodeStatus {
  const status = payload.status;
  if (status === "replayed") return "replayed";
  if (status === "blocked") return "blocked";
  if (status === "failed") return "failed";
  if (status === "retrying") return "retrying";
  if (status === "requested" || status === "pending") return "pending";
  if (type.endsWith("requested") || type.endsWith("started") || type.endsWith("attempted")) return "pending";
  if (type.endsWith("blocked") || type.endsWith("deferred")) return "blocked";
  if (type.endsWith("failed") || type.endsWith("terminal")) return "failed";
  return "completed";
}

function kindFor(type: string): MemoryObservatoryNodeKind {
  if (type.includes("checkpoint") || type.includes("compaction")) return "compaction_checkpoint";
  if (type.includes("retrieval") || type.includes("evidence")) {
    return type.includes("requested") || type.includes("planned") || type.includes("blocked") ? "retrieval_plan" : "evidence";
  }
  if (type.includes("consolidat") || type.includes("extract")) return type.includes("extract") ? "candidate_extraction" : "consolidation_job";
  if (type.includes("policy") || type.includes("safety")) return "policy_decision";
  if (type.includes("review") || type.includes("approval")) return "review";
  if (type.includes("revision") || type.includes("supersed") || type.includes("conflict")) return type.includes("episodic") ? "episodic_revision" : "semantic_revision";
  if (type.includes("projection") || type.includes("index")) return type.includes("provider") ? "provider_visibility" : "projection";
  if (type.includes("retention") || type.includes("expire")) return "retention";
  if (type.includes("delet") || type.includes("purge")) return "deletion";
  if (type.includes("context")) return "working_context";
  if (type.includes("model")) return "model";
  if (type.includes("tool")) return "tool";
  if (type.includes("capture") || type.includes("source")) return "capture";
  return "run_stage";
}

function metadataFor(event: PersistedExecutionJournalEvent, payload: EventPayload): Readonly<Record<string, string | number | boolean>> {
  const metadata: Record<string, string | number | boolean> = { eventKind: event.event.kind, eventType: eventType(event) };
  for (const key of ["turnId", "attemptId", "checkpointId", "packId", "runId"]) {
    const value = boundedId(payload[key as keyof EventPayload]);
    if (value) metadata[key] = value;
  }
  const diagnostics = payload.diagnostics;
  if (diagnostics?.candidateCount !== undefined) metadata.candidateCount = Math.max(0, Math.trunc(diagnostics.candidateCount));
  if (diagnostics?.latencyMs !== undefined) metadata.latencyMs = Math.max(0, Math.trunc(diagnostics.latencyMs));
  return metadata;
}

/** Project one durable journal event without copying raw payload content. */
export function projectExecutionJournalEvent(event: PersistedExecutionJournalEvent): MemoryObservatoryNode {
  const payload = payloadOf(event);
  const type = eventType(event);
  const diagnostics = payload.diagnostics;
  const sourceEventIds = idList((payload as Record<string, unknown>).sourceEventIds);
  const revisionIds = idList(diagnostics?.selectedRevisionIds ?? (payload as Record<string, unknown>).revisionIds);
  const evidenceIds = idList(diagnostics?.evidenceIds ?? (payload as Record<string, unknown>).evidenceIds);
  const readiness = type.includes("provider") || type.includes("projection")
    ? (payload.status === "visible" ? "visible" : payload.status === "indexed" ? "indexed" : payload.status === "accepted" ? "accepted" : payload.status === "indexing" ? "indexing" : undefined)
    : undefined;
  const retryCount = typeof (payload as Record<string, unknown>).retryCount === "number"
    ? Math.max(0, Math.trunc((payload as Record<string, unknown>).retryCount as number))
    : 0;
  return {
    id: event.id,
    sequence: event.sequence,
    kind: kindFor(type),
    status: statusFor(type, payload),
    occurredAt: event.occurredAt,
    scope: { organizationId: event.scope.organizationId, installationId: event.scope.installationId, runId: event.scope.runId },
    sourceEventIds,
    revisionIds,
    evidenceIds,
    ...(readiness ? { readiness } : {}),
    retryCount,
    ...(boundedId(payload.errorCode) ? { errorCode: boundedId(payload.errorCode) } : {}),
    metadata: metadataFor(event, payload),
  };
}

export function projectExecutionJournalGraph(events: readonly PersistedExecutionJournalEvent[], limit = 200): MemoryObservatoryGraph {
  const nodes = events.slice(0, Math.max(1, Math.min(limit, 200))).map(projectExecutionJournalEvent);
  const edges: MemoryObservatoryEdge[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    const from = nodes[index - 1]!;
    const to = nodes[index]!;
    edges.push({ id: `${from.id}:${to.id}:causes`, from: from.id, to: to.id, relation: "causes" });
  }
  for (const node of nodes) {
    const relation = node.metadata.eventType;
    if (!relation) continue;
    for (const revisionId of node.revisionIds) {
      edges.push({ id: `${node.id}:${revisionId}:about`, from: node.id, to: revisionId, relation: "about" });
    }
  }
  const last = nodes[nodes.length - 1];
  return {
    organizationId: events[0]?.scope.organizationId ?? "",
    ...(events[0]?.scope.runId ? { runId: events[0].scope.runId } : {}),
    cursor: last?.sequence ?? 0,
    hasMore: events.length > nodes.length,
    nodes,
    edges,
  };
}

export interface RevisionLineageRow {
  revision_id: string;
  organization_id: string;
  installation_id: string;
  run_id: string | null;
  memory_type: "semantic" | "episodic";
  lifecycle_state: string;
  transition_type: string;
  valid_from: string | Date;
  accepted_at: string | Date | null;
  indexed_at: string | Date | null;
  visible_at: string | Date | null;
  source_event_id: string | null;
  source_run_id: string | null;
  relation_id: string | null;
  from_revision_id: string | null;
  to_revision_id: string | null;
  relation_type: MemoryObservatoryEdge["relation"] | null;
}

/** Build a content-free memory view from canonical revision/source/relation rows. */
export function projectMemoryRevisionLineage(rows: readonly RevisionLineageRow[]): MemoryObservatoryGraph {
  const nodes = new Map<string, MemoryObservatoryNode>();
  const edges: MemoryObservatoryEdge[] = [];
  for (const row of rows) {
    const revisionNodeId = `revision:${row.revision_id}`;
    if (!nodes.has(revisionNodeId)) {
      const status: MemoryObservatoryNodeStatus = row.lifecycle_state === "deleted" || row.lifecycle_state === "expired" ? "blocked"
        : row.lifecycle_state === "candidate" || row.lifecycle_state === "review_pending" ? "pending"
          : row.lifecycle_state === "quarantined" ? "blocked" : "completed";
      const readiness = row.visible_at ? "visible" : row.indexed_at ? "indexed" : row.accepted_at ? "accepted" : undefined;
      nodes.set(revisionNodeId, {
        id: revisionNodeId,
        kind: row.memory_type === "episodic" ? "episodic_revision" : "semantic_revision",
        status,
        occurredAt: new Date(row.valid_from).toISOString(),
        scope: { organizationId: row.organization_id, installationId: row.installation_id, ...(row.run_id ? { runId: row.run_id } : {}) },
        sourceEventIds: [],
        revisionIds: [row.revision_id],
        evidenceIds: [],
        ...(readiness ? { readiness } : {}),
        retryCount: 0,
        metadata: { memoryType: row.memory_type, lifecycleState: row.lifecycle_state, transitionType: row.transition_type },
      });
    }
    if (row.source_event_id) {
      const sourceNodeId = `source:${row.source_event_id}`;
      if (!nodes.has(sourceNodeId)) {
        nodes.set(sourceNodeId, {
          id: sourceNodeId,
          kind: "capture",
          status: "completed",
          occurredAt: new Date(row.valid_from).toISOString(),
          scope: { organizationId: row.organization_id, installationId: row.installation_id, ...(row.source_run_id ? { runId: row.source_run_id } : {}) },
          sourceEventIds: [row.source_event_id],
          revisionIds: [],
          evidenceIds: [],
          retryCount: 0,
          metadata: { eventType: "memory.source" },
        });
      }
      edges.push({ id: `${sourceNodeId}:${revisionNodeId}:derived_from`, from: sourceNodeId, to: revisionNodeId, relation: "derived_from" });
    }
    if (row.relation_id && row.from_revision_id && row.to_revision_id && row.relation_type) {
      edges.push({ id: row.relation_id, from: `revision:${row.from_revision_id}`, to: `revision:${row.to_revision_id}`, relation: row.relation_type });
    }
  }
  return {
    organizationId: rows[0]?.organization_id ?? "",
    ...(rows[0]?.run_id ? { runId: rows[0].run_id } : {}),
    cursor: 0,
    hasMore: false,
    nodes: [...nodes.values()],
    edges: [...new Map(edges.map((edge) => [edge.id, edge])).values()],
  };
}

interface JournalRow {
  id: string;
  organization_id: string;
  installation_id: string;
  run_id: string;
  operation_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  sequence_number: string | number;
  event: PersistedExecutionJournalEvent["event"];
  occurred_at: string | Date;
}

/** Scoped, cursor-backed read model for the future Studio observatory. */
export class MemoryObservatoryRepository {
  public constructor(private readonly pool: Pool) {}

  public async listRun(input: { organizationId: string; runId: string; afterSequence?: number; limit?: number }): Promise<MemoryObservatoryGraph> {
    const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 200), 200));
    const result = await query<JournalRow>(this.pool, `
      SELECT id, organization_id, installation_id, run_id, operation_id,
             correlation_id, causation_id, sequence_number, event, occurred_at
      FROM agent_execution_journal_events
      WHERE organization_id = $1 AND run_id = $2::uuid
        AND sequence_number > $3
      ORDER BY sequence_number ASC
      LIMIT $4`, [input.organizationId, input.runId, Math.max(0, Math.trunc(input.afterSequence ?? 0)), limit + 1]);
    const events: PersistedExecutionJournalEvent[] = result.rows.map((row) => ({
      id: row.id,
      sequence: Number(row.sequence_number),
      occurredAt: new Date(row.occurred_at).toISOString(),
      scope: {
        organizationId: row.organization_id,
        installationId: row.installation_id,
        runId: row.run_id,
        ...(row.operation_id ? { operationId: row.operation_id } : {}),
        ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
        ...(row.causation_id ? { causationId: row.causation_id } : {}),
      },
      event: row.event,
    }));
    return projectExecutionJournalGraph(events, limit);
  }

  public async listRevision(input: { organizationId: string; revisionId: string }): Promise<MemoryObservatoryGraph> {
    const result = await query<RevisionLineageRow>(this.pool, `
      WITH target_scope AS (
        SELECT fact.organization_id, fact.workspace_id, fact.installation_id,
               fact.agent_definition_id, fact.agent_version_id, fact.namespace,
               fact.conversation_id, fact.end_user_id
        FROM agent_memory_revisions target_revision
        JOIN agent_memory_facts fact ON fact.id = target_revision.fact_id
        WHERE target_revision.organization_id = $1 AND target_revision.id = $2::uuid
      )
      SELECT revision.id AS revision_id, revision.organization_id,
             fact.installation_id, source.source_run_id AS run_id,
             fact.memory_type, revision.lifecycle_state, revision.transition_type,
             revision.valid_from, revision.accepted_at, revision.indexed_at, revision.visible_at,
             source.source_event_id, source.source_run_id,
             relation.id AS relation_id, relation.from_revision_id, relation.to_revision_id,
             relation.relation_type
      FROM agent_memory_revisions revision
      JOIN agent_memory_facts fact ON fact.id = revision.fact_id
      JOIN target_scope target
       ON target.organization_id = fact.organization_id
       AND target.workspace_id = fact.workspace_id
       AND target.installation_id = fact.installation_id
       AND target.agent_definition_id = fact.agent_definition_id
       AND target.agent_version_id IS NOT DISTINCT FROM fact.agent_version_id
       AND target.namespace = fact.namespace
       AND target.conversation_id IS NOT DISTINCT FROM fact.conversation_id
       AND target.end_user_id IS NOT DISTINCT FROM fact.end_user_id
      LEFT JOIN agent_memory_revision_sources source
        ON source.revision_id = revision.id AND source.organization_id = revision.organization_id
      LEFT JOIN agent_memory_relations relation
        ON relation.organization_id = revision.organization_id
       AND (relation.from_revision_id = revision.id OR relation.to_revision_id = revision.id)
      WHERE revision.organization_id = $1 AND (revision.id = $2::uuid
        OR relation.from_revision_id = $2::uuid OR relation.to_revision_id = $2::uuid)
      ORDER BY revision.valid_from ASC, source.created_at ASC NULLS LAST`, [input.organizationId, input.revisionId]);
    return projectMemoryRevisionLineage(result.rows);
  }
}
