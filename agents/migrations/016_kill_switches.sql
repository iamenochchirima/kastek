CREATE TABLE IF NOT EXISTS agent_kill_switches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'organization', 'agent', 'installation', 'tool')),
  scope_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_kill_switch_active_idx
  ON agent_kill_switches (COALESCE(organization_id, ''), scope_type, scope_id)
  WHERE enabled;
