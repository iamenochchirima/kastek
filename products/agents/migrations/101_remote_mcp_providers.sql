-- Reviewed remote MCP provider manifests. Secrets stay in the existing
-- organization-scoped integration credential vault; these tables persist only
-- an opaque credential reference and bounded, pinned tool schemas.
CREATE TABLE IF NOT EXISTS agent_mcp_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  owner_type TEXT NOT NULL DEFAULT 'organization' CHECK (owner_type IN ('organization', 'user')),
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  endpoint_url TEXT NOT NULL,
  credential_reference UUID,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'revoked')),
  timeout_ms INTEGER NOT NULL DEFAULT 15000 CHECK (timeout_ms BETWEEN 1000 AND 120000),
  max_response_bytes INTEGER NOT NULL DEFAULT 1048576 CHECK (max_response_bytes BETWEEN 1024 AND 1048576),
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute BETWEEN 1 AND 600),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS agent_mcp_provider_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES agent_mcp_providers(id),
  organization_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'revoked')),
  protocol_version TEXT NOT NULL,
  tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  checksum TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  UNIQUE (provider_id, revision)
);

CREATE TABLE IF NOT EXISTS agent_version_mcp_providers (
  organization_id TEXT NOT NULL,
  agent_version_id UUID NOT NULL REFERENCES agent_versions(id),
  provider_version_id UUID NOT NULL REFERENCES agent_mcp_provider_versions(id),
  pinned_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_version_id, provider_version_id)
);

CREATE INDEX IF NOT EXISTS agent_mcp_providers_scope_idx ON agent_mcp_providers (organization_id, status, name);
CREATE INDEX IF NOT EXISTS agent_mcp_provider_versions_provider_idx ON agent_mcp_provider_versions (provider_id, status, revision DESC);
CREATE INDEX IF NOT EXISTS agent_version_mcp_providers_scope_idx ON agent_version_mcp_providers (organization_id, agent_version_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_mcp_providers, agent_mcp_provider_versions, agent_version_mcp_providers TO kasitek_agents_runtime;

ALTER TABLE agent_mcp_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_mcp_providers FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_mcp_provider_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_mcp_provider_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_version_mcp_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_version_mcp_providers FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_mcp_providers_agents_scope ON agent_mcp_providers
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id))
  WITH CHECK (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id));

CREATE POLICY agent_mcp_provider_versions_agents_scope ON agent_mcp_provider_versions
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR EXISTS (
      SELECT 1 FROM agent_mcp_providers provider
      WHERE provider.id = agent_mcp_provider_versions.provider_id
        AND provider.organization_id = agent_mcp_provider_versions.organization_id
        AND kasitek_agents_current_org_scope(provider.organization_id)
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR EXISTS (
      SELECT 1 FROM agent_mcp_providers provider
      WHERE provider.id = agent_mcp_provider_versions.provider_id
        AND provider.organization_id = agent_mcp_provider_versions.organization_id
        AND kasitek_agents_current_org_scope(provider.organization_id)
    )
  );

CREATE POLICY agent_version_mcp_providers_agents_scope ON agent_version_mcp_providers
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1 FROM agent_versions version
        JOIN agent_definitions definition ON definition.id = version.agent_definition_id
        WHERE version.id = agent_version_mcp_providers.agent_version_id
          AND definition.organization_id = agent_version_mcp_providers.organization_id
      )
      AND EXISTS (
        SELECT 1 FROM agent_mcp_provider_versions provider_version
        JOIN agent_mcp_providers provider ON provider.id = provider_version.provider_id
        WHERE provider_version.id = agent_version_mcp_providers.provider_version_id
          AND provider.organization_id = agent_version_mcp_providers.organization_id
          AND provider.status = 'approved'
          AND provider_version.status = 'published'
      )
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1 FROM agent_versions version
        JOIN agent_definitions definition ON definition.id = version.agent_definition_id
        WHERE version.id = agent_version_mcp_providers.agent_version_id
          AND definition.organization_id = agent_version_mcp_providers.organization_id
      )
      AND EXISTS (
        SELECT 1 FROM agent_mcp_provider_versions provider_version
        JOIN agent_mcp_providers provider ON provider.id = provider_version.provider_id
        WHERE provider_version.id = agent_version_mcp_providers.provider_version_id
          AND provider.organization_id = agent_version_mcp_providers.organization_id
          AND provider.status = 'approved'
          AND provider_version.status = 'published'
      )
    )
  );
