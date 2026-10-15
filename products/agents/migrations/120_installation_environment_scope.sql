-- A workspace may have one installation per agent and execution environment.
-- This keeps the live/platform installation separate from the real Playground
-- installation while preserving idempotent provisioning inside each environment.
DROP INDEX IF EXISTS agent_installations_definition_scope_unique_idx;

CREATE UNIQUE INDEX IF NOT EXISTS agent_installations_definition_scope_environment_unique_idx
  ON agent_installations (
    organization_id,
    agent_definition_id,
    scope_type,
    scope_id,
    (COALESCE(settings ->> 'environment', 'live'))
  );

COMMENT ON INDEX agent_installations_definition_scope_environment_unique_idx IS
  'Makes organization and system-owned agent installation provisioning idempotent per scope and execution environment.';
