-- Consolidation ordering is scoped to the installation that owns a conversation.
-- Keep the lease selector aligned with the ownership tuple so one busy tenant or
-- installation cannot serialize unrelated memory work.
CREATE INDEX IF NOT EXISTS memory_consolidation_jobs_partition_due_idx
  ON memory_consolidation_jobs (
    organization_id,
    installation_id,
    conversation_id,
    status,
    next_attempt_at,
    created_at
  );
