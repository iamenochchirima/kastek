-- Durable leases and lifecycle metadata for memory deletion jobs. The original
-- table predates the worker and only recorded a terminal status; this migration
-- keeps existing rows valid while making queued deletion safe to retry.
ALTER TABLE memory_deletion_jobs
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error_code TEXT,
  ADD COLUMN IF NOT EXISTS purged_memory_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS purged_conversation_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS purged_knowledge_chunk_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE memory_deletion_jobs
  DROP CONSTRAINT IF EXISTS memory_deletion_jobs_status_check;

ALTER TABLE memory_deletion_jobs
  ADD CONSTRAINT memory_deletion_jobs_status_check
  CHECK (status IN ('queued', 'running', 'held', 'completed', 'failed'));

ALTER TABLE memory_deletion_jobs
  DROP CONSTRAINT IF EXISTS memory_deletion_jobs_attempt_count_check,
  DROP CONSTRAINT IF EXISTS memory_deletion_jobs_purged_memory_count_check,
  DROP CONSTRAINT IF EXISTS memory_deletion_jobs_purged_conversation_count_check,
  DROP CONSTRAINT IF EXISTS memory_deletion_jobs_purged_knowledge_chunk_count_check;

ALTER TABLE memory_deletion_jobs
  ADD CONSTRAINT memory_deletion_jobs_attempt_count_check CHECK (attempt_count >= 0),
  ADD CONSTRAINT memory_deletion_jobs_purged_memory_count_check CHECK (purged_memory_count >= 0),
  ADD CONSTRAINT memory_deletion_jobs_purged_conversation_count_check CHECK (purged_conversation_count >= 0),
  ADD CONSTRAINT memory_deletion_jobs_purged_knowledge_chunk_count_check CHECK (purged_knowledge_chunk_count >= 0);

CREATE INDEX IF NOT EXISTS memory_deletion_jobs_due_idx
  ON memory_deletion_jobs (status, next_attempt_at, lease_expires_at, created_at);

CREATE INDEX IF NOT EXISTS memory_deletion_jobs_target_idx
  ON memory_deletion_jobs (organization_id, target_type, target_id, created_at DESC);
