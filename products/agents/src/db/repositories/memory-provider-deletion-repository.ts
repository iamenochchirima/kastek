import type { Pool } from "pg";
import { query, withTransaction } from "../pool";

export type MemoryProviderDeletionStatus = "queued" | "running" | "completed" | "dead_letter";

export interface MemoryProviderDeletionJob {
  id: string;
  deletionJobId: string | null;
  organizationId: string;
  workspaceId: string;
  installationId: string;
  providerName: string;
  providerRecordId: string;
  contentDigest: string;
  operationId: string;
  status: MemoryProviderDeletionStatus;
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

export interface MemoryProviderDeletionInput {
  deletionJobId?: string;
  organizationId: string;
  workspaceId: string;
  installationId: string;
  providerName: string;
  providerRecordId: string;
  contentDigest: string;
  operationId: string;
  maxAttempts?: number;
}

interface ProviderDeletionRow {
  id: string;
  deletion_job_id: string | null;
  organization_id: string;
  workspace_id: string;
  installation_id: string;
  provider_name: string;
  provider_record_id: string;
  content_digest: string;
  operation_id: string;
  status: MemoryProviderDeletionStatus;
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
  return Math.max(1, Math.min(Math.trunc(value), 100));
}

function boundedLease(value: number): number {
  return Math.max(30_000, Math.min(Math.trunc(value), 900_000));
}

function boundedDelay(value: number): number {
  return Math.max(1_000, Math.min(Math.trunc(value), 86_400_000));
}

function normalizedErrorCode(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 120);
  if (!normalized) return "MEMORY_PROVIDER_DELETION_FAILED";
  return /^[A-Z]/.test(normalized) ? normalized : `ERR_${normalized}`.slice(0, 120);
}

