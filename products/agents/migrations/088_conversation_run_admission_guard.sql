-- Enforce the one-active-run-per-conversation invariant at the database boundary.
-- The preflight intentionally fails rather than silently selecting a winner when legacy data
-- already contains competing active runs.
DO $$
BEGIN
  IF EXISTS (
    SELECT conversation_id
    FROM agent_runs
    WHERE conversation_id IS NOT NULL
      AND status IN ('received', 'queued', 'running', 'awaiting_approval', 'awaiting_human', 'awaiting_external_event')
    GROUP BY conversation_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one active run per conversation while duplicate active runs exist';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_active_conversation_uidx
  ON agent_runs (conversation_id)
  WHERE conversation_id IS NOT NULL
    AND status IN ('received', 'queued', 'running', 'awaiting_approval', 'awaiting_human', 'awaiting_external_event');
