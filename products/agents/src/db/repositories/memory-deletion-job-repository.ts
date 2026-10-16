import type { Pool } from "pg";
import { query, withTransaction } from "../pool";

export type MemoryDeletionJobStatus = "queued" | "running" | "held" | "provider_pending" | "completed" | "failed";
export type MemoryDeletionTargetType = "memory" | "knowledge_source" | "conversation" | "user" | "agent" | "workspace" | "organization";

export interface MemoryDeletionJobRecord {
  id: string;
  organization_id: string;
  requested_by: string;
  target_type: MemoryDeletionTargetType;
  target_id: string;
  status: MemoryDeletionJobStatus;
  attempt_count: number;
  next_attempt_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  held_at: string | null;
  last_error_code: string | null;
  purged_memory_count: number;
  purged_conversation_count: number;
  purged_knowledge_chunk_count: number;
  provider_deletion_count: number;
  provider_confirmed_at: string | null;
  error: Record<string, unknown> | null;
  created_at: string;
  completed_at: string | null;
}

export interface MemoryDeletionPurgeCounts {
  memoryCount: number;
  conversationCount: number;
  knowledgeChunkCount: number;
  providerDeletionCount?: number;
}

export interface MemoryDeletionEnqueueResult {
  id: string;
  status: MemoryDeletionJobStatus;
  replayed: boolean;
}

function boundedLimit(value: number): number {
  return Math.max(1, Math.min(Math.trunc(value), 100));
}

function boundedLease(value: number): number {
  return Math.max(30_000, Math.min(Math.trunc(value), 900_000));
}

function boundedDelay(value: number): number {
  return Math.max(1_000, Math.min(Math.trunc(value), 3_600_000));
}

/**
 * A target-aware hold predicate used while claiming jobs. The worker checks
 * again inside its purge transaction; this predicate only avoids repeatedly
 * claiming work that is already known to be held.
 */
const activeHoldPredicate = `
  EXISTS (
    SELECT 1
    FROM agent_legal_holds hold
    WHERE hold.organization_id = job.organization_id
      AND hold.status = 'active'
      AND (hold.expires_at IS NULL OR hold.expires_at > now())
      AND (
        (job.target_type = 'organization')
        OR (hold.scope_type = 'organization' AND hold.scope_id = job.organization_id)
        OR (job.target_type = 'conversation' AND hold.scope_type = 'conversation' AND hold.scope_id = job.target_id)
        OR (
          job.target_type IN ('user', 'agent', 'workspace')
          AND EXISTS (
            SELECT 1
            FROM agent_installations installation
            WHERE installation.organization_id = job.organization_id
              AND (
                (job.target_type = 'agent' AND installation.agent_definition_id::text = job.target_id)
                OR (job.target_type = 'workspace' AND installation.scope_id = job.target_id)
                OR (job.target_type = 'user' AND EXISTS (
                  SELECT 1 FROM memory_records memory
                  WHERE memory.organization_id = job.organization_id
                    AND memory.installation_id = installation.id
                    AND memory.owner_user_id = job.target_id
                ))
              )
              AND hold.scope_type = 'installation'
              AND hold.scope_id = installation.id::text
          )
        )
        OR (
          job.target_type = 'memory'
          AND EXISTS (
            SELECT 1
            FROM memory_records memory
            WHERE memory.id::text = job.target_id
              AND memory.organization_id = job.organization_id
              AND (
                (hold.scope_type = 'installation' AND hold.scope_id = memory.installation_id::text)
                OR (hold.scope_type = 'conversation' AND hold.scope_id = memory.conversation_id::text)
              )
          )
        )
        OR (
          job.target_type = 'knowledge_source'
          AND EXISTS (
            SELECT 1
            FROM knowledge_sources source
            WHERE source.id::text = job.target_id
              AND source.organization_id = job.organization_id
              AND hold.scope_type = 'installation'
              AND hold.scope_id = source.installation_id::text
          )
        )
      )
  )`;

