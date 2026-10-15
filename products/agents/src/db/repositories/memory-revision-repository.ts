import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { query, withTransaction } from "../pool";
import { enqueueMemoryLifecycleEvent } from "../../analytics/memory";
import {
  assertMemoryRevisionTransition,
  memoryRevisionFingerprint,
  normalizeMemoryFactIdentity,
  normalizeMemoryRevisionInput,
  resolveCurrentMemoryRevision,
  assertExpectedPredecessor,
  type MemoryFactIdentity,
  type MemoryRevisionInput,
  type MemoryRevisionRecord,
  type MemoryRelationInput,
  type MemoryRelationRecord,
} from "../../memory/revisions";

export interface MemorySourceRelationInput {
  relationType: MemoryRelationInput["relationType"];
  sourceEventId: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryFactRecord extends MemoryFactIdentity {
  id: string;
  createdBy: string;
  createdAt: string;
}

interface MemoryFactRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  agent_definition_id: string;
  installation_id: string;
  agent_version_id: string | null;
  conversation_id: string | null;
  end_user_id: string | null;
  namespace: MemoryFactIdentity["namespace"];
  memory_type: MemoryFactIdentity["memoryType"];
  subject_key: string;
  predicate_key: string;
  fact_key: string;
  created_by: string;
  created_at: string | Date;
}

interface MemoryRevisionRow {
  id: string;
  fact_id: string;
  organization_id: string;
  revision_number: number | string;
  transition_type: MemoryRevisionRecord["transitionType"];
  lifecycle_state: MemoryRevisionRecord["lifecycleState"];
  canonical_text: string;
  typed_value: Record<string, unknown>;
  event_time: string | Date | null;
  event_summary: string | null;
  participants: readonly Record<string, unknown>[];
  outcome: string | null;
  valid_from: string | Date;
  valid_to: string | Date | null;
  observed_at: string | Date | null;
  recorded_at: string | Date;
  confidence: number | string | null;
  source_trust: MemoryRevisionRecord["sourceTrust"];
  sensitivity: MemoryRevisionRecord["sensitivity"];
  provenance: Record<string, unknown>;
  evidence_digest: string;
  extraction_version: string;
  predecessor_revision_id: string | null;
  idempotency_key: string;
  operation_fingerprint: string;
  accepted_at: string | Date | null;
  committed_at: string | Date;
  indexed_at: string | Date | null;
  visible_at: string | Date | null;
  created_by: string;
  created_at: string | Date;
  source_event_ids: string[];
  memory_type: MemoryRevisionRecord["memoryType"];
}

export type MemoryRevisionWriteStatus = "created" | "replayed";

export interface MemoryRevisionWriteResult {
  status: MemoryRevisionWriteStatus;
  revision: MemoryRevisionRecord;
}

function asIso(value: string | Date | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return new Date(value).toISOString();
}

function factFromRow(row: MemoryFactRow): MemoryFactRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    agentDefinitionId: row.agent_definition_id,
    installationId: row.installation_id,
    ...(row.agent_version_id ? { agentVersionId: row.agent_version_id } : {}),
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    ...(row.end_user_id ? { endUserId: row.end_user_id } : {}),
    namespace: row.namespace,
    memoryType: row.memory_type,
    subjectKey: row.subject_key,
    predicateKey: row.predicate_key,
    factKey: row.fact_key,
    createdBy: row.created_by,
    createdAt: asIso(row.created_at)!,
  };
}

