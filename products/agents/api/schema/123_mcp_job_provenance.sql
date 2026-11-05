ALTER TABLE agents_platform.website_crawls ADD COLUMN mcp_connection_id uuid REFERENCES agents_platform.mcp_oauth_connections(id);
ALTER TABLE agents_platform.ingestion_jobs ADD COLUMN mcp_connection_id uuid REFERENCES agents_platform.mcp_oauth_connections(id);
