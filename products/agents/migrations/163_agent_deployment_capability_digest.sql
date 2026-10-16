-- Keep the redacted, installation-scoped capability configuration identity
-- alongside the candidate and extension evidence for promotion/rollback.
ALTER TABLE agent_installation_deployments
  ADD COLUMN IF NOT EXISTS capability_configuration_digest TEXT;

COMMENT ON COLUMN agent_installation_deployments.capability_configuration_digest IS
  'Digest of the promoted installation-scoped capability configuration; no credential payloads are stored.';

ALTER TABLE agent_installation_deployments
  ADD CONSTRAINT agent_installation_deployments_capability_digest_length
  CHECK (capability_configuration_digest IS NULL OR length(capability_configuration_digest) <= 128);