function revisionFromRow(row: MemoryRevisionRow): MemoryRevisionRecord {
  return {
    id: row.id,
    factId: row.fact_id,
    memoryType: "semantic", // Replaced by the joined fact type in repository reads.
    transitionType: row.transition_type,
    lifecycleState: row.lifecycle_state,
    canonicalText: row.canonical_text,
    typedValue: row.typed_value ?? {},
    ...(asIso(row.event_time) ? { eventTime: asIso(row.event_time) } : {}),
    ...(row.event_summary ? { eventSummary: row.event_summary } : {}),
    participants: row.participants ?? [],
    ...(row.outcome ? { outcome: row.outcome } : {}),
    validFrom: asIso(row.valid_from)!,
    ...(asIso(row.valid_to) ? { validTo: asIso(row.valid_to) } : {}),
    ...(asIso(row.observed_at) ? { observedAt: asIso(row.observed_at) } : {}),
    ...(row.confidence === null ? {} : { confidence: Number(row.confidence) }),
    sourceTrust: row.source_trust,
    sensitivity: row.sensitivity,
    provenance: row.provenance ?? {},
    evidenceDigest: row.evidence_digest,
    extractionVersion: row.extraction_version,
    sourceEventIds: row.source_event_ids ?? [],
    ...(asIso(row.accepted_at) ? { acceptedAt: asIso(row.accepted_at) } : {}),
    ...(row.predecessor_revision_id ? { predecessorRevisionId: row.predecessor_revision_id } : {}),
    idempotencyKey: row.idempotency_key,
    createdBy: row.created_by,
    revisionNumber: Number(row.revision_number),
    committedAt: asIso(row.committed_at)!,
    createdAt: asIso(row.created_at)!,
  };
}

const factColumns = `
  id, organization_id, workspace_id, agent_definition_id, installation_id, agent_version_id,
  conversation_id, end_user_id, namespace, memory_type, subject_key, predicate_key,
  fact_key, created_by, created_at`;

const revisionColumns = `
  revision.id, revision.fact_id, revision.organization_id, revision.revision_number,
  revision.transition_type, revision.lifecycle_state, revision.canonical_text,
  revision.typed_value, revision.event_time, revision.event_summary, revision.participants,
  revision.outcome, revision.valid_from, revision.valid_to, revision.observed_at,
  revision.recorded_at, revision.confidence, revision.source_trust, revision.sensitivity,
  revision.provenance, revision.evidence_digest, revision.extraction_version,
  revision.predecessor_revision_id, revision.idempotency_key, revision.operation_fingerprint,
  revision.accepted_at, revision.committed_at, revision.indexed_at, revision.visible_at,
  revision.created_by, revision.created_at, fact.memory_type,
  COALESCE((SELECT array_agg(source.source_event_id ORDER BY source.source_event_type, source.source_event_id)
            FROM agent_memory_revision_sources source
            WHERE source.revision_id = revision.id), ARRAY[]::text[]) AS source_event_ids`;

export class MemoryRevisionRepository {
  private readonly analyticsEnabled: boolean;

  public constructor(
    private readonly pool: Pool,
    options: { analyticsEnabled?: boolean } = {},
  ) {
    this.analyticsEnabled = options.analyticsEnabled === true;
  }

