CREATE TABLE IF NOT EXISTS run_workflow_state (
  run_id UUID PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS run_workflow_state_scope_idx
  ON run_workflow_state (organization_id, updated_at DESC);
