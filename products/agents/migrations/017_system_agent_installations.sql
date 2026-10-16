CREATE UNIQUE INDEX IF NOT EXISTS agent_installations_definition_scope_unique_idx
  ON agent_installations (organization_id, agent_definition_id, scope_type, scope_id);

COMMENT ON INDEX agent_installations_definition_scope_unique_idx IS
  'Makes organization and system-owned agent installation provisioning idempotent per scope.';
