ALTER TABLE evals.agent_refs
  ADD COLUMN IF NOT EXISTS retired_at timestamptz;

CREATE INDEX IF NOT EXISTS agent_refs_active
  ON evals.agent_refs(sandbox_id, created_at DESC, id DESC)
  WHERE retired_at IS NULL;
