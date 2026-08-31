-- Conversation rows are locked during run admission. This index keeps the
-- one-active-run invariant cheap as completed history grows.
CREATE INDEX IF NOT EXISTS agent_runs_active_conversation_idx
  ON agent_runs (organization_id, conversation_id, created_at)
  WHERE status IN ('received', 'queued', 'running', 'awaiting_approval', 'awaiting_human', 'awaiting_external_event');
