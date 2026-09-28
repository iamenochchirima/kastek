-- Preserve the installation-scoped capability state that was active before a
-- deployment. Rollback uses this redacted snapshot to restore Playground /
-- Live parity without copying encrypted credential payloads.
ALTER TABLE agent_installation_deployments
  ADD COLUMN IF NOT EXISTS previous_capability_configuration_snapshot JSONB;

COMMENT ON COLUMN agent_installation_deployments.previous_capability_configuration_snapshot IS
  'Redacted installation capability state before this deployment; opaque credential references only, never encrypted secrets.';
