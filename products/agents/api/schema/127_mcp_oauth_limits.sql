ALTER TABLE agents_platform.mcp_oauth_clients ADD COLUMN metadata_refreshed_at timestamptz;
CREATE INDEX mcp_oauth_clients_metadata_refreshed ON agents_platform.mcp_oauth_clients(metadata_refreshed_at);

CREATE TABLE agents_platform.mcp_oauth_authorize_limits (
 bucket_key text PRIMARY KEY,
 window_started_at timestamptz NOT NULL,
 request_count bigint NOT NULL CHECK (request_count > 0)
);
CREATE INDEX mcp_oauth_authorize_limits_window ON agents_platform.mcp_oauth_authorize_limits(window_started_at);
CREATE INDEX mcp_oauth_requests_expiry ON agents_platform.mcp_oauth_requests(expires_at);
CREATE INDEX mcp_oauth_codes_expiry ON agents_platform.mcp_oauth_codes(expires_at);
CREATE INDEX mcp_oauth_refresh_expiry ON agents_platform.mcp_oauth_refresh(expires_at);
