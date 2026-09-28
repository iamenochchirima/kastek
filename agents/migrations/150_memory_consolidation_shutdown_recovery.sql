-- A worker process can be terminated while a consolidation job is leased.  Keep
-- the lease recoveryable and retain an auditable record of the interruption;
-- source messages remain authoritative and the successor may safely replay the
-- job using the existing source-run/extraction-version idempotency key.
-- The application records MEMORY_CONSOLIDATION_ABANDONED in last_error_code.
ALTER TABLE memory_consolidation_jobs
  ADD COLUMN IF NOT EXISTS abandonment_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_abandoned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_abandoned_by TEXT,
  ADD COLUMN IF NOT EXISTS last_abandonment_reason TEXT,
  ADD COLUMN IF NOT EXISTS extractor_provider TEXT;

ALTER TABLE memory_consolidation_jobs
  DROP CONSTRAINT IF EXISTS memory_consolidation_jobs_abandonment_count_check;

ALTER TABLE memory_consolidation_jobs
  ADD CONSTRAINT memory_consolidation_jobs_abandonment_count_check
  CHECK (abandonment_count >= 0);

ALTER TABLE memory_consolidation_jobs
  DROP CONSTRAINT IF EXISTS memory_consolidation_jobs_abandonment_reason_check;

ALTER TABLE memory_consolidation_jobs
  ADD CONSTRAINT memory_consolidation_jobs_abandonment_reason_check
  CHECK (last_abandonment_reason IS NULL OR last_abandonment_reason ~ '^[A-Z][A-Z0-9_.-]{0,119}$');

CREATE INDEX IF NOT EXISTS memory_consolidation_jobs_abandoned_idx
  ON memory_consolidation_jobs (organization_id, last_abandoned_at DESC)
  WHERE abandonment_count > 0;
