import type { Pool } from "pg";
import { query, withTransaction } from "../pool";

export type MemoryConsolidationJobStatus = "queued" | "running" | "completed" | "failed";

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
}

export class MemoryConsolidationJobRepository {
  public constructor(private readonly pool: Pool) {}

  public async claimDue(workerId: string, limit: number, leaseMs: number, organizationId?: string): Promise<MemoryConsolidationJobRecord[]> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
    const boundedLease = Math.max(30_000, Math.min(Math.trunc(leaseMs), 900_000));
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<MemoryConsolidationJobRecord>(
        `WITH representatives AS (
           SELECT candidate.id,
                  row_number() OVER (PARTITION BY candidate.conversation_id ORDER BY candidate.created_at ASC) AS conversation_rank
           FROM memory_consolidation_jobs candidate
           WHERE (candidate.status = 'queued'
              OR (candidate.status = 'running' AND candidate.lease_expires_at IS NOT NULL AND candidate.lease_expires_at <= now()))
             AND ($4::text IS NULL OR candidate.organization_id = $4)
             AND NOT EXISTS (
               SELECT 1 FROM memory_consolidation_jobs running
               WHERE running.conversation_id = candidate.conversation_id
                 AND running.status = 'running'
                 AND running.lease_expires_at IS NOT NULL
                 AND running.lease_expires_at > now()
             )
         ), due AS (
           SELECT jobs.id
           FROM memory_consolidation_jobs jobs
           JOIN representatives representative
             ON representative.id = jobs.id AND representative.conversation_rank = 1
           ORDER BY jobs.created_at ASC
           LIMIT $2
           FOR UPDATE OF jobs SKIP LOCKED
         )
         UPDATE memory_consolidation_jobs jobs
         SET status = 'running',
             attempt_count = jobs.attempt_count + 1,
             lease_owner = $1,
             lease_expires_at = now() + ($3::double precision * interval '1 millisecond'),
             updated_at = now()
         FROM due
         WHERE jobs.id = due.id
         RETURNING jobs.*`,
        [workerId, boundedLimit, boundedLease, organizationId?.trim() || null],
      );
      return result.rows;
    });
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
       WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
      [input.jobId, input.workerId, Math.max(0, Math.trunc(input.sourceMessageCount)), Math.max(0, Math.trunc(input.candidateCount))],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async markRetryable(input: {
    jobId: string;
    workerId: string;
    error: Record<string, unknown>;
    maxAttempts: number;
  }): Promise<MemoryConsolidationJobStatus | null> {
    const result = await query<{ status: MemoryConsolidationJobStatus }>(
      this.pool,
      `UPDATE memory_consolidation_jobs
       SET status = CASE WHEN attempt_count >= $4 THEN 'failed' ELSE 'queued' END,
           error = $3::jsonb, lease_owner = NULL, lease_expires_at = NULL,
           updated_at = now(), completed_at = CASE WHEN attempt_count >= $4 THEN now() ELSE NULL END
       WHERE id = $1 AND lease_owner = $2 AND status = 'running'
       RETURNING status`,
      [input.jobId, input.workerId, JSON.stringify(input.error), Math.max(1, Math.min(Math.trunc(input.maxAttempts), 20))],
    );
    return result.rows[0]?.status ?? null;
  }
}
