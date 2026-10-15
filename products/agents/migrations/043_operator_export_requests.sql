ALTER TABLE agent_operator_commands
  DROP CONSTRAINT IF EXISTS agent_operator_commands_command_type_check;

ALTER TABLE agent_operator_commands
  ADD CONSTRAINT agent_operator_commands_command_type_check
  CHECK (command_type IN (
    'cancel_run',
    'retry_run',
    'replay_delivery',
    'delete_memory',
    'assign_run',
    'reconcile_effect',
    'request_export',
    'kill_switch_enable',
    'kill_switch_disable',
    'suspend_installation',
    'resume_installation',
    'revoke_credential',
    'pause_schedule',
    'resume_schedule'
  ));

CREATE TABLE IF NOT EXISTS agent_export_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id UUID NOT NULL UNIQUE REFERENCES agent_operator_commands(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  requested_by TEXT NOT NULL CHECK (length(trim(requested_by)) BETWEEN 1 AND 240),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('organization', 'installation', 'run', 'conversation', 'memory')),
  scope_id TEXT CHECK (scope_id IS NULL OR length(trim(scope_id)) BETWEEN 1 AND 240),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'processing', 'completed', 'failed', 'cancelled')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_export_requests_scope_idx
  ON agent_export_requests (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_export_requests_command_idx
  ON agent_export_requests (command_id);
