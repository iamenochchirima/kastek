ALTER TABLE agents_platform.mcp_oauth_codes ADD COLUMN agent_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE agents_platform.mcp_oauth_connections ADD COLUMN agent_ids uuid[] NOT NULL DEFAULT '{}';
