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
    'set_feature_flag',
    'clear_feature_flag',
    'create_hold',
    'release_hold',
    'kill_switch_enable',
    'kill_switch_disable',
    'suspend_installation',
    'resume_installation',
    'revoke_credential',
    'pause_schedule',
    'resume_schedule'
  ));

CREATE TABLE IF NOT EXISTS agent_operator_feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'organization', 'installation')),
  scope_id TEXT NOT NULL CHECK (length(trim(scope_id)) BETWEEN 1 AND 240),
  organization_id TEXT,
  flag_key TEXT NOT NULL CHECK (flag_key IN ('agent_execution_enabled', 'effect_execution_enabled', 'mcp_enabled', 'rest_enabled')),
  enabled BOOLEAN NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  expires_at TIMESTAMPTZ NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id, flag_key)
);

CREATE INDEX IF NOT EXISTS agent_operator_feature_flags_lookup_idx
  ON agent_operator_feature_flags (flag_key, scope_type, scope_id, expires_at);

CREATE TABLE IF NOT EXISTS agent_operator_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('organization', 'installation', 'run')),
  scope_id TEXT NOT NULL CHECK (length(trim(scope_id)) BETWEEN 1 AND 240),
  hold_type TEXT NOT NULL CHECK (hold_type IN ('execution', 'effects', 'delivery')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_by TEXT,
  released_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_operator_active_hold_idx
  ON agent_operator_holds (organization_id, scope_type, scope_id, hold_type)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS agent_operator_holds_lookup_idx
  ON agent_operator_holds (organization_id, status, expires_at DESC);
