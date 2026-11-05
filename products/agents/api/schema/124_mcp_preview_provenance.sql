CREATE TABLE agents_platform.mcp_preview_provenance (
 task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id),
 connection_id uuid NOT NULL REFERENCES agents_platform.mcp_oauth_connections(id),
 account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
 organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id)
);
