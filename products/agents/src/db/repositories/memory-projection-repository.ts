import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { query, withTransaction } from "../pool";

export type MemoryProjectionKind = "fts" | "vector" | "temporal" | "provider";
export type MemoryProjectionOperation = "upsert" | "delete" | "revalidate";
export type MemoryProjectionOutboxStatus = "queued" | "running" | "completed" | "dead_letter";
export type MemoryProjectionReadinessState = "accepted" | "indexing" | "indexed" | "visible" | "failed" | "blocked" | "deleted";
export type MemoryProviderProjectionState = "accepted" | "indexed" | "visible" | "failed" | "deleted";

export interface MemoryProjectionTaskScope {
  organizationId: string;
  workspaceId: string;
  agentDefinitionId: string;
  agentVersionId?: string;
  installationId: string;
  factId: string;
  revisionId: string;
}

export interface MemoryProjectionTaskInput extends MemoryProjectionTaskScope {
  projectionKind: MemoryProjectionKind;
  operation: MemoryProjectionOperation;
  projectionVersion?: string;
  providerName?: string;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}

export interface MemoryProjectionTaskRecord extends MemoryProjectionTaskScope {
  id: string;
  projectionKind: MemoryProjectionKind;
  operation: MemoryProjectionOperation;
  projectionVersion: string;
  providerName: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  payloadDigest: string;
  status: MemoryProjectionOutboxStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  acceptedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryProjectionSourceRecord extends MemoryProjectionTaskScope {
  memoryType: "semantic" | "episodic";
  lifecycleState: string;
  sensitivity: "normal" | "sensitive" | "restricted";
  canonicalText: string;
  validFrom: string;
  validTo: string | null;
  eventTime: string | null;
  eventSummary: string | null;
  sourceEventIds: string[];
  contentDigest: string;
}

export interface MemoryProjectionReadinessRecord {
  id: string;
  revisionId: string;
  projectionKind: MemoryProjectionKind;
  providerName: string;
  readinessState: MemoryProjectionReadinessState;
  acceptedAt: string;
  indexedAt: string | null;
  visibleAt: string | null;
  deletedAt: string | null;
  attemptCount: number;
  lastErrorCode: string | null;
  sourceOutboxId: string | null;
  updatedAt: string;
}

export interface MemoryProviderReceiptInput extends MemoryProjectionTaskScope {
  providerName: string;
  providerRecordId?: string;
  operation: MemoryProjectionOperation;
  providerState: MemoryProviderProjectionState;
  providerOperationId?: string;
  contentDigest: string;
  metadata?: Record<string, unknown>;
  acceptedAt?: string;
  indexedAt?: string;
  visibleAt?: string;
  deletedAt?: string;
  lastErrorCode?: string;
}

export interface MemoryProjectionApplyResult {
  readiness: Extract<MemoryProjectionReadinessState, "accepted" | "indexed" | "visible" | "deleted">;
  providerRecordId?: string;
  providerOperationId?: string;
  providerState?: MemoryProviderProjectionState;
  metadata?: Record<string, unknown>;
}

export interface MemoryProjectionEnqueueResult {
  status: "inserted" | "duplicate";
  task: MemoryProjectionTaskRecord;
}

interface TaskRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  agent_definition_id: string;
  agent_version_id: string | null;
  installation_id: string;
  fact_id: string;
  revision_id: string;
  projection_kind: MemoryProjectionKind;
  operation: MemoryProjectionOperation;
  projection_version: string;
  provider_name: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  payload_digest: string;
  status: MemoryProjectionOutboxStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: Date | string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  last_error_code: string | null;
  accepted_at: Date | string;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SourceRow {
  revision_id: string;
  fact_id: string;
  organization_id: string;
  workspace_id: string;
  agent_definition_id: string;
  agent_version_id: string | null;
  installation_id: string;
  memory_type: "semantic" | "episodic";
  lifecycle_state: string;
  sensitivity: "normal" | "sensitive" | "restricted";
  canonical_text: string;
  valid_from: Date | string;
  valid_to: Date | string | null;
  event_time: Date | string | null;
  event_summary: string | null;
  source_event_ids: string[];
  evidence_digest: string;
}

interface ReadinessRow {
  id: string;
  revision_id: string;
  projection_kind: MemoryProjectionKind;
  provider_name: string;
  readiness_state: MemoryProjectionReadinessState;
  accepted_at: Date | string;
  indexed_at: Date | string | null;
  visible_at: Date | string | null;
  deleted_at: Date | string | null;
  attempt_count: number;
  last_error_code: string | null;
  source_outbox_id: string | null;
  updated_at: Date | string;
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function required(value: string, field: string, max = 512): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(field.toUpperCase() + "_REQUIRED");
  if (normalized.length > max) throw new Error(field.toUpperCase() + "_TOO_LONG");
  return normalized;
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("MEMORY_PROJECTION_LIMIT_INVALID");
  return Math.min(value, 100);
}

function boundedLease(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("MEMORY_PROJECTION_LEASE_INVALID");
  return Math.max(30_000, Math.min(value, 900_000));
}

function boundedRetry(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("MEMORY_PROJECTION_RETRY_INVALID");
  return Math.max(1_000, Math.min(value, 3_600_000));
}

function normalizedErrorCode(value: string, fallback: string): string {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 120);
  if (!normalized) return fallback;
  return /^[A-Z]/.test(normalized) ? normalized : `ERR_${normalized}`.slice(0, 120);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  return "{" + Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => JSON.stringify(key) + ":" + stableJson(entry))
    .join(",") + "}";
}

function digestPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function normalizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  try {
    const encoded = JSON.stringify(payload);
    if (encoded === undefined) throw new Error("not serializable");
    const normalized = JSON.parse(encoded) as unknown;
    if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) throw new Error("not an object");
    return normalized as Record<string, unknown>;
  } catch {
    throw new Error("MEMORY_PROJECTION_PAYLOAD_INVALID");
  }
}

function taskFromRow(row: TaskRow): MemoryProjectionTaskRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    agentDefinitionId: row.agent_definition_id,
    ...(row.agent_version_id ? { agentVersionId: row.agent_version_id } : {}),
    installationId: row.installation_id,
    factId: row.fact_id,
    revisionId: row.revision_id,
    projectionKind: row.projection_kind,
    operation: row.operation,
    projectionVersion: row.projection_version,
    providerName: row.provider_name,
    idempotencyKey: row.idempotency_key,
    payload: row.payload ?? {},
    payloadDigest: row.payload_digest,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: iso(row.lease_expires_at),
    lastErrorCode: row.last_error_code,
    acceptedAt: new Date(row.accepted_at).toISOString(),
    completedAt: iso(row.completed_at),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function readinessFromRow(row: ReadinessRow): MemoryProjectionReadinessRecord {
  return {
    id: row.id,
    revisionId: row.revision_id,
    projectionKind: row.projection_kind,
    providerName: row.provider_name,
    readinessState: row.readiness_state,
    acceptedAt: new Date(row.accepted_at).toISOString(),
    indexedAt: iso(row.indexed_at),
    visibleAt: iso(row.visible_at),
    deletedAt: iso(row.deleted_at),
    attemptCount: Number(row.attempt_count),
    lastErrorCode: row.last_error_code,
    sourceOutboxId: row.source_outbox_id,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const taskColumns = [
  "id", "organization_id", "workspace_id", "agent_definition_id", "agent_version_id",
  "installation_id", "fact_id", "revision_id", "projection_kind", "operation",
  "projection_version", "provider_name", "idempotency_key", "payload", "payload_digest",
  "status", "attempt_count", "max_attempts", "next_attempt_at", "lease_owner",
  "lease_expires_at", "last_error_code", "accepted_at", "completed_at", "created_at", "updated_at",
].join(", ");
const qualifiedTaskColumns = taskColumns.split(", ").map((column) => `task.${column}`).join(", ");

export class MemoryProjectionRepository {
  public constructor(private readonly pool: Pool) {}

  /** Enqueue a bounded rebuild slice from canonical revisions. This is the
   * migration/cutover seam; it never reads an existing projection as truth. */
  public async enqueueRebuild(input: {
    organizationId: string;
    workspaceId?: string;
    limit?: number;
  }): Promise<number> {
    const organizationId = required(input.organizationId, "organization_id", 240);
    const workspaceId = input.workspaceId?.trim() || null;
    const limit = boundedLimit(input.limit ?? 100);
    const result = await query(
      this.pool,
      `WITH candidates AS (
         SELECT revision.id AS revision_id,
                fact.id AS fact_id,
                fact.organization_id,
                fact.workspace_id,
                fact.agent_definition_id,
                fact.agent_version_id,
                fact.installation_id,
                CASE WHEN revision.lifecycle_state = 'deleted' THEN 'delete' ELSE 'upsert' END AS operation
         FROM agent_memory_revisions revision
         JOIN agent_memory_facts fact ON fact.id = revision.fact_id
         WHERE fact.organization_id = $1
           AND ($2::text IS NULL OR fact.workspace_id = $2)
         ORDER BY revision.created_at ASC, revision.id ASC
         LIMIT $3
       ), work AS (
         SELECT candidates.*, kind.value AS projection_kind
         FROM candidates
         CROSS JOIN unnest(ARRAY['fts', 'vector', 'temporal']::text[]) AS kind(value)
       ), inserted AS (
         INSERT INTO agent_memory_projection_outbox (
           organization_id, workspace_id, agent_definition_id, agent_version_id,
           installation_id, fact_id, revision_id, projection_kind, operation,
           projection_version, provider_name, idempotency_key, payload, payload_digest
         )
         SELECT organization_id, workspace_id, agent_definition_id, agent_version_id,
                installation_id, fact_id, revision_id, projection_kind, operation,
                'v1', 'internal',
                'memory-rebuild:' || revision_id::text || ':' || projection_kind || ':' || operation || ':v1',
                '{}'::jsonb,
                '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
         FROM work
         ON CONFLICT DO NOTHING
         RETURNING id, organization_id, workspace_id, agent_definition_id, agent_version_id,
                   installation_id, fact_id, revision_id, projection_kind, provider_name
       )
       INSERT INTO agent_memory_projection_readiness (
         organization_id, workspace_id, agent_definition_id, agent_version_id,
         installation_id, fact_id, revision_id, projection_kind, provider_name,
         readiness_state, source_outbox_id
       )
       SELECT organization_id, workspace_id, agent_definition_id, agent_version_id,
              installation_id, fact_id, revision_id, projection_kind, provider_name,
              'accepted', id
       FROM inserted
       ON CONFLICT (revision_id, projection_kind, provider_name) DO NOTHING`,
      [organizationId, workspaceId, limit],
    );
    return result.rowCount ?? 0;
  }

  public async enqueue(input: MemoryProjectionTaskInput): Promise<MemoryProjectionEnqueueResult> {
    const organizationId = required(input.organizationId, "organization_id", 240);
    const workspaceId = required(input.workspaceId, "workspace_id", 240);
    const agentDefinitionId = required(input.agentDefinitionId, "agent_definition_id");
    const installationId = required(input.installationId, "installation_id");
    const factId = required(input.factId, "fact_id");
    const revisionId = required(input.revisionId, "revision_id");
    const projectionVersion = required(input.projectionVersion ?? "v1", "projection_version", 80);
    const providerName = required(input.providerName ?? "internal", "provider_name", 160);
    const idempotencyKey = required(input.idempotencyKey, "idempotency_key");
    const payload = normalizePayload(input.payload ?? {});
    const payloadDigest = digestPayload(payload);
    const maxAttempts = Math.max(1, Math.min(Math.trunc(input.maxAttempts ?? 8), 20));
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<TaskRow>(
        "INSERT INTO agent_memory_projection_outbox (" +
        "organization_id, workspace_id, agent_definition_id, agent_version_id, installation_id, fact_id, revision_id, " +
        "projection_kind, operation, projection_version, provider_name, idempotency_key, payload, payload_digest, max_attempts" +
        ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15) " +
        "ON CONFLICT (idempotency_key) DO NOTHING RETURNING " + taskColumns,
        [organizationId, workspaceId, agentDefinitionId, input.agentVersionId ?? null, installationId, factId, revisionId, input.projectionKind, input.operation, projectionVersion, providerName, idempotencyKey, JSON.stringify(payload), payloadDigest, maxAttempts],
      );
      if (inserted.rows[0]) {
        const task = taskFromRow(inserted.rows[0]);
        await this.ensureReadiness(client, task);
        return { status: "inserted", task };
      }
      const existing = await client.query<TaskRow>(
        "SELECT " + taskColumns + " FROM agent_memory_projection_outbox WHERE idempotency_key = $1 FOR UPDATE",
        [idempotencyKey],
      );
      const row = existing.rows[0];
      if (!row) throw new Error("MEMORY_PROJECTION_OUTBOX_DUPLICATE_MISSING");
      if (row.payload_digest !== payloadDigest || row.revision_id !== revisionId
        || row.projection_kind !== input.projectionKind || row.operation !== input.operation || row.provider_name !== providerName) {
        throw new Error("MEMORY_PROJECTION_IDEMPOTENCY_CONFLICT");
      }
      return { status: "duplicate", task: taskFromRow(row) };
    });
  }

  public async claimDue(workerId: string, limit: number, leaseMs: number, organizationId?: string, now = new Date()): Promise<MemoryProjectionTaskRecord[]> {
    const owner = required(workerId, "worker_id", 240);
    const boundedCount = boundedLimit(limit);
    const boundedLeaseMs = boundedLease(leaseMs);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<TaskRow>(
        "WITH due AS (" +
        " SELECT task.id FROM agent_memory_projection_outbox task WHERE " +
        " ((task.status='queued' AND task.next_attempt_at <= $1) OR " +
        "  (task.status='running' AND task.lease_expires_at IS NOT NULL AND task.lease_expires_at <= $1)) " +
        " AND ($4::text IS NULL OR task.organization_id=$4) ORDER BY task.created_at LIMIT $2 " +
        " FOR UPDATE OF task SKIP LOCKED" +
        ") UPDATE agent_memory_projection_outbox task SET status='running', attempt_count=task.attempt_count+1, " +
        "lease_owner=$3, lease_expires_at=$5, updated_at=$1 FROM due WHERE task.id=due.id RETURNING " + qualifiedTaskColumns,
        [now, boundedCount, owner, organizationId?.trim() || null, new Date(now.getTime() + boundedLeaseMs)],
      );
      for (const row of result.rows) {
        await client.query(
          "UPDATE agent_memory_projection_readiness SET readiness_state = CASE " +
          "WHEN readiness_state IN ('accepted','failed') THEN 'indexing' ELSE readiness_state END, " +
          "attempt_count=$3, last_error_code=NULL, last_error_at=NULL, source_outbox_id=$2 " +
          "WHERE revision_id=$1 AND projection_kind=$4 AND provider_name=$5",
          [row.revision_id, row.id, row.attempt_count, row.projection_kind, row.provider_name],
        );
      }
      return result.rows.map(taskFromRow);
    });
  }

  public async getSource(input: Pick<MemoryProjectionTaskScope, "organizationId" | "workspaceId" | "revisionId">): Promise<MemoryProjectionSourceRecord | null> {
    const result = await query<SourceRow>(
      this.pool,
      "SELECT revision.id AS revision_id, fact.id AS fact_id, fact.organization_id, fact.workspace_id, " +
      "fact.agent_definition_id, fact.agent_version_id, fact.installation_id, fact.memory_type, " +
      "revision.lifecycle_state, revision.sensitivity, revision.canonical_text, revision.valid_from, revision.valid_to, " +
      "revision.event_time, revision.event_summary, revision.evidence_digest, " +
      "COALESCE((SELECT array_agg(source.source_event_id ORDER BY source.source_event_type, source.source_event_id) " +
      "FROM agent_memory_revision_sources source WHERE source.revision_id=revision.id), ARRAY[]::text[]) AS source_event_ids " +
      "FROM agent_memory_revisions revision JOIN agent_memory_facts fact ON fact.id=revision.fact_id " +
      "WHERE revision.id=$1 AND fact.organization_id=$2 AND fact.workspace_id=$3",
      [input.revisionId, input.organizationId, input.workspaceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      revisionId: row.revision_id,
      factId: row.fact_id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      agentDefinitionId: row.agent_definition_id,
      ...(row.agent_version_id ? { agentVersionId: row.agent_version_id } : {}),
      installationId: row.installation_id,
      memoryType: row.memory_type,
      lifecycleState: row.lifecycle_state,
      sensitivity: row.sensitivity,
      canonicalText: row.canonical_text,
      validFrom: new Date(row.valid_from).toISOString(),
      validTo: iso(row.valid_to),
      eventTime: iso(row.event_time),
      eventSummary: row.event_summary,
      sourceEventIds: row.source_event_ids ?? [],
      contentDigest: row.evidence_digest,
    };
  }

  public async applyFts(source: MemoryProjectionSourceRecord, operation: MemoryProjectionOperation): Promise<void> {
    if (operation === "delete") {
      await query(this.pool, "DELETE FROM agent_memory_fts_projections WHERE revision_id=$1 AND organization_id=$2", [source.revisionId, source.organizationId]);
      return;
    }
    await query(
      this.pool,
      "INSERT INTO agent_memory_fts_projections (" +
      "revision_id,fact_id,organization_id,workspace_id,agent_definition_id,agent_version_id,installation_id," +
      "lifecycle_state,sensitivity,canonical_text,search_vector,content_digest" +
      ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_tsvector('simple'::regconfig,$10::text),$11) " +
      "ON CONFLICT (revision_id) DO UPDATE SET fact_id=EXCLUDED.fact_id, organization_id=EXCLUDED.organization_id, " +
      "workspace_id=EXCLUDED.workspace_id, agent_definition_id=EXCLUDED.agent_definition_id, " +
      "agent_version_id=EXCLUDED.agent_version_id, installation_id=EXCLUDED.installation_id, " +
      "lifecycle_state=EXCLUDED.lifecycle_state, sensitivity=EXCLUDED.sensitivity, canonical_text=EXCLUDED.canonical_text, " +
      "search_vector=EXCLUDED.search_vector, content_digest=EXCLUDED.content_digest, updated_at=now()",
      [source.revisionId, source.factId, source.organizationId, source.workspaceId, source.agentDefinitionId, source.agentVersionId ?? null, source.installationId, source.lifecycleState, source.sensitivity, source.canonicalText, source.contentDigest],
    );
  }

  public async applyTemporal(source: MemoryProjectionSourceRecord, operation: MemoryProjectionOperation): Promise<void> {
    if (operation === "delete") {
      await query(this.pool, "DELETE FROM agent_memory_temporal_projections WHERE revision_id=$1 AND organization_id=$2", [source.revisionId, source.organizationId]);
      return;
    }
    await query(
      this.pool,
      "INSERT INTO agent_memory_temporal_projections (" +
      "revision_id,fact_id,organization_id,workspace_id,agent_definition_id,agent_version_id,installation_id," +
      "memory_type,lifecycle_state,valid_from,valid_to,event_time,event_summary,source_event_ids" +
      ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) " +
      "ON CONFLICT (revision_id) DO UPDATE SET fact_id=EXCLUDED.fact_id, organization_id=EXCLUDED.organization_id, " +
      "workspace_id=EXCLUDED.workspace_id, agent_definition_id=EXCLUDED.agent_definition_id, " +
      "agent_version_id=EXCLUDED.agent_version_id, installation_id=EXCLUDED.installation_id, memory_type=EXCLUDED.memory_type, " +
      "lifecycle_state=EXCLUDED.lifecycle_state, valid_from=EXCLUDED.valid_from, valid_to=EXCLUDED.valid_to, " +
      "event_time=EXCLUDED.event_time, event_summary=EXCLUDED.event_summary, source_event_ids=EXCLUDED.source_event_ids, updated_at=now()",
      [source.revisionId, source.factId, source.organizationId, source.workspaceId, source.agentDefinitionId, source.agentVersionId ?? null, source.installationId, source.memoryType, source.lifecycleState, source.validFrom, source.validTo, source.eventTime, source.eventSummary, source.sourceEventIds],
    );
  }

  public async applyVector(source: MemoryProjectionSourceRecord, operation: MemoryProjectionOperation, vector: readonly number[] | undefined, model: string | undefined): Promise<void> {
    if (operation === "delete") {
      await query(this.pool, "DELETE FROM agent_memory_vector_projections WHERE revision_id=$1 AND organization_id=$2", [source.revisionId, source.organizationId]);
      return;
    }
    if (!vector || vector.length !== 1_536 || !vector.every((value) => Number.isFinite(value))) {
      throw Object.assign(new Error("Memory vector projection requires a finite 1536-dimensional vector"), { code: "MEMORY_VECTOR_DIMENSION_INVALID", retryable: false });
    }
    const embeddingModel = required(model ?? "", "embedding_model", 160);
    const formatted = "[" + vector.join(",") + "]";
    await query(
      this.pool,
      "INSERT INTO agent_memory_vector_projections (" +
      "revision_id,fact_id,organization_id,workspace_id,agent_definition_id,agent_version_id,installation_id," +
      "embedding_model,embedding_dimensions,embedding_vector,content_digest" +
      ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1536,$9::vector,$10) " +
      "ON CONFLICT (revision_id) DO UPDATE SET fact_id=EXCLUDED.fact_id, organization_id=EXCLUDED.organization_id, " +
      "workspace_id=EXCLUDED.workspace_id, agent_definition_id=EXCLUDED.agent_definition_id, agent_version_id=EXCLUDED.agent_version_id, " +
      "installation_id=EXCLUDED.installation_id, embedding_model=EXCLUDED.embedding_model, " +
      "embedding_dimensions=EXCLUDED.embedding_dimensions, embedding_vector=EXCLUDED.embedding_vector, " +
      "content_digest=EXCLUDED.content_digest, updated_at=now()",
      [source.revisionId, source.factId, source.organizationId, source.workspaceId, source.agentDefinitionId, source.agentVersionId ?? null, source.installationId, embeddingModel, formatted, source.contentDigest],
    );
  }

  public async markCompleted(input: { task: MemoryProjectionTaskRecord; workerId: string; result: MemoryProjectionApplyResult }): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const state = input.result.readiness;
      const readiness = await client.query(
        "UPDATE agent_memory_projection_readiness SET readiness_state=$2::text, " +
        "indexed_at=CASE WHEN $2::text IN ('indexed','visible') THEN COALESCE(indexed_at,now()) ELSE indexed_at END, " +
        "visible_at=CASE WHEN $2::text='visible' THEN COALESCE(visible_at,now()) ELSE visible_at END, " +
        "deleted_at=CASE WHEN $2::text='deleted' THEN COALESCE(deleted_at,now()) ELSE deleted_at END, " +
        "last_error_code=NULL, last_error_at=NULL, source_outbox_id=$3 " +
        "WHERE revision_id=$1 AND projection_kind=$4 AND provider_name=$5",
        [input.task.revisionId, state, input.task.id, input.task.projectionKind, input.task.providerName],
      );
      if ((readiness.rowCount ?? 0) !== 1) throw new Error("MEMORY_PROJECTION_READINESS_MISSING");
      await client.query(
        "UPDATE agent_memory_revisions SET indexed_at=CASE WHEN $2::text IN ('indexed','visible') THEN COALESCE(indexed_at,now()) ELSE indexed_at END, " +
        "visible_at=CASE WHEN $2::text='visible' THEN COALESCE(visible_at,now()) ELSE visible_at END WHERE id=$1",
        [input.task.revisionId, state],
      );
      if (input.task.projectionKind === "provider" && input.result.providerState) {
        const source = await this.getSource(input.task);
        if (!source) throw new Error("MEMORY_PROJECTION_SOURCE_NOT_FOUND");
        await this.upsertProviderReceiptWithClient(client, {
          ...source,
          providerName: input.task.providerName,
          providerRecordId: input.result.providerRecordId,
          operation: input.task.operation,
          providerState: input.result.providerState,
          providerOperationId: input.result.providerOperationId,
          contentDigest: source.contentDigest,
          metadata: input.result.metadata,
        });
      }
      const updated = await client.query(
        "UPDATE agent_memory_projection_outbox SET status='completed', lease_owner=NULL, lease_expires_at=NULL, " +
        "completed_at=now(), updated_at=now(), last_error_code=NULL " +
        "WHERE id=$1 AND status='running' AND lease_owner=$2",
        [input.task.id, input.workerId],
      );
      return (updated.rowCount ?? 0) === 1;
    });
  }

  public async markRetryable(input: { task: MemoryProjectionTaskRecord; workerId: string; errorCode: string; retryAfterMs: number }): Promise<MemoryProjectionOutboxStatus | null> {
    const errorCode = normalizedErrorCode(input.errorCode, "MEMORY_PROJECTION_FAILED");
    const retryAfter = boundedRetry(input.retryAfterMs);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<{ status: MemoryProjectionOutboxStatus }>(
        "UPDATE agent_memory_projection_outbox SET status=CASE WHEN attempt_count >= max_attempts THEN 'dead_letter' ELSE 'queued' END, " +
        "next_attempt_at=CASE WHEN attempt_count >= max_attempts THEN now() ELSE now()+($3::double precision*interval '1 millisecond') END, " +
        "lease_owner=NULL, lease_expires_at=NULL, last_error_code=$4, completed_at=CASE WHEN attempt_count >= max_attempts THEN now() ELSE NULL END, updated_at=now() " +
        "WHERE id=$1 AND status='running' AND lease_owner=$2 RETURNING status",
        [input.task.id, input.workerId, retryAfter, errorCode],
      );
      const status = result.rows[0]?.status;
      if (!status) return null;
      await client.query(
        "UPDATE agent_memory_projection_readiness SET readiness_state='failed', last_error_code=$3, last_error_at=now(), source_outbox_id=$2 " +
        "WHERE revision_id=$1 AND projection_kind=$4 AND provider_name=$5",
        [input.task.revisionId, input.task.id, errorCode, input.task.projectionKind, input.task.providerName],
      );
      return status;
    });
  }

  /**
   * Return a claimed projection task to the queue when a scoped rollout flag
   * pauses projection. This is deliberately not a retry: the claim attempt is
   * refunded and readiness returns to accepted so an operator can resume the
   * same task without manufacturing failure or dead-letter state.
   */
  public async releaseLease(input: { task: MemoryProjectionTaskRecord; workerId: string; reason?: string; delayMs?: number }): Promise<boolean> {
    const reason = normalizedErrorCode(input.reason ?? "MEMORY_PROJECTION_ROLLOUT_DISABLED", "MEMORY_PROJECTION_ROLLOUT_DISABLED");
    const delayMs = Math.max(1_000, Math.min(Math.trunc(input.delayMs ?? 30_000), 86_400_000));
    return withTransaction(this.pool, async (client) => {
      const updated = await client.query(
        "UPDATE agent_memory_projection_outbox SET status='queued', attempt_count=GREATEST(attempt_count-1,0), " +
        "next_attempt_at=now()+($3::double precision*interval '1 millisecond'), lease_owner=NULL, lease_expires_at=NULL, " +
        "last_error_code=$4, updated_at=now() WHERE id=$1 AND status='running' AND lease_owner=$2",
        [input.task.id, input.workerId, delayMs, reason],
      );
      if ((updated.rowCount ?? 0) !== 1) return false;
      await client.query(
        "UPDATE agent_memory_projection_readiness SET readiness_state='accepted', last_error_code=$3, last_error_at=now(), source_outbox_id=$2 " +
        "WHERE revision_id=$1 AND projection_kind=$4 AND provider_name=$5 AND readiness_state='indexing'",
        [input.task.revisionId, input.task.id, reason, input.task.projectionKind, input.task.providerName],
      );
      return true;
    });
  }

  public async markBlocked(input: { task: MemoryProjectionTaskRecord; workerId: string; errorCode: string }): Promise<boolean> {
    const errorCode = normalizedErrorCode(input.errorCode, "MEMORY_PROJECTION_BLOCKED");
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        "UPDATE agent_memory_projection_outbox SET status='dead_letter', lease_owner=NULL, lease_expires_at=NULL, " +
        "last_error_code=$3, completed_at=now(), updated_at=now() WHERE id=$1 AND status='running' AND lease_owner=$2",
        [input.task.id, input.workerId, errorCode],
      );
      if ((result.rowCount ?? 0) !== 1) return false;
      await client.query(
        "UPDATE agent_memory_projection_readiness SET readiness_state='blocked', last_error_code=$3, last_error_at=now(), source_outbox_id=$2 " +
        "WHERE revision_id=$1 AND projection_kind=$4 AND provider_name=$5",
        [input.task.revisionId, input.task.id, errorCode, input.task.projectionKind, input.task.providerName],
      );
      return true;
    });
  }

  public async getReadiness(scope: { organizationId: string; revisionId: string }): Promise<MemoryProjectionReadinessRecord[]> {
    const result = await query<ReadinessRow>(
      this.pool,
      "SELECT id,revision_id,projection_kind,provider_name,readiness_state,accepted_at,indexed_at,visible_at,deleted_at," +
      "attempt_count,last_error_code,source_outbox_id,updated_at FROM agent_memory_projection_readiness " +
      "WHERE organization_id=$1 AND revision_id=$2 ORDER BY projection_kind,provider_name",
      [required(scope.organizationId, "organization_id", 240), required(scope.revisionId, "revision_id")],
    );
    return result.rows.map(readinessFromRow);
  }

  public async recordProviderReceipt(input: MemoryProviderReceiptInput): Promise<void> {
    await withTransaction(this.pool, (client) => this.upsertProviderReceiptWithClient(client, input));
  }

  private async ensureReadiness(client: PoolClient, task: MemoryProjectionTaskRecord): Promise<void> {
    await client.query(
      "INSERT INTO agent_memory_projection_readiness (" +
      "organization_id,workspace_id,agent_definition_id,agent_version_id,installation_id,fact_id,revision_id," +
      "projection_kind,provider_name,readiness_state,accepted_at,source_outbox_id" +
      ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted',$10,$11) " +
      "ON CONFLICT (revision_id,projection_kind,provider_name) DO NOTHING",
      [task.organizationId, task.workspaceId, task.agentDefinitionId, task.agentVersionId ?? null, task.installationId, task.factId, task.revisionId, task.projectionKind, task.providerName, task.acceptedAt, task.id],
    );
  }

  private async upsertProviderReceiptWithClient(client: PoolClient, input: MemoryProviderReceiptInput): Promise<void> {
    const providerName = required(input.providerName, "provider_name", 160);
    const contentDigest = required(input.contentDigest, "content_digest", 256);
    const observedAt = new Date().toISOString();
    const acceptedAt = input.acceptedAt ?? ((["accepted", "indexed", "visible"] as string[]).includes(input.providerState) ? observedAt : null);
    const indexedAt = input.indexedAt ?? ((["indexed", "visible"] as string[]).includes(input.providerState) ? observedAt : null);
    const visibleAt = input.visibleAt ?? (input.providerState === "visible" ? observedAt : null);
    await client.query(
      "INSERT INTO agent_memory_provider_projection_receipts (" +
      "organization_id,workspace_id,agent_definition_id,agent_version_id,installation_id,fact_id,revision_id,provider_name," +
      "provider_record_id,operation,provider_state,accepted_at,indexed_at,visible_at,deleted_at,provider_operation_id," +
      "content_digest,metadata,last_error_code" +
      ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19) " +
      "ON CONFLICT (revision_id,provider_name,operation) DO UPDATE SET provider_record_id=EXCLUDED.provider_record_id, " +
      "provider_state=EXCLUDED.provider_state, accepted_at=EXCLUDED.accepted_at, indexed_at=EXCLUDED.indexed_at, " +
      "visible_at=EXCLUDED.visible_at, deleted_at=EXCLUDED.deleted_at, provider_operation_id=EXCLUDED.provider_operation_id, " +
      "content_digest=EXCLUDED.content_digest, metadata=EXCLUDED.metadata, last_error_code=EXCLUDED.last_error_code, " +
      "observed_at=now(), updated_at=now()",
      [input.organizationId, input.workspaceId, input.agentDefinitionId, input.agentVersionId ?? null, input.installationId, input.factId, input.revisionId, providerName, input.providerRecordId ?? null, input.operation, input.providerState, acceptedAt, indexedAt, visibleAt, input.deletedAt ?? null, input.providerOperationId ?? null, contentDigest, JSON.stringify(input.metadata ?? {}), input.lastErrorCode ?? null],
    );
  }
}
