-- Consolidation jobs normally wait for the inbound-message threshold. A
-- pre-compaction/session boundary may explicitly request a bounded flush so
-- evidence is extracted before the working context is discarded.
ALTER TABLE memory_consolidation_jobs
  ADD COLUMN IF NOT EXISTS flush_reason TEXT NOT NULL DEFAULT 'threshold';

ALTER TABLE memory_consolidation_jobs
  DROP CONSTRAINT IF EXISTS memory_consolidation_jobs_flush_reason_check;

ALTER TABLE memory_consolidation_jobs
  ADD CONSTRAINT memory_consolidation_jobs_flush_reason_check
  CHECK (flush_reason IN ('threshold', 'pre_compaction', 'session_end', 'operator'));

CREATE INDEX IF NOT EXISTS memory_consolidation_jobs_flush_idx
  ON memory_consolidation_jobs (status, flush_reason, next_attempt_at, created_at);
