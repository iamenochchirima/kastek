-- Credentials may be independently narrowed for remote MCP use. Existing credentials retain
-- read-only discovery until an administrator deliberately creates/replaces them with write access.
ALTER TABLE agent_installation_credentials
  ADD COLUMN IF NOT EXISTS mcp_scopes JSONB NOT NULL DEFAULT '["mcp:read"]'::jsonb;

ALTER TABLE agent_installation_credentials
  ADD CONSTRAINT agent_installation_credentials_mcp_scopes_valid
  CHECK (
    jsonb_typeof(mcp_scopes) = 'array'
    AND jsonb_array_length(mcp_scopes) > 0
    AND mcp_scopes <@ '["mcp:read", "mcp:write"]'::jsonb
  );
