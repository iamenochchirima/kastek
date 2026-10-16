-- One internal external-connected installation per Core-owned Developer API key.
-- The API key remains the only user-facing credential; this marker preserves
-- the existing installation capability, approval, and audit pipeline.
CREATE UNIQUE INDEX IF NOT EXISTS agent_installations_developer_api_key_idx
  ON agent_installations (organization_id, ((settings ->> 'developerApiKeyId')))
  WHERE execution_mode = 'external_connected'
    AND settings ->> 'developerApiKeyId' IS NOT NULL;
