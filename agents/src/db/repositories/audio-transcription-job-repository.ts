import type { Pool } from "pg";
import { query, withTransaction } from "../pool";

export type AudioTranscriptionJobStatus =
  | "queued"
  | "processing"
  | "dispatching"
  | "completed"
  | "retryable_failed"
  | "failed";

export type AudioTranscriptionDispatchKind = "platform" | "external";

export interface AudioTranscriptionJobRecord {
  id: string;
  organization_id: string;
  installation_id: string;
  actor_id: string;
  correlation_id: string;
  idempotency_key: string;
  asset_id: string;
  dispatch_kind: AudioTranscriptionDispatchKind;
  dispatch_input: Record<string, unknown>;
  status: AudioTranscriptionJobStatus;
  attempt_count: number;
  next_attempt_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  transcript: string | null;
  language_code: string | null;
  result_conversation_id: string | null;
  result_message_id: string | null;
  result_run_id: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueAudioTranscriptionJobInput {
  organizationId: string;
  installationId: string;
  actorId: string;
  correlationId: string;
  idempotencyKey: string;
  assetId: string;
  dispatchKind: AudioTranscriptionDispatchKind;
  dispatchInput: Record<string, unknown>;
}

function validateInput(input: EnqueueAudioTranscriptionJobInput): void {
  for (const [name, value] of Object.entries({
    organizationId: input.organizationId,
    installationId: input.installationId,
    actorId: input.actorId,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    assetId: input.assetId,
  })) {
    if (!value.trim()) throw new Error(`Audio transcription ${name} is required`);
  }
  const serialized = JSON.stringify(input.dispatchInput);
  if (!serialized || serialized.length > 100_000) throw new Error("Audio transcription dispatch input is too large");
}

export function transcriptionRetryDelayMs(attemptCount: number, baseDelayMs = 2_000, maxDelayMs = 300_000): number {
  const attempt = Number.isSafeInteger(attemptCount) && attemptCount > 0 ? attemptCount : 1;
  const base = Number.isFinite(baseDelayMs) && baseDelayMs >= 0 ? baseDelayMs : 2_000;
  const max = Number.isFinite(maxDelayMs) && maxDelayMs >= base ? maxDelayMs : Math.max(base, 300_000);
  return Math.min(max, base * (2 ** Math.min(attempt - 1, 16)));
}

export class AudioTranscriptionJobRepository {
  public constructor(private readonly pool: Pool) {}

