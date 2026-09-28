-- One durable approval barrier may contain many exact tool operations. The
-- child approval records remain the authorization evidence consumed by each
-- effect; this table is the reviewer-facing decision boundary.
CREATE TABLE IF NOT EXISTS agent_approval_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  run_id UUID NOT NULL REFERENCES agent_runs(id),
  batch_id TEXT NOT NULL,
  turn_key TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'partially_approved', 'rejected', 'expired', 'cancelled', 'invalidated', 'consumed')),
  selected_operation_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  decision TEXT CHECK (decision IN ('approved', 'partially_approved', 'rejected')),
  decided_by TEXT,
  decision_idempotency_key TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  UNIQUE (run_id, batch_id, turn_key),
  UNIQUE (organization_id, decision_idempotency_key)
);

ALTER TABLE agent_approval_records
  ADD COLUMN IF NOT EXISTS approval_group_id UUID REFERENCES agent_approval_groups(id);

CREATE INDEX IF NOT EXISTS agent_approval_groups_run_idx
  ON agent_approval_groups (organization_id, run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_approval_groups_pending_idx
  ON agent_approval_groups (organization_id, status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS agent_approval_groups_one_active_run_idx
  ON agent_approval_groups (run_id)
  WHERE status IN ('pending', 'approved', 'partially_approved');

CREATE INDEX IF NOT EXISTS agent_approval_records_group_idx
  ON agent_approval_records (organization_id, approval_group_id, created_at, runtime_operation_id);

DROP POLICY IF EXISTS agent_approval_groups_agents_scope ON agent_approval_groups;
CREATE POLICY agent_approval_groups_agents_scope ON agent_approval_groups
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = agent_approval_groups.run_id
        AND run.organization_id = agent_approval_groups.organization_id
        AND run.installation_id = agent_approval_groups.installation_id
    )
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = agent_approval_groups.installation_id
        AND installation.organization_id = agent_approval_groups.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = agent_approval_groups.run_id
        AND run.organization_id = agent_approval_groups.organization_id
        AND run.installation_id = agent_approval_groups.installation_id
    )
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = agent_approval_groups.installation_id
        AND installation.organization_id = agent_approval_groups.organization_id
    )
  );
ALTER TABLE agent_approval_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_approval_groups FORCE ROW LEVEL SECURITY;
