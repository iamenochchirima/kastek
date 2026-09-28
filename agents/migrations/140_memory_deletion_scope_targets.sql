-- Extend the single durable deletion workflow to every memory ownership scope.
ALTER TABLE memory_deletion_jobs
  DROP CONSTRAINT IF EXISTS memory_deletion_jobs_target_type_check;

ALTER TABLE memory_deletion_jobs
  ADD CONSTRAINT memory_deletion_jobs_target_type_check
  CHECK (target_type IN ('memory', 'knowledge_source', 'conversation', 'user', 'agent', 'workspace', 'organization'));

CREATE INDEX IF NOT EXISTS memory_deletion_jobs_scope_target_idx
  ON memory_deletion_jobs (organization_id, target_type, target_id, status, created_at DESC);