export class MemoryDeletionJobRepository {
  public constructor(private readonly pool: Pool) {}

  /**
   * Enqueue a scoped deletion target without creating duplicate active jobs.
   * The target identity is the canonical idempotency boundary for operator and
   * retention callers; a failed job may be retried with a new queue record.
   */
  public async enqueue(input: {
    organizationId: string;
    requestedBy: string;
    targetType: MemoryDeletionTargetType;
    targetId: string;
  }): Promise<MemoryDeletionEnqueueResult> {
    const organizationId = input.organizationId.trim();
    const requestedBy = input.requestedBy.trim();
    const targetId = input.targetId.trim();
    if (!organizationId || !requestedBy || !targetId) throw new Error("MEMORY_DELETION_SCOPE_REQUIRED");
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query<{ id: string; status: MemoryDeletionJobStatus }>(
        `SELECT id::text, status
         FROM memory_deletion_jobs
         WHERE organization_id = $1 AND target_type = $2 AND target_id = $3
           AND status IN ('queued', 'running', 'held', 'provider_pending', 'completed')
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [organizationId, input.targetType, targetId],
      );
      if (existing.rows[0]) return { id: existing.rows[0].id, status: existing.rows[0].status, replayed: true };
      const inserted = await client.query<{ id: string; status: MemoryDeletionJobStatus }>(
        `INSERT INTO memory_deletion_jobs (organization_id, requested_by, target_type, target_id, status)
         VALUES ($1, $2, $3, $4, 'queued')
         RETURNING id::text, status`,
        [organizationId, requestedBy, input.targetType, targetId],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("MEMORY_DELETION_ENQUEUE_FAILED");
      return { id: row.id, status: row.status, replayed: false };
    });
  }

  public async claimDue(workerId: string, limit: number, leaseMs: number, organizationId?: string): Promise<MemoryDeletionJobRecord[]> {
    const boundedWorkerId = workerId.trim().slice(0, 240);
    if (!boundedWorkerId) throw new Error("Memory deletion worker ID is required");
    const boundedOrganizationId = organizationId?.trim() || null;
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<MemoryDeletionJobRecord>(
        `WITH due AS (
           SELECT job.id
           FROM memory_deletion_jobs job
           WHERE (
             (job.status = 'queued' AND job.next_attempt_at <= now())
             OR (job.status = 'running' AND job.lease_expires_at IS NOT NULL AND job.lease_expires_at <= now())
             OR (job.status = 'held' AND job.next_attempt_at <= now())
           )
             AND ($4::text IS NULL OR job.organization_id = $4)
             -- Expired running leases are reclaimed even under a hold so the
             -- worker can make the durable held state visible.
             AND NOT (${activeHoldPredicate} AND job.status <> 'running')
           ORDER BY job.created_at ASC
           LIMIT $2
           FOR UPDATE OF job SKIP LOCKED
         )
         UPDATE memory_deletion_jobs job
         SET status = 'running',
             attempt_count = job.attempt_count + 1,
             lease_owner = $1,
             lease_expires_at = now() + ($3::double precision * interval '1 millisecond'),
             held_at = NULL
         FROM due
         WHERE job.id = due.id
         RETURNING job.*`,
        [boundedWorkerId, boundedLimit(limit), boundedLease(leaseMs), boundedOrganizationId],
      );
      return result.rows;
    });
  }

  public async markCompleted(input: {
    jobId: string;
    workerId: string;
    counts: MemoryDeletionPurgeCounts;
  }): Promise<boolean> {
    const result = await query(
      this.pool,
      `UPDATE memory_deletion_jobs
       SET status = CASE
           WHEN EXISTS (
             SELECT 1
             FROM agent_memory_provider_deletion_jobs provider_job
             WHERE provider_job.deletion_job_id = memory_deletion_jobs.id
               AND provider_job.status <> 'completed'
           ) THEN 'provider_pending'
           ELSE 'completed'
         END,
           purged_memory_count = $3,
           purged_conversation_count = $4,
           purged_knowledge_chunk_count = $5,
           provider_deletion_count = $6,
           error = NULL,
           last_error_code = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL,
           next_attempt_at = now(),
           completed_at = CASE
             WHEN EXISTS (
               SELECT 1
               FROM agent_memory_provider_deletion_jobs provider_job
               WHERE provider_job.deletion_job_id = memory_deletion_jobs.id
                 AND provider_job.status <> 'completed'
             ) THEN NULL
             ELSE now()
           END,
           provider_confirmed_at = CASE
             WHEN EXISTS (
               SELECT 1
               FROM agent_memory_provider_deletion_jobs provider_job
               WHERE provider_job.deletion_job_id = memory_deletion_jobs.id
                 AND provider_job.status <> 'completed'
             ) THEN NULL
             ELSE now()
           END
       WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
      [
        input.jobId,
        input.workerId,
        Math.max(0, Math.trunc(input.counts.memoryCount)),
        Math.max(0, Math.trunc(input.counts.conversationCount)),
        Math.max(0, Math.trunc(input.counts.knowledgeChunkCount)),
        Math.max(0, Math.trunc(input.counts.providerDeletionCount ?? 0)),
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async markProviderConfirmed(jobId: string): Promise<boolean> {
    const result = await query(
      this.pool,
      `UPDATE memory_deletion_jobs
       SET status = 'completed', provider_confirmed_at = now(), completed_at = now(), next_attempt_at = now()
       WHERE id = $1 AND status = 'provider_pending'
         AND NOT EXISTS (
           SELECT 1 FROM agent_memory_provider_deletion_jobs child
           WHERE child.deletion_job_id = memory_deletion_jobs.id
             AND child.status <> 'completed'
         )`,
      [jobId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async markHeld(input: { jobId: string; workerId: string; retryAfterMs: number }): Promise<boolean> {
    const result = await query(
      this.pool,
      `UPDATE memory_deletion_jobs
       SET status = 'held',
           held_at = now(),
           last_error_code = 'MEMORY_LEGAL_HOLD_ACTIVE',
           error = jsonb_build_object('code', 'MEMORY_LEGAL_HOLD_ACTIVE'),
           lease_owner = NULL,
           lease_expires_at = NULL,
           next_attempt_at = now() + ($3::double precision * interval '1 millisecond'),
           completed_at = NULL
       WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
      [input.jobId, input.workerId, boundedDelay(input.retryAfterMs)],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async markRetryable(input: {
    jobId: string;
    workerId: string;
    error: { code: string; message?: string };
    maxAttempts: number;
    retryAfterMs: number;
  }): Promise<MemoryDeletionJobStatus | null> {
    const code = input.error.code.trim().slice(0, 120) || "MEMORY_DELETION_FAILED";
    // Deletion receipts are intentionally code-only. Even bounded exception
    // text can contain canonical memory content or provider payloads.
    const sanitizedError = JSON.stringify({ code });
    const result = await query<{ status: MemoryDeletionJobStatus }>(
      this.pool,
      `UPDATE memory_deletion_jobs
       SET status = CASE WHEN attempt_count >= $4 THEN 'failed' ELSE 'queued' END,
           error = $3::jsonb,
           last_error_code = $5,
           lease_owner = NULL,
           lease_expires_at = NULL,
           next_attempt_at = CASE WHEN attempt_count >= $4 THEN now() ELSE now() + ($6::double precision * interval '1 millisecond') END,
           completed_at = CASE WHEN attempt_count >= $4 THEN now() ELSE NULL END
       WHERE id = $1 AND lease_owner = $2 AND status = 'running'
       RETURNING status`,
      [input.jobId, input.workerId, sanitizedError, Math.max(1, Math.min(Math.trunc(input.maxAttempts), 20)), code, boundedDelay(input.retryAfterMs)],
    );
    return result.rows[0]?.status ?? null;
  }
}
