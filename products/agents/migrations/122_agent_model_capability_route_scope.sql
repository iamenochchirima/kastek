-- Route and environment isolation was part of the capability identity from
-- the first durable cache contract. This migration upgrades databases that
-- already ran migration 121 before those key columns were added.

ALTER TABLE agent_model_capabilities
  ADD COLUMN IF NOT EXISTS credential_route_id TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS runtime_environment TEXT NOT NULL DEFAULT 'development';

ALTER TABLE agent_model_capabilities
  DROP CONSTRAINT IF EXISTS agent_model_capabilities_pkey;

ALTER TABLE agent_model_capabilities
  ADD CONSTRAINT agent_model_capabilities_pkey
  PRIMARY KEY (organization_id, provider, model, endpoint_id, credential_route_id, runtime_environment);
