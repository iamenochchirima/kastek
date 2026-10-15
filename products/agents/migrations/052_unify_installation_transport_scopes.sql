-- Transport credentials no longer narrow read/write access independently.
-- Effective access remains constrained by installation grants, resource and
-- connector scopes, availability, feature policy, and approvals.
ALTER TABLE agent_installation_credentials
  ALTER COLUMN mcp_scopes SET DEFAULT '["mcp:read", "mcp:write"]'::jsonb,
  ALTER COLUMN api_scopes SET DEFAULT '["api:read", "api:write"]'::jsonb;

UPDATE agent_installation_credentials
SET mcp_scopes = '["mcp:read", "mcp:write"]'::jsonb,
    api_scopes = '["api:read", "api:write"]'::jsonb
WHERE status = 'active';
