CREATE TABLE agents_platform.mcp_references (
 id uuid PRIMARY KEY,
 connection_id uuid NOT NULL REFERENCES agents_platform.mcp_oauth_connections(id),
 organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
 target text NOT NULL,
 expires_at timestamptz NOT NULL,
 UNIQUE(connection_id,organization_id,target)
);
CREATE INDEX mcp_references_expiry ON agents_platform.mcp_references(expires_at);
