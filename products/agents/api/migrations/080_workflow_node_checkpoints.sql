CREATE TABLE IF NOT EXISTS run_workflow_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  node_id TEXT NOT NULL CHECK (length(trim(node_id)) BETWEEN 1 AND 120),
  next_node_id TEXT CHECK (next_node_id IS NULL OR length(trim(next_node_id)) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('completed', 'paused', 'failed')),
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  trace JSONB NOT NULL DEFAULT '[]'::jsonb,
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence_number),
  UNIQUE (run_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS run_workflow_checkpoints_latest_idx
  ON run_workflow_checkpoints (organization_id, run_id, sequence_number DESC);

DROP TRIGGER IF EXISTS run_workflow_checkpoints_ownership_trigger ON run_workflow_checkpoints;
CREATE TRIGGER run_workflow_checkpoints_ownership_trigger
BEFORE INSERT OR UPDATE OF organization_id, run_id ON run_workflow_checkpoints
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_run_child_scope();
