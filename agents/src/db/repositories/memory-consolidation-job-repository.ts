import type { Pool } from "pg";
import { query, withTransaction } from "../pool";

export type MemoryConsolidationJobStatus = "queued" | "running" | "completed" | "failed" | "dead_letter";

export interface MemoryConsolidationJobRecord {
  id: string;
  organization_id: string;
  agent_definition_id: string;
  agent_version_id: string;
  installation_id: string;
  conversation_id: string;
  trigger_run_id: string;
  extraction_version: string;
  status: MemoryConsolidationJobStatus;
  attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  source_message_count: number;
  candidate_count: number;
  error: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  next_attempt_at?: string;
  last_error_code?: string | null;
  evidence_digest?: string | null;
  evidence_window_start?: string | null;
  evidence_window_end?: string | null;
  extractor_model?: string | null;
  extractor_provider?: string | null;
  parser_version?: string | null;
  flush_reason: "threshold" | "pre_compaction" | "session_end" | "operator";
  abandonment_count: number;
  last_abandoned_at: string | null;
  last_abandoned_by: string | null;
  last_abandonment_reason: string | null;
}

export class MemoryConsolidationJobRepository {
  public constructor(private readonly pool: Pool) {}

  public async claimDue(workerId: string, limit: number, leaseMs: number, organizationId?: string): Promise<MemoryConsolidationJobRecord[]> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
    const boundedLease = Math.max(30_000, Math.min(Math.trunc(leaseMs), 900_000));
    return withTransaction(this.pool, async (client) => {
      // Serialize only the short claim transaction for the same scope. This
      // gives concurrent workers a stable partition fence before the
      // representative query runs; the worker can still process claimed jobs
      // concurrently after this transaction commits.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))",
        [organizationId?.trim() || "__memory_consolidation_global__"],
      );
      const result = await client.query<MemoryConsolidationJobRecord>(
        `WITH representatives AS MATERIALIZED (
           SELECT candidate.id,
                  row_number() OVER (
                    PARTITION BY candidate.organization_id, candidate.installation_id, candidate.conversation_id
                    ORDER BY candidate_run.created_at ASC, candidate_run.id ASC,
                             candidate.created_at ASC, candidate.id ASC
                  ) AS conversation_rank
           FROM memory_consolidation_jobs candidate
           JOIN agent_runs candidate_run ON candidate_run.id = candidate.trigger_run_id
             WHERE ((candidate.status = 'queued' AND candidate.next_attempt_at <= now())
              OR (candidate.status = 'running' AND candidate.lease_expires_at IS NOT NULL AND candidate.lease_expires_at <= now()))
             AND ($4::text IS NULL OR candidate.organization_id = $4)
             AND NOT EXISTS (
               SELECT 1 FROM memory_consolidation_jobs running
               WHERE running.organization_id = candidate.organization_id
                 AND running.installation_id = candidate.installation_id
                 AND running.conversation_id = candidate.conversation_id
                 AND running.status = 'running'
                 AND running.lease_expires_at IS NOT NULL
                 AND running.lease_expires_at > now()
             )
         ), due AS MATERIALIZED (
           SELECT jobs.id
           FROM memory_consolidation_jobs jobs
           JOIN conversations partition
             ON partition.id = jobs.conversation_id
            AND partition.organization_id = jobs.organization_id
           JOIN representatives representative
             ON representative.id = jobs.id AND representative.conversation_rank = 1
           JOIN agent_runs source_run ON source_run.id = jobs.trigger_run_id
           ORDER BY source_run.created_at ASC, source_run.id ASC,
                    jobs.created_at ASC, jobs.id ASC
           LIMIT $2
           -- Lock the stable conversation row as the partition fence. Locking
           -- only the representative job lets another claimer skip that row
           -- and advance to a later job from the same conversation.
           FOR UPDATE OF partition, jobs SKIP LOCKED
         )
         UPDATE memory_consolidation_jobs jobs
           SET status = 'running',
             attempt_count = jobs.attempt_count + 1,
             lease_owner = $1,
             lease_expires_at = now() + ($3::double precision * interval '1 millisecond'),
             updated_at = now(),
             next_attempt_at = now()
         WHERE jobs.id IN (SELECT due.id FROM due)
         RETURNING jobs.*`,
        [workerId, boundedLimit, boundedLease, organizationId?.trim() || null],
      );
      return result.rows;
    });
  }

  /** Re-open the source run's job for a bounded flush before compaction or session end. */
  public async requestForcedFlush(input: {
    organizationId: string;
    agentDefinitionId: string;
    agentVersionId: string;
    installationId: string;
    conversationId: string;
    triggerRunId: string;
    reason: "pre_compaction" | "session_end" | "operator";
    extractionVersion?: string;
  }): Promise<boolean> {
    const result = await query(
      this.pool,
      `INSERT INTO memory_consolidation_jobs (
         organization_id, agent_definition_id, agent_version_id, installation_id,
         conversation_id, trigger_run_id, extraction_version, flush_reason,
         status, next_attempt_at, completed_at, lease_owner, lease_expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',now(),NULL,NULL,NULL)
       ON CONFLICT (trigger_run_id, extraction_version) DO UPDATE
         SET flush_reason = EXCLUDED.flush_reason,
             status = CASE WHEN memory_consolidation_jobs.status IN ('completed','failed','dead_letter') THEN 'queued' ELSE memory_consolidation_jobs.status END,
             next_attempt_at = now(), completed_at = NULL,
             lease_owner = CASE WHEN memory_consolidation_jobs.status = 'running' THEN memory_consolidation_jobs.lease_owner ELSE NULL END,
             lease_expires_at = CASE WHEN memory_consolidation_jobs.status = 'running' THEN memory_consolidation_jobs.lease_expires_at ELSE NULL END,
             updated_at = now()`,
      [input.organizationId, input.agentDefinitionId, input.agentVersionId, input.installationId, input.conversationId, input.triggerRunId, input.extractionVersion ?? "deterministic-v1", input.reason],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async markCompleted(input: {
    jobId: string;
    workerId: string;
    sourceMessageCount: number;
    candidateCount: number;
  }): Promise<boolean> {
    const result = await query(
      this.pool,
      `UPDATE memory_consolidation_jobs
       SET status = 'completed', source_message_count = $3, candidate_count = $4,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now(), completed_at = now()
       WHERE id = $1 AND lease_owner = $2 AND status = 'running' AND lease_expires_at > now()`,
      [input.jobId, input.workerId, Math.max(0, Math.trunc(input.sourceMessageCount)), Math.max(0, Math.trunc(input.candidateCount))],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /**
   * Release a claimed job without consuming it when an operator rollout flag
   * is disabled for its owning organization or installation. The attempt is
   * returned to its prior value so a staged rollout does not manufacture
   * retries or dead letters while the queue is intentionally paused.
   */
  public async releaseLease(input: {
    jobId: string;
    workerId: string;
    reason?: string;
    delayMs?: number;
  }): Promise<boolean> {
    const reason = (input.reason?.trim() || "MEMORY_CONSOLIDATION_ROLLOUT_DISABLED")
      .toUpperCase()
      .replace(/[^A-Z0-9_.-]/g, "_")
      .slice(0, 120);
    const delayMs = Math.max(1_000, Math.min(Math.trunc(input.delayMs ?? 30_000), 86_400_000));
    const result = await query(
      this.pool,
      `UPDATE memory_consolidation_jobs
       SET status = 'queued',
           attempt_count = GREATEST(attempt_count - 1, 0),
           next_attempt_at = now() + ($3::double precision * interval '1 millisecond'),
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error_code = $4,
           error = jsonb_build_object('code', $4::text),
           updated_at = now()
       WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
      [input.jobId, input.workerId, delayMs, reason],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /**
   * Requeue leases owned by a worker that is shutting down after its drain
   * deadline.  This is intentionally a requeue, rather than a terminal
   * failure: the source run and messages are still authoritative and the next
   * worker can replay the job under the same idempotency contract.
   */
  public async abandonLeases(input: {
    workerId: string;
    reason?: string;
  }): Promise<number> {
    const reason = (input.reason?.trim() || "MEMORY_WORKER_SHUTDOWN_TIMEOUT")
      .toUpperCase()
      .replace(/[^A-Z0-9_.-]/g, "_")
      .slice(0, 120);
    const result = await query(
      this.pool,
      `UPDATE memory_consolidation_jobs
       SET status = 'queued',
           next_attempt_at = now(),
           completed_at = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL,
           abandonment_count = abandonment_count + 1,
           last_abandoned_at = now(),
           last_abandoned_by = $1,
           last_abandonment_reason = $2,
           last_error_code = 'MEMORY_CONSOLIDATION_ABANDONED',
           error = jsonb_build_object('code', 'MEMORY_CONSOLIDATION_ABANDONED', 'reason', $2::text),
           updated_at = now()
       WHERE lease_owner = $1 AND status = 'running'`,
      [input.workerId, reason],
    );
    return result.rowCount ?? 0;
  }

  public async recordEvidenceWindow(input: {
    jobId: string;
    workerId: string;
    evidenceDigest: string;
    windowStart?: string;
    windowEnd?: string;
    extractorModel?: string;
    extractorProvider?: string;
    parserVersion?: string;
  }): Promise<boolean> {
    const result = await query(
      this.pool,
      `UPDATE memory_consolidation_jobs
       SET evidence_digest = $3,
           evidence_window_start = $4::timestamptz,
           evidence_window_end = $5::timestamptz,
           extractor_model = $6,
           extractor_provider = $7,
           parser_version = $8,
           updated_at = now()
       WHERE id = $1 AND lease_owner = $2 AND status = 'running' AND lease_expires_at > now()`,
      [input.jobId, input.workerId, input.evidenceDigest, input.windowStart ?? null, input.windowEnd ?? null, input.extractorModel ?? null, input.extractorProvider ?? null, input.parserVersion ?? null],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async markRetryable(input: {
    jobId: string;
    workerId: string;
    error: Record<string, unknown>;
    maxAttempts: number;
    retryAfterMs?: number;
    errorCode?: string;
  }): Promise<MemoryConsolidationJobStatus | null> {
    const result = await query<{ status: MemoryConsolidationJobStatus }>(
      this.pool,
      `UPDATE memory_consolidation_jobs
       SET status = CASE WHEN attempt_count >= $4 THEN 'dead_letter' ELSE 'queued' END,
           error = $3::jsonb, last_error_code = $5, lease_owner = NULL, lease_expires_at = NULL,
           next_attempt_at = CASE WHEN attempt_count >= $4 THEN now() ELSE now() + ($6::double precision * interval '1 millisecond') END,
           updated_at = now(), completed_at = CASE WHEN attempt_count >= $4 THEN now() ELSE NULL END
       WHERE id = $1 AND lease_owner = $2 AND status = 'running' AND lease_expires_at > now()
       RETURNING status`,
      [input.jobId, input.workerId, JSON.stringify({
        code: (input.errorCode ?? (typeof input.error.code === "string" ? input.error.code : "MEMORY_CONSOLIDATION_FAILED"))
          .trim().toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 120),
      }), Math.max(1, Math.min(Math.trunc(input.maxAttempts), 20)),
        (input.errorCode ?? "MEMORY_CONSOLIDATION_FAILED").trim().toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 120),
        Math.max(1_000, Math.min(Math.trunc(input.retryAfterMs ?? 2_000), 86_400_000))],
    );
    return result.rows[0]?.status ?? null;
  }

  public async requeueDeadLetter(jobId: string): Promise<boolean> {
    const result = await query(
      this.pool,
      `UPDATE memory_consolidation_jobs
       SET status = 'queued', attempt_count = 0, error = NULL, last_error_code = NULL,
           next_attempt_at = now(), completed_at = NULL, lease_owner = NULL,
           lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'dead_letter'`,
      [jobId],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