  public async enqueue(input: EnqueueAudioTranscriptionJobInput): Promise<{ job: AudioTranscriptionJobRecord; created: boolean }> {
    validateInput(input);
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<AudioTranscriptionJobRecord>(
        `INSERT INTO audio_transcription_jobs
          (organization_id, installation_id, actor_id, correlation_id, idempotency_key, asset_id,
           dispatch_kind, dispatch_input)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          input.organizationId,
          input.installationId,
          input.actorId,
          input.correlationId,
          input.idempotencyKey,
          input.assetId,
          input.dispatchKind,
          JSON.stringify(input.dispatchInput),
        ],
      );
      if (inserted.rows[0]) return { job: inserted.rows[0], created: true };
      const existing = await client.query<AudioTranscriptionJobRecord>(
        `SELECT * FROM audio_transcription_jobs
         WHERE organization_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [input.organizationId, input.idempotencyKey],
      );
      const job = existing.rows[0];
      if (!job) throw new Error("Audio transcription idempotency record disappeared");
      if (job.asset_id !== input.assetId || job.dispatch_kind !== input.dispatchKind) {
        throw new Error("Audio transcription idempotency key already belongs to another request");
      }
      return { job, created: false };
    });
  }

  public async get(organizationId: string, jobId: string): Promise<AudioTranscriptionJobRecord | null> {
    const result = await query<AudioTranscriptionJobRecord>(
      this.pool,
      `SELECT * FROM audio_transcription_jobs WHERE organization_id = $1 AND id = $2`,
      [organizationId, jobId],
    );
    return result.rows[0] ?? null;
  }

  public async claimDue(workerId: string, limit: number, leaseMs: number): Promise<AudioTranscriptionJobRecord[]> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
    const boundedLease = Math.max(30_000, Math.min(Math.trunc(leaseMs), 900_000));
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<AudioTranscriptionJobRecord>(
        `WITH expired AS (
           UPDATE audio_transcription_jobs
           SET status = CASE WHEN transcript IS NULL THEN 'retryable_failed' ELSE 'dispatching' END,
               lease_owner = NULL,
               lease_expires_at = NULL,
               error_code = 'AUDIO_JOB_LEASE_EXPIRED',
               error_message = 'Audio transcription worker lease expired',
               next_attempt_at = now()
           WHERE status IN ('processing', 'dispatching')
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= now()
           RETURNING id
         ), candidates AS (
           SELECT id
           FROM audio_transcription_jobs
           WHERE status IN ('queued', 'retryable_failed', 'dispatching')
             AND next_attempt_at <= now()
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE audio_transcription_jobs jobs
         SET status = CASE WHEN jobs.transcript IS NULL THEN 'processing' ELSE 'dispatching' END,
             attempt_count = jobs.attempt_count + 1,
             lease_owner = $1,
             lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
             started_at = COALESCE(jobs.started_at, now()),
             error_code = NULL,
             error_message = NULL
         FROM candidates
         WHERE jobs.id = candidates.id
         RETURNING jobs.*`,
        [workerId, boundedLimit, boundedLease],
      );
      return result.rows;
    });
  }

  public async markTranscribed(input: { jobId: string; workerId: string; transcript: string; languageCode?: string }): Promise<boolean> {
    const transcript = input.transcript.trim().slice(0, 200_000);
    if (!transcript) throw new Error("Audio transcription cannot be empty");
    const result = await query(
      this.pool,
      `UPDATE audio_transcription_jobs
       SET status = 'dispatching', transcript = $3, language_code = $4,
           lease_owner = $2, lease_expires_at = now() + interval '5 minutes',
           error_code = NULL, error_message = NULL
       WHERE id = $1 AND lease_owner = $2 AND status = 'processing'`,
      [input.jobId, input.workerId, transcript, input.languageCode?.trim().slice(0, 32) || null],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async markDispatched(input: {
    jobId: string;
    workerId: string;
    conversationId?: string;
    messageId?: string;
    runId: string;
  }): Promise<boolean> {
    const result = await query(
      this.pool,
      `UPDATE audio_transcription_jobs
       SET status = 'completed', completed_at = now(), lease_owner = NULL, lease_expires_at = NULL,
           result_conversation_id = $3, result_message_id = $4, result_run_id = $5,
           error_code = NULL, error_message = NULL
       WHERE id = $1 AND lease_owner = $2 AND status = 'dispatching'`,
      [input.jobId, input.workerId, input.conversationId ?? null, input.messageId ?? null, input.runId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async markRetryable(input: { jobId: string; workerId: string; errorCode: string; errorMessage: string; delayMs: number }): Promise<boolean> {
    const result = await query(
      this.pool,
      `UPDATE audio_transcription_jobs
       SET status = CASE WHEN transcript IS NULL THEN 'retryable_failed' ELSE 'dispatching' END,
           next_attempt_at = now() + ($5::bigint * interval '1 millisecond'),
           lease_owner = NULL, lease_expires_at = NULL,
           error_code = $3, error_message = LEFT($4, 2_000)
       WHERE id = $1 AND lease_owner = $2 AND status IN ('processing', 'dispatching')`,
      [input.jobId, input.workerId, input.errorCode.slice(0, 120), input.errorMessage, Math.max(0, Math.trunc(input.delayMs))],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async markFailed(input: { jobId: string; workerId: string; errorCode: string; errorMessage: string }): Promise<boolean> {
    const result = await query(
      this.pool,
      `UPDATE audio_transcription_jobs
       SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
           error_code = $3, error_message = LEFT($4, 2_000)
       WHERE id = $1 AND lease_owner = $2 AND status IN ('processing', 'dispatching')`,
      [input.jobId, input.workerId, input.errorCode.slice(0, 120), input.errorMessage],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
