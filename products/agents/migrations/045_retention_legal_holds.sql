CREATE TABLE IF NOT EXISTS agent_retention_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL UNIQUE CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  memory_days INTEGER NOT NULL DEFAULT 365 CHECK (memory_days BETWEEN 1 AND 3650),
  conversation_days INTEGER NOT NULL DEFAULT 365 CHECK (conversation_days BETWEEN 1 AND 3650),
  event_days INTEGER NOT NULL DEFAULT 365 CHECK (event_days BETWEEN 1 AND 3650),
  audit_days INTEGER NOT NULL DEFAULT 2555 CHECK (audit_days BETWEEN 30 AND 3650),
  attachment_days INTEGER NOT NULL DEFAULT 30 CHECK (attachment_days BETWEEN 1 AND 3650),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by TEXT NOT NULL CHECK (length(trim(updated_by)) BETWEEN 1 AND 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_legal_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('organization', 'installation', 'conversation')),
  scope_id TEXT NOT NULL CHECK (length(trim(scope_id)) BETWEEN 1 AND 240),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 8 AND 500),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  expires_at TIMESTAMPTZ,
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_by TEXT,
  released_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
);

CREATE INDEX IF NOT EXISTS agent_legal_holds_scope_idx
  ON agent_legal_holds (organization_id, scope_type, scope_id, status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS agent_legal_holds_active_scope_idx
  ON agent_legal_holds (organization_id, scope_type, scope_id)
  WHERE status = 'active';

ALTER TABLE agent_operator_commands
  DROP CONSTRAINT IF EXISTS agent_operator_commands_command_type_check;

ALTER TABLE agent_operator_commands
  ADD CONSTRAINT agent_operator_commands_command_type_check
  CHECK (command_type IN (
    'cancel_run', 'retry_run', 'replay_delivery', 'delete_memory', 'assign_run',
    'reconcile_effect', 'request_export', 'set_feature_flag', 'clear_feature_flag',
    'create_hold', 'release_hold', 'set_retention_policy', 'apply_retention_policy',
    'create_legal_hold', 'release_legal_hold', 'kill_switch_enable', 'kill_switch_disable',
    'suspend_installation', 'resume_installation', 'revoke_credential', 'pause_schedule',
    'resume_schedule'
  ));
