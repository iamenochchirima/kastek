CREATE TABLE IF NOT EXISTS agent_operator_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_type TEXT NOT NULL CHECK (command_type IN ('cancel_run', 'reconcile_effect', 'kill_switch_enable', 'kill_switch_disable')),
  target_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  organization_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('awaiting_approval', 'executing', 'completed', 'failed')),
  required_approvals INTEGER NOT NULL CHECK (required_approvals BETWEEN 1 AND 2),
  approvers TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  idempotency_key TEXT NOT NULL UNIQUE,
  result JSONB,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_operator_commands_status_idx
  ON agent_operator_commands (status, updated_at DESC);
