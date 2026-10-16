CREATE TABLE IF NOT EXISTS agent_readiness_evaluation_state (
  installation_id UUID PRIMARY KEY REFERENCES agent_installations(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  next_evaluation_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_evaluated_at TIMESTAMPTZ,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_readiness_evaluation_due_idx
  ON agent_readiness_evaluation_state (next_evaluation_at, lease_expires_at, installation_id);
