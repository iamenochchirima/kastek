ALTER TABLE agent_installation_credentials
  ADD COLUMN IF NOT EXISTS api_scopes JSONB NOT NULL DEFAULT '["api:read"]'::jsonb;

ALTER TABLE agent_installation_credentials
  ADD CONSTRAINT agent_installation_credentials_api_scopes_valid
  CHECK (
    jsonb_typeof(api_scopes) = 'array'
    AND jsonb_array_length(api_scopes) > 0
    AND api_scopes <@ '["api:read", "api:write"]'::jsonb
  );
