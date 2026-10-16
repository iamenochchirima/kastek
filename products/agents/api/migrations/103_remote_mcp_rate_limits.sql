CREATE TABLE IF NOT EXISTS agent_mcp_provider_rate_windows (
  organization_id TEXT NOT NULL,
  provider_id UUID NOT NULL REFERENCES agent_mcp_providers(id) ON DELETE CASCADE,
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, window_started_at)
);

CREATE INDEX IF NOT EXISTS agent_mcp_provider_rate_windows_scope_idx
  ON agent_mcp_provider_rate_windows (organization_id, provider_id, window_started_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_mcp_provider_rate_windows TO kasitek_agents_runtime;

ALTER TABLE agent_mcp_provider_rate_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_mcp_provider_rate_windows FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_mcp_provider_rate_windows_agents_scope ON agent_mcp_provider_rate_windows
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1 FROM agent_mcp_providers provider
        WHERE provider.id = agent_mcp_provider_rate_windows.provider_id
          AND provider.organization_id = agent_mcp_provider_rate_windows.organization_id
      )
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1 FROM agent_mcp_providers provider
        WHERE provider.id = agent_mcp_provider_rate_windows.provider_id
          AND provider.organization_id = agent_mcp_provider_rate_windows.organization_id
      )
    )
  );