  public async createFact(input: MemoryFactIdentity): Promise<MemoryFactRecord> {
    const identity = normalizeMemoryFactIdentity(input);
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<MemoryFactRow>(
        `INSERT INTO agent_memory_facts (
           organization_id, workspace_id, agent_definition_id, installation_id, agent_version_id,
           conversation_id, end_user_id, namespace, memory_type, subject_key,
           predicate_key, fact_key, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT DO NOTHING
         RETURNING ${factColumns}`,
        [
          identity.organizationId,
          identity.workspaceId,
          identity.agentDefinitionId,
          identity.installationId,
          identity.agentVersionId ?? null,
          identity.conversationId ?? null,
          identity.endUserId ?? null,
          identity.namespace,
          identity.memoryType,
          identity.subjectKey,
          identity.predicateKey,
          identity.factKey,
          "system",
        ],
      );
      const row = inserted.rows[0] ?? (await client.query<MemoryFactRow>(
        `SELECT ${factColumns}
         FROM agent_memory_facts
         WHERE organization_id = $1 AND workspace_id = $2 AND installation_id = $3 AND namespace = $4
           AND memory_type = $5 AND fact_key = $6
           AND conversation_id IS NOT DISTINCT FROM $7
           AND end_user_id IS NOT DISTINCT FROM $8
         FOR UPDATE`,
        [identity.organizationId, identity.workspaceId, identity.installationId, identity.namespace, identity.memoryType, identity.factKey, identity.conversationId ?? null, identity.endUserId ?? null],
      )).rows[0];
      if (!row) throw new Error("MEMORY_FACT_CREATE_FAILED");
      return factFromRow(row);
    });
  }

  public async findFact(input: MemoryFactIdentity): Promise<MemoryFactRecord | null> {
    const identity = normalizeMemoryFactIdentity(input);
    const result = await query<MemoryFactRow>(
      this.pool,
      `SELECT ${factColumns}
       FROM agent_memory_facts
       WHERE organization_id = $1 AND workspace_id = $2 AND installation_id = $3 AND namespace = $4
         AND memory_type = $5 AND fact_key = $6
         AND conversation_id IS NOT DISTINCT FROM $7
         AND end_user_id IS NOT DISTINCT FROM $8`,
      [identity.organizationId, identity.workspaceId, identity.installationId, identity.namespace, identity.memoryType, identity.factKey, identity.conversationId ?? null, identity.endUserId ?? null],
    );
    return result.rows[0] ? factFromRow(result.rows[0]) : null;
  }

  public async appendRevision(
    factId: string,
    input: MemoryRevisionInput,
    expectedPredecessorRevisionId?: string,
    sourceRelations: readonly MemorySourceRelationInput[] = [],
  ): Promise<MemoryRevisionWriteResult> {
    const normalized = normalizeMemoryRevisionInput(input);
    const fingerprint = memoryRevisionFingerprint(factId, normalized);
    return withTransaction(this.pool, async (client) => {
      const factResult = await client.query<MemoryFactRow>(
        `SELECT ${factColumns} FROM agent_memory_facts WHERE id = $1 FOR UPDATE`,
        [factId],
      );
      const fact = factResult.rows[0];
      if (!fact) throw new Error("MEMORY_FACT_NOT_FOUND");
      if (fact.memory_type !== normalized.memoryType) throw new Error("MEMORY_TYPE_SCOPE_MISMATCH");

      const existing = await client.query<MemoryRevisionRow>(
        `SELECT ${revisionColumns}
         FROM agent_memory_revisions revision
         JOIN agent_memory_facts fact ON fact.id = revision.fact_id
         WHERE revision.fact_id = $1 AND revision.idempotency_key = $2
         FOR UPDATE`,
        [factId, normalized.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].operation_fingerprint !== fingerprint) throw new Error("MEMORY_REVISION_IDEMPOTENCY_CONFLICT");
        return { status: "replayed", revision: { ...revisionFromRow(existing.rows[0]), memoryType: fact.memory_type } };
      }

      if (expectedPredecessorRevisionId) {
        const predecessorStates = normalized.transitionType === "revalidation"
          ? ["active", "review_pending", "quarantined"]
          : ["active"];
        const current = await client.query<{ id: string }>(
          `SELECT revision.id
           FROM agent_memory_revisions revision
           WHERE revision.fact_id = $1 AND revision.lifecycle_state = ANY($2::text[])
             AND revision.valid_from <= now()
             AND (revision.valid_to IS NULL OR revision.valid_to > now())
             AND NOT EXISTS (
               SELECT 1 FROM agent_memory_revisions successor
               WHERE successor.predecessor_revision_id = revision.id
                 AND successor.transition_type IN ('correction', 'supersession', 'expiration', 'deletion')
                 AND successor.lifecycle_state IN ('active', 'superseded', 'expired', 'deleted')
                 AND successor.valid_from <= now()
             )
           ORDER BY revision.revision_number DESC
           LIMIT 1
           FOR SHARE`,
          [factId, predecessorStates],
        );
        assertExpectedPredecessor(expectedPredecessorRevisionId, current.rows[0]?.id);
      }

      let predecessor: { id: string; factId: string; lifecycleState: MemoryRevisionRecord["lifecycleState"] } | undefined;
      if (normalized.predecessorRevisionId) {
        const predecessorResult = await client.query<{ id: string; fact_id: string; lifecycle_state: MemoryRevisionRecord["lifecycleState"] }>(
          `SELECT id, fact_id, lifecycle_state FROM agent_memory_revisions WHERE id = $1 FOR SHARE`,
          [normalized.predecessorRevisionId],
        );
        const row = predecessorResult.rows[0];
        predecessor = row ? { id: row.id, factId: row.fact_id, lifecycleState: row.lifecycle_state } : undefined;
      }
      assertMemoryRevisionTransition(normalized, predecessor, factId);

      const revisionNumber = await client.query<{ revision_number: string }>(
        `SELECT (COALESCE(MAX(revision_number), 0) + 1)::text AS revision_number
         FROM agent_memory_revisions WHERE fact_id = $1`,
        [factId],
      );
      const nextRevisionNumber = Number(revisionNumber.rows[0]?.revision_number ?? 1);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO agent_memory_revisions (
           fact_id, organization_id, revision_number, transition_type, lifecycle_state,
           canonical_text, typed_value, event_time, event_summary, participants, outcome,
           valid_from, valid_to, observed_at, confidence, source_trust, sensitivity,
           provenance, evidence_digest, extraction_version, predecessor_revision_id,
           idempotency_key, operation_fingerprint, accepted_at, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11,
           $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20, $21,
           $22, $23, $24, $25
         )
         RETURNING id`,
        [
          factId,
          fact.organization_id,
          nextRevisionNumber,
          normalized.transitionType,
          normalized.lifecycleState,
          normalized.canonicalText,
          JSON.stringify(normalized.typedValue ?? {}),
          normalized.eventTime ?? null,
          normalized.eventSummary ?? null,
          JSON.stringify(normalized.participants ?? []),
          normalized.outcome ?? null,
          normalized.validFrom,
          normalized.validTo ?? null,
          normalized.observedAt ?? null,
          normalized.confidence ?? null,
          normalized.sourceTrust,
          normalized.sensitivity ?? "normal",
          JSON.stringify(normalized.provenance ?? {}),
          normalized.evidenceDigest,
          normalized.extractionVersion,
          normalized.predecessorRevisionId ?? null,
          normalized.idempotencyKey,
          fingerprint,
          normalized.acceptedAt ?? null,
          normalized.createdBy,
        ],
      );
      const insertedRow = inserted.rows[0];
      if (!insertedRow) throw new Error("MEMORY_REVISION_CREATE_FAILED");

      const sourceEventType = normalized.sourceEventType ?? "memory_source";
      for (const sourceEventId of normalized.sourceEventIds) {
        await client.query(
          `INSERT INTO agent_memory_revision_sources (
             revision_id, organization_id, source_event_id, source_event_type,
             source_run_id, source_occurred_at, source_digest, redaction_class, provenance
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
           ON CONFLICT (revision_id, source_event_type, source_event_id) DO NOTHING`,
          [
            insertedRow.id,
            fact.organization_id,
            sourceEventId,
            sourceEventType,
            normalized.sourceRunId ?? null,
            normalized.sourceOccurredAt ?? null,
            normalized.evidenceDigest,
            normalized.redactionClass ?? "standard",
            JSON.stringify({}),
          ],
        );
      }
      const refreshed = await client.query<MemoryRevisionRow>(
        `SELECT ${revisionColumns}
         FROM agent_memory_revisions revision
         JOIN agent_memory_facts fact ON fact.id = revision.fact_id
         WHERE revision.id = $1`,
        [insertedRow.id],
      );
      const row = refreshed.rows[0];
      if (!row) throw new Error("MEMORY_REVISION_CREATE_FAILED");
      const revision = { ...revisionFromRow(row), memoryType: fact.memory_type };
      for (const relation of sourceRelations) {
        const sourceEventId = relation.sourceEventId.trim();
        if (!sourceEventId) throw new Error("MEMORY_RELATION_SOURCE_EVENT_REQUIRED");
        const target = await client.query<{ id: string }>(
          `SELECT revision.id
           FROM agent_memory_revision_sources source
           JOIN agent_memory_revisions revision ON revision.id = source.revision_id
           JOIN agent_memory_facts target_fact ON target_fact.id = revision.fact_id
           WHERE source.organization_id = $1
             AND source.source_event_id = $2
             AND revision.id <> $3
             AND target_fact.workspace_id = $4
             AND target_fact.agent_definition_id = $5
             AND target_fact.installation_id = $6
             AND target_fact.agent_version_id IS NOT DISTINCT FROM $7
             AND target_fact.end_user_id IS NOT DISTINCT FROM $8
           ORDER BY revision.created_at DESC, revision.id DESC
           LIMIT 1
           FOR SHARE`,
          [fact.organization_id, sourceEventId, revision.id, fact.workspace_id, fact.agent_definition_id, fact.installation_id, fact.agent_version_id ?? null, fact.end_user_id ?? null],
        );
        const targetRevisionId = target.rows[0]?.id;
        if (!targetRevisionId) throw new Error("MEMORY_RELATION_TARGET_NOT_FOUND");
        await client.query(
          `INSERT INTO agent_memory_relations (
             organization_id, from_revision_id, to_revision_id, relation_type, metadata, created_by
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           ON CONFLICT (from_revision_id, to_revision_id, relation_type)
           DO NOTHING`,
          [fact.organization_id, revision.id, targetRevisionId, relation.relationType, JSON.stringify(relation.metadata ?? {}), normalized.createdBy],
        );
      }
      const projectionOperation = normalized.lifecycleState === "deleted" ? "delete" : "upsert";
      const emptyPayloadDigest = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
      const projectionRows = [
        { kind: "fts", providerName: "internal", version: "v1", payload: {}, payloadDigest: emptyPayloadDigest },
        { kind: "vector", providerName: "internal", version: "v1", payload: {}, payloadDigest: emptyPayloadDigest },
        { kind: "temporal", providerName: "internal", version: "v1", payload: {}, payloadDigest: emptyPayloadDigest },
        ...(normalized.providerProjection ? [{
          kind: "provider",
          providerName: normalized.providerProjection.providerName,
          version: normalized.providerProjection.projectionVersion ?? "v1",
          payload: normalized.providerProjection.payload ?? {},
          payloadDigest: createHash("sha256").update(JSON.stringify(normalized.providerProjection.payload ?? {})).digest("hex"),
        }] : []),
      ];
      for (const projection of projectionRows) {
        const idempotencyKey = `memory-revision:${revision.id}:${projection.kind}:${projection.providerName}:${projection.version}:${projectionOperation}`;
        const outbox = await client.query<{ id: string }>(
          `INSERT INTO agent_memory_projection_outbox (
             organization_id, workspace_id, agent_definition_id, agent_version_id,
             installation_id, fact_id, revision_id, projection_kind, operation,
             projection_version, provider_name, idempotency_key, payload, payload_digest
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [fact.organization_id, fact.workspace_id, fact.agent_definition_id, fact.agent_version_id ?? null, fact.installation_id, fact.id, revision.id, projection.kind, projectionOperation, projection.version, projection.providerName, idempotencyKey, JSON.stringify(projection.payload), projection.payloadDigest],
        );
        const outboxId = outbox.rows[0]?.id ?? (await client.query<{ id: string }>(
          `SELECT id FROM agent_memory_projection_outbox
           WHERE revision_id = $1 AND projection_kind = $2 AND operation = $3
             AND projection_version = $4 AND provider_name = $5
           FOR SHARE`,
          [revision.id, projection.kind, projectionOperation, projection.version, projection.providerName],
        )).rows[0]?.id;
        if (!outboxId) throw new Error("MEMORY_PROJECTION_OUTBOX_CREATE_FAILED");
        await client.query(
          `INSERT INTO agent_memory_projection_readiness (
             organization_id, workspace_id, agent_definition_id, agent_version_id,
             installation_id, fact_id, revision_id, projection_kind, provider_name,
             readiness_state, source_outbox_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted',$10)
           ON CONFLICT (revision_id, projection_kind, provider_name) DO NOTHING`,
          [fact.organization_id, fact.workspace_id, fact.agent_definition_id, fact.agent_version_id ?? null, fact.installation_id, fact.id, revision.id, projection.kind, projection.providerName, outboxId],
        );
      }
      if (this.analyticsEnabled) {
        const conflict = revision.provenance && typeof revision.provenance === "object"
          && typeof revision.provenance.conflictType === "string";
        const action = conflict
          ? "conflict" as const
          : revision.transitionType === "assertion"
            ? revision.lifecycleState === "active" ? "capture" as const : "candidate" as const
            : "review" as const;
        const sourceType = revision.sourceTrust === "user_explicit"
          ? "explicit" as const
          : revision.sourceTrust === "imported"
            ? "imported" as const
            : "inferred" as const;
        await enqueueMemoryLifecycleEvent(client, {
          organizationId: fact.organization_id,
          workspaceId: fact.workspace_id,
          agentDefinitionId: fact.agent_definition_id,
          agentVersionId: fact.agent_version_id,
          installationId: fact.installation_id,
          memoryId: fact.id,
          revisionId: revision.id,
          runId: normalized.sourceRunId,
          memoryKind: revision.memoryType,
          namespace: fact.namespace,
          action,
          status: revision.lifecycleState,
          ...(predecessor ? { transitionFrom: predecessor.lifecycleState } : {}),
          transitionTo: revision.lifecycleState,
          sensitivity: revision.sensitivity,
          sourceEventCount: revision.sourceEventIds.length,
          reasonCode: revision.transitionType,
          occurredAt: revision.createdAt,
          causationId: revision.evidenceDigest,
        });
      }
      return { status: "created", revision };
    });
  }

  public async getRevision(organizationId: string, revisionId: string): Promise<MemoryRevisionRecord | null> {
    const result = await query<MemoryRevisionRow>(
      this.pool,
      `SELECT ${revisionColumns}
       FROM agent_memory_revisions revision
       JOIN agent_memory_facts fact ON fact.id = revision.fact_id
       WHERE revision.organization_id = $1 AND revision.id = $2`,
      [organizationId, revisionId],
    );
    const row = result.rows[0];
    return row ? { ...revisionFromRow(row), memoryType: row.memory_type } : null;
  }

  public async listRevisions(organizationId: string, factId: string): Promise<MemoryRevisionRecord[]> {
    const result = await query<MemoryRevisionRow>(
      this.pool,
      `SELECT ${revisionColumns}
       FROM agent_memory_revisions revision
       JOIN agent_memory_facts fact ON fact.id = revision.fact_id
       WHERE revision.organization_id = $1 AND revision.fact_id = $2
       ORDER BY revision.revision_number ASC`,
      [organizationId, factId],
    );
    return result.rows.map((row) => ({ ...revisionFromRow(row), memoryType: row.memory_type }));
  }

  public async resolveCurrent(organizationId: string, factId: string, asOf?: string): Promise<MemoryRevisionRecord | null> {
    const result = await query<MemoryRevisionRow>(
      this.pool,
      `SELECT ${revisionColumns}
       FROM agent_memory_revisions revision
       JOIN agent_memory_facts fact ON fact.id = revision.fact_id
       WHERE revision.organization_id = $1 AND revision.fact_id = $2
         AND revision.lifecycle_state = 'active'
         AND revision.valid_from <= COALESCE($3::timestamptz, now())
         AND (revision.valid_to IS NULL OR revision.valid_to > COALESCE($3::timestamptz, now()))
         AND NOT EXISTS (
           SELECT 1 FROM agent_memory_revisions successor
           WHERE successor.predecessor_revision_id = revision.id
             AND successor.transition_type IN ('correction', 'supersession', 'expiration', 'deletion')
             AND successor.lifecycle_state IN ('active', 'superseded', 'expired', 'deleted')
             AND successor.valid_from <= COALESCE($3::timestamptz, now())
         )
       ORDER BY revision.revision_number DESC
       LIMIT 1`,
      [organizationId, factId, asOf ?? null],
    );
    const row = result.rows[0];
    return row ? { ...revisionFromRow(row), memoryType: row.memory_type } : null;
  }

  public async createRelation(input: MemoryRelationInput): Promise<MemoryRelationRecord> {
    if (!input.organizationId.trim() || !input.fromRevisionId.trim() || !input.toRevisionId.trim()) {
      throw new Error("MEMORY_RELATION_SCOPE_REQUIRED");
    }
    if (input.fromRevisionId === input.toRevisionId) throw new Error("MEMORY_RELATION_SELF_REFERENCE");
    const metadata = JSON.stringify(input.metadata ?? {});
    return withTransaction(this.pool, async (client) => {
      const revisions = await client.query<{
        id: string;
        organization_id: string;
        workspace_id: string;
        agent_definition_id: string;
        installation_id: string;
        agent_version_id: string | null;
        end_user_id: string | null;
      }>(
        `SELECT revision.id, fact.organization_id, fact.workspace_id, fact.agent_definition_id,
                fact.installation_id, fact.agent_version_id, fact.end_user_id
         FROM agent_memory_revisions revision
         JOIN agent_memory_facts fact ON fact.id = revision.fact_id
         WHERE revision.id = ANY($1::uuid[])
         FOR SHARE`,
        [[input.fromRevisionId, input.toRevisionId]],
      );
      const [from, to] = revisions.rows;
      if (revisions.rows.length !== 2
        || revisions.rows.some((row) => row.organization_id !== input.organizationId)
        || !from || !to
        || from.workspace_id !== to.workspace_id
        || from.agent_definition_id !== to.agent_definition_id
        || from.installation_id !== to.installation_id
        || from.agent_version_id !== to.agent_version_id
        || from.end_user_id !== to.end_user_id) {
        throw new Error("MEMORY_RELATION_SCOPE_MISMATCH");
      }
      const inserted = await client.query<{
        id: string;
        from_revision_id: string;
        to_revision_id: string;
        relation_type: MemoryRelationRecord["relationType"];
        metadata: Record<string, unknown>;
        created_by: string;
        created_at: string | Date;
      }>(
        `INSERT INTO agent_memory_relations (
           organization_id, from_revision_id, to_revision_id, relation_type, metadata, created_by
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (from_revision_id, to_revision_id, relation_type)
         DO NOTHING
         RETURNING id, from_revision_id, to_revision_id, relation_type, metadata, created_by, created_at`,
        [input.organizationId, input.fromRevisionId, input.toRevisionId, input.relationType, metadata, input.createdBy],
      );
      const row = inserted.rows[0] ?? (await client.query<{
        id: string;
        from_revision_id: string;
        to_revision_id: string;
        relation_type: MemoryRelationRecord["relationType"];
        metadata: Record<string, unknown>;
        created_by: string;
        created_at: string | Date;
      }>(
        `SELECT id, from_revision_id, to_revision_id, relation_type, metadata, created_by, created_at
         FROM agent_memory_relations
         WHERE organization_id = $1 AND from_revision_id = $2 AND to_revision_id = $3 AND relation_type = $4
         FOR SHARE`,
        [input.organizationId, input.fromRevisionId, input.toRevisionId, input.relationType],
      )).rows[0];
      if (!row) throw new Error("MEMORY_RELATION_CREATE_FAILED");
      return {
        id: row.id,
        organizationId: input.organizationId,
        fromRevisionId: row.from_revision_id,
        toRevisionId: row.to_revision_id,
        relationType: row.relation_type,
        metadata: row.metadata ?? {},
        createdBy: row.created_by,
        createdAt: asIso(row.created_at)!,
      };
    });
  }

  public async listRelations(organizationId: string, revisionId: string): Promise<MemoryRelationRecord[]> {
    const result = await query<{
      id: string;
      from_revision_id: string;
      to_revision_id: string;
      relation_type: MemoryRelationRecord["relationType"];
      metadata: Record<string, unknown>;
      created_by: string;
      created_at: string | Date;
    }>(
      this.pool,
      `SELECT id, from_revision_id, to_revision_id, relation_type, metadata, created_by, created_at
       FROM agent_memory_relations
       WHERE organization_id = $1 AND (from_revision_id = $2 OR to_revision_id = $2)
       ORDER BY created_at ASC, id ASC`,
      [organizationId, revisionId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organizationId,
      fromRevisionId: row.from_revision_id,
      toRevisionId: row.to_revision_id,
      relationType: row.relation_type,
      metadata: row.metadata ?? {},
      createdBy: row.created_by,
      createdAt: asIso(row.created_at)!,
    }));
  }

  /** Pure resolver used by migrations, fixtures, and repository contract tests. */
  public resolveCurrentFromHistory(revisions: readonly MemoryRevisionRecord[], asOf?: Date): MemoryRevisionRecord | null {
    return resolveCurrentMemoryRevision(revisions, asOf);
  }

}

/** The pool client type is exported for contract tests that verify transaction boundaries. */
export type MemoryRevisionDatabaseClient = PoolClient;
