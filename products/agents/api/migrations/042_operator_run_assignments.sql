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
    'kill_switch_enable',
    'kill_switch_disable',
    'suspend_installation',
    'resume_installation',
    'revoke_credential',
    'pause_schedule',
    'resume_schedule'
  ));

CREATE TABLE IF NOT EXISTS agent_operator_run_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  assignee_id TEXT NOT NULL CHECK (length(trim(assignee_id)) BETWEEN 1 AND 240),
  assigned_by TEXT NOT NULL CHECK (length(trim(assigned_by)) BETWEEN 1 AND 240),
  expected_status TEXT NOT NULL CHECK (length(trim(expected_status)) BETWEEN 1 AND 80),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_operator_run_assignments_org_idx
  ON agent_operator_run_assignments (organization_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS agent_operator_run_assignments_assignee_idx
  ON agent_operator_run_assignments (assignee_id, updated_at DESC);
