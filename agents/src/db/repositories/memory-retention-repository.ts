import type { Pool } from "pg";
import { query, withTransaction } from "../pool";
import type {
  ConflictRevisionCandidate,
  MemoryConflictCandidate,
  MemoryRetentionRule,
  OrganizationRetentionDefaults,
  QualityEventType,
} from "../../memory/retention";

export type MemoryMaintenanceJobType = "retention" | "revalidation" | "conflict";
export type MemoryMaintenanceJobStatus = "queued" | "running" | "failed";

export interface MemoryMaintenanceJobRecord {
  id: string;
  organization_id: string;
  workspace_id: string;
  job_type: MemoryMaintenanceJobType;
  status: MemoryMaintenanceJobStatus;
  next_run_at: string;
  attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error_code: string | null;
  last_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryRevalidationJobRecord {
  id: string;
  organization_id: string;
  workspace_id: string;
  agent_definition_id: string;
  installation_id: string;
  fact_id: string;
  revision_id: string;
  reason: "stale" | "low_confidence" | "conflict" | "policy";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  due_at: string;
  attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error_code: string | null;
  outcome: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface MemoryRetentionCandidate extends ConflictRevisionCandidate {
  organizationId: string;
  workspaceId: string;
  agentDefinitionId: string;
  installationId: string;
  conversationId?: string;
  endUserId?: string;
  namespace: MemoryRetentionRule["namespace"];
  memoryType: "semantic" | "episodic";
  observedAt: string;
  confidence: number | undefined;
  eventTime?: string;
  eventSummary?: string;
  typedValue: Record<string, unknown>;
  participants: readonly Record<string, unknown>[];
  outcome?: string;
  sourceTrust: "user_explicit" | "platform_curated" | "model_inferred" | "imported" | "system_observed";
  sensitivity: "normal" | "sensitive" | "restricted";
  provenance: Record<string, unknown>;
  evidenceDigest: string;
  extractionVersion: string;
  sourceEventIds: string[];
  sourceRunId?: string;
  sourceOccurredAt?: string;
  lastRevalidatedAt?: string;
  usageCount: number;
  confirmations: number;
  corrections: number;
  rejections: number;
  helpfulness: number;
  hasActiveLegalHold?: boolean;
}

function boundedLimit(value: number, max: number): number {
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

function boundedLease(value: number): number {
  return Math.max(30_000, Math.min(Math.trunc(value), 900_000));
}

function boundedDelay(value: number): number {
  return Math.max(1_000, Math.min(Math.trunc(value), 3_600_000));
}

function boundedText(value: string, field: string, max = 240): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field.toUpperCase()}_REQUIRED`);
  if (normalized.length > max) throw new Error(`${field.toUpperCase()}_TOO_LONG`);
  return normalized;
}

export class MemoryRetentionRepository {
  public constructor(private readonly pool: Pool) {}

  /**
   * Request an immediate canonical retention scan for every live workspace in
   * an organization. The worker owns expiration transitions; callers must
   * not mutate legacy memory rows inline from an operator command.
   */
  public async requestRetentionScan(organizationId: string): Promise<{ queued: number }> {
    const normalizedOrganizationId = boundedText(organizationId, "organization_id");
    const result = await query<{ workspace_id: string }>(
      this.pool,
      `WITH workspaces AS (
         SELECT DISTINCT installation.scope_id AS workspace_id
         FROM agent_installations installation
         WHERE installation.organization_id = $1
           AND installation.scope_id IS NOT NULL
           AND installation.status <> 'deleted'
         UNION
         SELECT DISTINCT fact.workspace_id
         FROM agent_memory_facts fact
         WHERE fact.organization_id = $1
       ), inserted AS (
         INSERT INTO agent_memory_maintenance_jobs (organization_id, workspace_id, job_type)
         SELECT $1, workspace_id, 'retention'
         FROM workspaces
         ON CONFLICT (organization_id, workspace_id, job_type) DO UPDATE
           SET status = CASE WHEN agent_memory_maintenance_jobs.status = 'running' THEN 'running' ELSE 'queued' END,
               next_run_at = CASE WHEN agent_memory_maintenance_jobs.status = 'running' THEN agent_memory_maintenance_jobs.next_run_at ELSE now() END,
               lease_owner = CASE WHEN agent_memory_maintenance_jobs.status = 'running' THEN agent_memory_maintenance_jobs.lease_owner ELSE NULL END,
               lease_expires_at = CASE WHEN agent_memory_maintenance_jobs.status = 'running' THEN agent_memory_maintenance_jobs.lease_expires_at ELSE NULL END,
               updated_at = now()
         RETURNING workspace_id
       )
       SELECT workspace_id FROM inserted`,
      [normalizedOrganizationId],
    );
    return { queued: result.rowCount ?? 0 };
  }

  public async ensureMaintenanceJobs(): Promise<number> {
    const result = await query(
      this.pool,
      `INSERT INTO agent_memory_maintenance_jobs (organization_id, workspace_id, job_type)
       SELECT DISTINCT fact.organization_id, fact.workspace_id, job_type.value
       FROM agent_memory_facts fact
       CROSS JOIN unnest(ARRAY['retention', 'revalidation', 'conflict']::text[]) AS job_type(value)
       ON CONFLICT (organization_id, workspace_id, job_type) DO NOTHING`,
      [],
    );
    return result.rowCount ?? 0;
  }

  public async claimMaintenanceJobs(workerId: string, limit: number, leaseMs: number, organizationId?: string): Promise<MemoryMaintenanceJobRecord[]> {
    const owner = boundedText(workerId, "worker_id");
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<MemoryMaintenanceJobRecord>(
        `WITH due AS (
           SELECT job.id
           FROM agent_memory_maintenance_jobs job
           WHERE (
             (job.status = 'queued' AND job.next_run_at <= now())
             OR (job.status = 'running' AND job.lease_expires_at IS NOT NULL AND job.lease_expires_at <= now())
           )
           AND ($4::text IS NULL OR job.organization_id = $4)
           ORDER BY job.next_run_at ASC, job.created_at ASC
           LIMIT $2
           FOR UPDATE OF job SKIP LOCKED
         )
         UPDATE agent_memory_maintenance_jobs job
         SET status = 'running', attempt_count = job.attempt_count + 1,
             lease_owner = $1,
             lease_expires_at = now() + ($3::double precision * interval '1 millisecond'),
             updated_at = now()
         FROM due
         WHERE job.id = due.id
         RETURNING job.*`,
        [owner, boundedLimit(limit, 100), boundedLease(leaseMs), organizationId?.trim() || null],
      );
      return result.rows;
    });
  }

  public async markMaintenanceCompleted(input: {
    jobId: string;
    workerId: string;
    nextRunAfterMs: number;
  }): Promise<boolean> {
    const result = await query(
      this.pool,
      `UPDATE agent_memory_maintenance_jobs
       SET status = 'queued', next_run_at = now() + ($3::double precision * interval '1 millisecond'),
           lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL,
           last_completed_at = now(), updated_at = now()
       WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
      [input.jobId, input.workerId, boundedDelay(input.nextRunAfterMs)],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async markMaintenanceRetryable(input: {
    jobId: string;
    workerId: string;
    errorCode: string;
    maxAttempts: number;
    retryAfterMs: number;
  }): Promise<MemoryMaintenanceJobStatus | null> {
    const code = boundedText(input.errorCode, "error_code", 120);
    const result = await query<{ status: MemoryMaintenanceJobStatus }>(
      this.pool,
      `UPDATE agent_memory_maintenance_jobs
       SET status = CASE WHEN attempt_count >= $4 THEN 'failed' ELSE 'queued' END,
           next_run_at = CASE WHEN attempt_count >= $4 THEN now() ELSE now() + ($6::double precision * interval '1 millisecond') END,
           last_error_code = $3, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND lease_owner = $2 AND status = 'running'
       RETURNING status`,
      [input.jobId, input.workerId, code, Math.max(1, Math.min(Math.trunc(input.maxAttempts), 20)), code, boundedDelay(input.retryAfterMs)],
    );
    return result.rows[0]?.status ?? null;
  }

  public async getOrganizationDefaults(organizationId: string): Promise<OrganizationRetentionDefaults> {
    const result = await query<{ memory_days: number; revision: number }>(
      this.pool,
      "SELECT memory_days, revision FROM agent_retention_policies WHERE organization_id = $1",
      [organizationId],
    );
    return {
      memoryDays: Number(result.rows[0]?.memory_days ?? 365),
      // Revalidation is deliberately shorter than deletion by default. It is
      // a review priority, never an implicit lifecycle transition.
      revalidateAfterDays: Math.max(1, Math.min(Number(result.rows[0]?.memory_days ?? 365), 90)),
      revision: Number(result.rows[0]?.revision ?? 0),
    };
  }

  public async listRules(organizationId: string, workspaceId: string): Promise<MemoryRetentionRule[]> {
    const result = await query<{
      scope_type: MemoryRetentionRule["scopeType"];
      scope_id: string;
      namespace: string | null;
      memory_type: "semantic" | "episodic" | null;
      fact_id: string | null;
      retention_days: number;
      revalidate_after_days: number;
      revision: number;
    }>(
      this.pool,
      `SELECT scope_type, scope_id, namespace, memory_type, fact_id::text,
              retention_days, revalidate_after_days, revision
       FROM agent_memory_retention_rules
       WHERE organization_id = $1 AND active = TRUE
         AND (scope_type = 'organization' OR scope_id = $2 OR (scope_type = 'record' AND fact_id IS NOT NULL))`,
      [organizationId, workspaceId],
    );
    return result.rows.map((row) => ({
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      ...(row.namespace ? { namespace: row.namespace } : {}),
      ...(row.memory_type ? { memoryType: row.memory_type } : {}),
      ...(row.fact_id ? { factId: row.fact_id } : {}),
      retentionDays: Number(row.retention_days),
      revalidateAfterDays: Number(row.revalidate_after_days),
      revision: Number(row.revision),
    }));
  }

  public async listCurrentCandidates(input: { organizationId: string; workspaceId: string; limit: number }): Promise<MemoryRetentionCandidate[]> {
    const result = await query<MemoryRetentionCandidate & {
      organization_id: string;
      workspace_id: string;
      agent_definition_id: string;
      installation_id: string;
      conversation_id: string | null;
      end_user_id: string | null;
      namespace: MemoryRetentionCandidate["namespace"];
      memory_type: "semantic" | "episodic";
      fact_id: string;
      revision_id: string;
      fact_key: string;
      subject_key: string;
      predicate_key: string;
      canonical_text: string;
      lifecycle_state: MemoryRetentionCandidate["lifecycleState"];
      transition_type: MemoryRetentionCandidate["transitionType"];
      predecessor_revision_id: string | null;
      valid_from: string;
      valid_to: string | null;
      observed_at: string | null;
      confidence: number | string | null;
      event_time: string | null;
      event_summary: string | null;
      typed_value: Record<string, unknown>;
      participants: readonly Record<string, unknown>[];
      outcome: string | null;
      source_trust: MemoryRetentionCandidate["sourceTrust"];
      sensitivity: MemoryRetentionCandidate["sensitivity"];
      provenance: Record<string, unknown>;
      evidence_digest: string;
      extraction_version: string;
      source_event_ids: string[];
      source_run_id: string | null;
      source_occurred_at: string | null;
      last_revalidated_at: string | null;
      usage_count: string;
      confirmations: string;
      corrections: string;
      rejections: string;
      helpfulness: string;
      has_active_legal_hold: boolean;
    }>(
      this.pool,
      `SELECT fact.organization_id, fact.workspace_id, fact.agent_definition_id,
              fact.installation_id, fact.conversation_id::text AS conversation_id,
              fact.end_user_id, fact.namespace, fact.memory_type, fact.id::text AS fact_id,
              fact.fact_key, fact.subject_key, fact.predicate_key,
              revision.id::text AS revision_id, revision.canonical_text,
              revision.lifecycle_state, revision.transition_type,
              revision.predecessor_revision_id::text, revision.valid_from,
              revision.valid_to, revision.observed_at, revision.confidence,
              revision.event_time, revision.event_summary, revision.typed_value,
              revision.participants, revision.outcome, revision.source_trust,
              revision.sensitivity, revision.provenance, revision.evidence_digest,
              revision.extraction_version,
              COALESCE((SELECT array_agg(source.source_event_id ORDER BY source.source_event_type, source.source_event_id)
                        FROM agent_memory_revision_sources source WHERE source.revision_id = revision.id), ARRAY[]::text[]) AS source_event_ids,
              (SELECT source.source_run_id::text FROM agent_memory_revision_sources source
               WHERE source.revision_id = revision.id AND source.source_run_id IS NOT NULL
               ORDER BY source.created_at ASC LIMIT 1) AS source_run_id,
              (SELECT source.source_occurred_at FROM agent_memory_revision_sources source
               WHERE source.revision_id = revision.id ORDER BY source.created_at ASC LIMIT 1) AS source_occurred_at,
              MAX(quality.occurred_at) FILTER (WHERE quality.event_type = 'revalidation_completed') AS last_revalidated_at,
              COUNT(*) FILTER (WHERE quality.event_type = 'usage')::text AS usage_count,
              COUNT(*) FILTER (WHERE quality.event_type = 'confirmation')::text AS confirmations,
              COUNT(*) FILTER (WHERE quality.event_type = 'correction')::text AS corrections,
              COUNT(*) FILTER (WHERE quality.event_type = 'rejection')::text AS rejections,
              COALESCE(SUM(quality.helpfulness) FILTER (WHERE quality.event_type = 'helpfulness'), 0)::text AS helpfulness,
              BOOL_OR(EXISTS (
                SELECT 1 FROM agent_legal_holds hold
                WHERE hold.organization_id = fact.organization_id
                  AND hold.status = 'active'
                  AND (hold.expires_at IS NULL OR hold.expires_at > now())
                  AND (
                    (hold.scope_type = 'organization' AND hold.scope_id = fact.organization_id)
                    OR (hold.scope_type = 'installation' AND hold.scope_id = fact.installation_id::text)
                    OR (hold.scope_type = 'conversation' AND hold.scope_id = fact.conversation_id::text)
                  )
              )) AS has_active_legal_hold
       FROM agent_memory_revisions revision
       JOIN agent_memory_facts fact ON fact.id = revision.fact_id
       LEFT JOIN agent_memory_quality_events quality
         ON quality.revision_id = revision.id AND quality.organization_id = fact.organization_id
       WHERE fact.organization_id = $1 AND fact.workspace_id = $2
         AND revision.lifecycle_state IN ('active', 'review_pending')
         AND (revision.lifecycle_state = 'review_pending' OR NOT EXISTS (
           SELECT 1 FROM agent_memory_revisions successor
           WHERE successor.predecessor_revision_id = revision.id
             AND successor.transition_type IN ('correction', 'supersession', 'expiration', 'deletion')
             AND successor.lifecycle_state IN ('active', 'superseded', 'expired', 'deleted')
         ))
      GROUP BY fact.organization_id, fact.workspace_id, fact.agent_definition_id,
                fact.installation_id, fact.conversation_id, fact.end_user_id,
                fact.namespace, fact.memory_type, fact.id,
                fact.fact_key, fact.subject_key, fact.predicate_key,
                revision.id, revision.canonical_text, revision.lifecycle_state,
                revision.transition_type, revision.predecessor_revision_id,
                revision.valid_from, revision.valid_to, revision.observed_at,
                revision.confidence, revision.event_time, revision.event_summary,
                revision.typed_value, revision.participants, revision.outcome,
                revision.source_trust, revision.sensitivity, revision.provenance,
                revision.evidence_digest, revision.extraction_version
       ORDER BY revision.valid_from ASC, revision.id ASC
       LIMIT $3`,
      [input.organizationId, input.workspaceId, boundedLimit(input.limit, 500)],
    );
    return result.rows.map((row) => ({
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      agentDefinitionId: row.agent_definition_id,
      installationId: row.installation_id,
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
      ...(row.end_user_id ? { endUserId: row.end_user_id } : {}),
      namespace: row.namespace,
      memoryType: row.memory_type,
      revisionId: row.revision_id,
      factId: row.fact_id,
      factKey: row.fact_key,
      subjectKey: row.subject_key,
      predicateKey: row.predicate_key,
      canonicalText: row.canonical_text,
      lifecycleState: row.lifecycle_state,
      transitionType: row.transition_type,
      ...(row.predecessor_revision_id ? { predecessorRevisionId: row.predecessor_revision_id } : {}),
      validFrom: new Date(row.valid_from).toISOString(),
      ...(row.valid_to ? { validTo: new Date(row.valid_to).toISOString() } : {}),
      observedAt: new Date(row.observed_at ?? row.valid_from).toISOString(),
      confidence: row.confidence === null ? undefined : Number(row.confidence),
      ...(row.event_time ? { eventTime: new Date(row.event_time).toISOString() } : {}),
      ...(row.event_summary ? { eventSummary: row.event_summary } : {}),
      typedValue: row.typed_value ?? {},
      participants: row.participants ?? [],
      ...(row.outcome ? { outcome: row.outcome } : {}),
      sourceTrust: row.source_trust,
      sensitivity: row.sensitivity,
      provenance: row.provenance ?? {},
      evidenceDigest: row.evidence_digest,
      extractionVersion: row.extraction_version,
      sourceEventIds: row.source_event_ids ?? [],
      ...(row.source_run_id ? { sourceRunId: row.source_run_id } : {}),
      ...(row.source_occurred_at ? { sourceOccurredAt: new Date(row.source_occurred_at).toISOString() } : {}),
      ...(row.last_revalidated_at ? { lastRevalidatedAt: new Date(row.last_revalidated_at).toISOString() } : {}),
      usageCount: Number(row.usage_count),
      confirmations: Number(row.confirmations),
      corrections: Number(row.corrections),
      rejections: Number(row.rejections),
      helpfulness: Number(row.helpfulness),
      ...(row.has_active_legal_hold ? { hasActiveLegalHold: true } : {}),
    }));
  }

  public async recordQualityEvent(input: {
    organizationId: string;
    workspaceId: string;
    agentDefinitionId: string;
    installationId: string;
    conversationId?: string;
    endUserId?: string;
    factId?: string;
    revisionId?: string;
    eventType: QualityEventType;
    helpfulness?: -1 | 0 | 1;
    actorType: "end_user" | "agent" | "operator" | "system";
    actorId: string;
    sourceRunId?: string;
    sourceDigest: string;
    metadata?: Record<string, unknown>;
    occurredAt?: string;
    idempotencyKey: string;
  }): Promise<{ status: "created" | "replayed"; id: string }> {
    if (!input.factId && !input.revisionId) throw new Error("MEMORY_QUALITY_TARGET_REQUIRED");
    const result = await query<{ id: string }>(
      this.pool,
      `INSERT INTO agent_memory_quality_events (
         organization_id, workspace_id, agent_definition_id, installation_id,
         conversation_id, end_user_id, fact_id, revision_id, event_type,
         helpfulness, actor_type, actor_id, source_run_id, source_digest,
         metadata, occurred_at, idempotency_key
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING
       RETURNING id::text`,
      [
        boundedText(input.organizationId, "organization_id"),
        boundedText(input.workspaceId, "workspace_id"),
        boundedText(input.agentDefinitionId, "agent_definition_id"),
        boundedText(input.installationId, "installation_id"),
        input.conversationId ?? null,
        input.endUserId ?? null,
        input.factId ?? null,
        input.revisionId ?? null,
        input.eventType,
        input.helpfulness ?? null,
        input.actorType,
        boundedText(input.actorId, "actor_id"),
        input.sourceRunId ?? null,
        boundedText(input.sourceDigest, "source_digest", 128),
        JSON.stringify(input.metadata ?? {}),
        input.occurredAt ?? new Date().toISOString(),
        boundedText(input.idempotencyKey, "idempotency_key"),
      ],
    );
    if (result.rows[0]) return { status: "created", id: result.rows[0].id };
    const replay = await query<{ id: string }>(this.pool, "SELECT id::text FROM agent_memory_quality_events WHERE organization_id = $1 AND idempotency_key = $2", [input.organizationId, input.idempotencyKey]);
    if (!replay.rows[0]) throw new Error("MEMORY_QUALITY_EVENT_CREATE_FAILED");
    return { status: "replayed", id: replay.rows[0].id };
  }

  public async enqueueRevalidation(input: {
    candidate: MemoryRetentionCandidate;
    reason: MemoryRevalidationJobRecord["reason"];
    dueAt: string;
    idempotencyKey: string;
  }): Promise<"created" | "replayed"> {
    const result = await query(
      this.pool,
      `INSERT INTO agent_memory_revalidation_jobs (
         organization_id, workspace_id, agent_definition_id, installation_id,
         fact_id, revision_id, reason, due_at, idempotency_key
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
      [input.candidate.organizationId, input.candidate.workspaceId, input.candidate.agentDefinitionId, input.candidate.installationId, input.candidate.factId, input.candidate.revisionId, input.reason, input.dueAt, input.idempotencyKey],
    );
    return (result.rowCount ?? 0) === 1 ? "created" : "replayed";
  }

  /**
   * Mark the durable revalidation request consumed by an explicit assertion.
   * This is deliberately conditional on queued/running state so a late worker
   * cannot overwrite a terminal outcome or race a newer request.
   */
  public async completeRevalidation(input: {
    organizationId: string;
    revisionId: string;
    outcome: "revalidated" | "rejected" | "superseded";
  }): Promise<boolean> {
    const result = await query(
      this.pool,
      `UPDATE agent_memory_revalidation_jobs
       SET status = 'completed', outcome = $3, completed_at = now(),
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE organization_id = $1 AND revision_id = $2
         AND status IN ('queued', 'running')`,
      [input.organizationId, input.revisionId, input.outcome],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async recordConflict(input: {
    organizationId: string;
    workspaceId: string;
    agentDefinitionId: string;
    installationId: string;
    conflict: MemoryConflictCandidate;
  }): Promise<"created" | "replayed"> {
    const result = await query(
      this.pool,
      `INSERT INTO agent_memory_conflicts (
         organization_id, workspace_id, agent_definition_id, installation_id, left_revision_id,
         right_revision_id, conflict_type, conflict_key, status, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (organization_id, conflict_key) DO UPDATE
       SET status = CASE WHEN agent_memory_conflicts.status = 'resolved' THEN 'resolved' ELSE EXCLUDED.status END,
           metadata = EXCLUDED.metadata
       WHERE agent_memory_conflicts.status <> 'ignored'`,
      [input.organizationId, input.workspaceId, input.agentDefinitionId, input.installationId, input.conflict.leftRevisionId, input.conflict.rightRevisionId, input.conflict.conflictType, input.conflict.conflictKey, input.conflict.resolved ? "resolved" : "open", JSON.stringify({ detector: "memory-quality-v1" })],
    );
    if ((result.rowCount ?? 0) > 0) {
      if (!input.conflict.resolved) {
        const [left, right] = [input.conflict.leftRevisionId, input.conflict.rightRevisionId].sort();
        await query(this.pool, `INSERT INTO agent_memory_relations (organization_id, from_revision_id, to_revision_id, relation_type, metadata, created_by)
          VALUES ($1, $2, $3, 'contradicts', $4::jsonb, 'system:memory-quality')
          ON CONFLICT (from_revision_id, to_revision_id, relation_type) DO NOTHING`, [input.organizationId, left, right, JSON.stringify({ conflictKey: input.conflict.conflictKey, conflictType: input.conflict.conflictType })]);
      }
      return "created";
    }
    return "replayed";
  }

  public async resolveConflict(input: { organizationId: string; conflictKey: string; actorId: string; status: "resolved" | "ignored" }): Promise<boolean> {
    const result = await query(
      this.pool,
      `UPDATE agent_memory_conflicts SET status = $3, resolved_at = now(), resolved_by = $4
       WHERE organization_id = $1 AND conflict_key = $2 AND status = 'open'`,
      [input.organizationId, input.conflictKey, input.status, boundedText(input.actorId, "actor_id")],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
