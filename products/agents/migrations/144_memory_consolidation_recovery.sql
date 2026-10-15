-- Give consolidation the same explicit recovery contract as projection and
-- deletion queues. Source messages remain authoritative while a job retries or
-- waits for operator reprocessing.
ALTER TABLE memory_consolidation_jobs
  DROP CONSTRAINT IF EXISTS memory_consolidation_jobs_status_check;

ALTER TABLE memory_consolidation_jobs
  ADD CONSTRAINT memory_consolidation_jobs_status_check
  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'dead_letter'));

UPDATE memory_consolidation_jobs
SET status = 'dead_letter'
WHERE status = 'failed';

ALTER TABLE memory_consolidation_jobs
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_error_code TEXT,
  ADD COLUMN IF NOT EXISTS evidence_digest TEXT,
  ADD COLUMN IF NOT EXISTS evidence_window_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS evidence_window_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extractor_model TEXT,
  ADD COLUMN IF NOT EXISTS parser_version TEXT;

CREATE INDEX IF NOT EXISTS memory_consolidation_jobs_recovery_idx
  ON memory_consolidation_jobs (status, next_attempt_at, created_at);

ALTER TABLE memory_consolidation_jobs
  DROP CONSTRAINT IF EXISTS memory_consolidation_jobs_error_code_check;

ALTER TABLE memory_consolidation_jobs
  ADD CONSTRAINT memory_consolidation_jobs_error_code_check
  CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_.-]{0,119}$');
