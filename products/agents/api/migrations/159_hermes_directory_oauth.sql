-- Reviewed Hermes directory metadata is inert until a user activates an entry.
-- MCP providers keep the reviewed catalogue id so connection state can be projected
-- separately from the directory itself.
ALTER TABLE agent_mcp_providers
  ADD COLUMN IF NOT EXISTS catalog_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS agent_mcp_providers_catalog_scope_idx
  ON agent_mcp_providers (organization_id, catalog_id)
  WHERE catalog_id IS NOT NULL;

ALTER TABLE agent_skill_definitions
  ADD COLUMN IF NOT EXISTS catalog_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS agent_skill_definitions_catalog_scope_idx
  ON agent_skill_definitions (organization_id, catalog_id)
  WHERE catalog_id IS NOT NULL;

-- The existing OAuth state table is shared by native integrations and MCP OAuth.
-- These nullable fields keep the generic browser flow one-use and encrypted without
-- changing the existing Google Calendar state shape.
ALTER TABLE integration_oauth_states
  ADD COLUMN IF NOT EXISTS flow TEXT NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS code_verifier TEXT,
  ADD COLUMN IF NOT EXISTS client_id TEXT,
  ADD COLUMN IF NOT EXISTS encrypted_client_secret TEXT,
  ADD COLUMN IF NOT EXISTS resource TEXT,
  ADD COLUMN IF NOT EXISTS authorization_endpoint TEXT,
  ADD COLUMN IF NOT EXISTS token_endpoint TEXT,
  ADD COLUMN IF NOT EXISTS agent_version_id UUID REFERENCES agent_versions(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'integration_oauth_states_flow_check'
      AND conrelid = 'integration_oauth_states'::regclass
  ) THEN
    ALTER TABLE integration_oauth_states
      ADD CONSTRAINT integration_oauth_states_flow_check
      CHECK (flow IN ('native', 'mcp'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS integration_oauth_states_flow_idx
  ON integration_oauth_states (flow, expires_at);