function fromRow(row: ProviderDeletionRow): MemoryProviderDeletionJob {
  return {
    id: row.id,
    deletionJobId: row.deletion_job_id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    installationId: row.installation_id,
    providerName: row.provider_name,
    providerRecordId: row.provider_record_id,
    contentDigest: row.content_digest,
    operationId: row.operation_id,
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

const columns = [
  "id", "deletion_job_id", "organization_id", "workspace_id", "installation_id", "provider_name",
  "provider_record_id", "content_digest", "operation_id", "status", "attempt_count", "max_attempts",
  "next_attempt_at", "lease_owner", "lease_expires_at", "last_error_code", "accepted_at", "completed_at",
  "created_at", "updated_at",
].join(", ");
const jobColumns = columns.split(", ").map((column) => `job.${column}`).join(", ");

export class MemoryProviderDeletionRepository {
  public constructor(private readonly pool: Pool) {}

  public async enqueue(input: MemoryProviderDeletionInput): Promise<MemoryProviderDeletionJob> {
    const values = [
      input.deletionJobId?.trim() || null,
      required(input.organizationId, "organization_id", 240),
      required(input.workspaceId, "workspace_id", 240),
      required(input.installationId, "installation_id"),
      required(input.providerName, "provider_name", 160),
      required(input.providerRecordId, "provider_record_id"),
      required(input.contentDigest, "content_digest", 256),
      required(input.operationId, "operation_id"),
      Math.max(1, Math.min(Math.trunc(input.maxAttempts ?? 8), 20)),
    ];
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO agent_memory_provider_deletion_jobs
           (deletion_job_id, organization_id, workspace_id, installation_id, provider_name,
            provider_record_id, content_digest, operation_id, max_attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (organization_id, provider_name, provider_record_id, content_digest)
         DO UPDATE SET deletion_job_id = COALESCE(agent_memory_provider_deletion_jobs.deletion_job_id, EXCLUDED.deletion_job_id),
                       operation_id = EXCLUDED.operation_id,
                       status = CASE WHEN agent_memory_provider_deletion_jobs.status = 'completed' THEN 'completed' ELSE 'queued' END,
                       attempt_count = CASE WHEN agent_memory_provider_deletion_jobs.status = 'completed' THEN agent_memory_provider_deletion_jobs.attempt_count ELSE 0 END,
                       lease_owner = NULL,
                       lease_expires_at = NULL,
                       completed_at = CASE WHEN agent_memory_provider_deletion_jobs.status = 'completed' THEN agent_memory_provider_deletion_jobs.completed_at ELSE NULL END,
                       updated_at = now()`,
        values,
      );
      const result = await client.query<ProviderDeletionRow>(
        `SELECT ${columns}
         FROM agent_memory_provider_deletion_jobs
         WHERE organization_id = $2 AND provider_name = $5 AND provider_record_id = $6 AND content_digest = $7`,
        values,
      );
      if (!result.rows[0]) throw new Error("MEMORY_PROVIDER_DELETION_ENQUEUE_FAILED");
      return fromRow(result.rows[0]);
    });
  }

  public async claimDue(workerId: string, limit: number, leaseMs: number, organizationId?: string): Promise<MemoryProviderDeletionJob[]> {
    const id = required(workerId, "worker_id", 240);
    const org = organizationId?.trim() || null;
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<ProviderDeletionRow>(
        `WITH due AS (
           SELECT job.id
           FROM agent_memory_provider_deletion_jobs job
           WHERE ((job.status = 'queued' AND job.next_attempt_at <= now())
              OR (job.status = 'running' AND job.lease_expires_at IS NOT NULL AND job.lease_expires_at <= now()))
             AND ($4::text IS NULL OR job.organization_id = $4)
           ORDER BY job.created_at ASC
           LIMIT $2
           FOR UPDATE OF job SKIP LOCKED
         )
         UPDATE agent_memory_provider_deletion_jobs job
         SET status = 'running',
             attempt_count = job.attempt_count + 1,
             lease_owner = $1,
             lease_expires_at = now() + ($3::double precision * interval '1 millisecond')
         FROM due
         WHERE job.id = due.id
         RETURNING ${jobColumns}`,
        [id, boundedLimit(limit), boundedLease(leaseMs), org],
      );
      return result.rows.map(fromRow);
    });
  }

  public async markCompleted(input: { jobId: string; workerId: string }): Promise<boolean> {
    const result = await query(
      this.pool,
      `UPDATE agent_memory_provider_deletion_jobs
       SET status = 'completed', completed_at = now(), lease_owner = NULL,
           lease_expires_at = NULL, last_error_code = NULL, next_attempt_at = now()
       WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
      [input.jobId, input.workerId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async markRetryable(input: {
    jobId: string;
    workerId: string;
    errorCode: string;
    maxAttempts: number;
    retryAfterMs: number;
    retryable: boolean;
  }): Promise<MemoryProviderDeletionStatus | null> {
    const code = normalizedErrorCode(required(input.errorCode, "error_code", 120));
    const result = await query<{ status: MemoryProviderDeletionStatus }>(
      this.pool,
      `UPDATE agent_memory_provider_deletion_jobs
       SET status = CASE WHEN NOT $6::boolean OR attempt_count >= $4 THEN 'dead_letter' ELSE 'queued' END,
           last_error_code = $3,
           lease_owner = NULL,
           lease_expires_at = NULL,
           next_attempt_at = CASE WHEN NOT $6::boolean OR attempt_count >= $4 THEN now() ELSE now() + ($5::double precision * interval '1 millisecond') END,
           completed_at = CASE WHEN NOT $6::boolean OR attempt_count >= $4 THEN now() ELSE NULL END
       WHERE id = $1 AND lease_owner = $2 AND status = 'running'
       RETURNING status`,
      [input.jobId, input.workerId, code, Math.max(1, Math.min(Math.trunc(input.maxAttempts), 20)), boundedDelay(input.retryAfterMs), input.retryable],
    );
    return result.rows[0]?.status ?? null;
  }

  public async markDeletionJobProviderPendingComplete(deletionJobId: string): Promise<boolean> {
    const result = await query(
      this.pool,
      `UPDATE memory_deletion_jobs parent
       SET status = 'completed', provider_confirmed_at = now(), completed_at = now(),
           next_attempt_at = now()
       WHERE parent.id = $1
         AND parent.status = 'provider_pending'
         AND NOT EXISTS (
           SELECT 1 FROM agent_memory_provider_deletion_jobs child
           WHERE child.deletion_job_id = parent.id AND child.status <> 'completed'
         )`,
      [deletionJobId],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
