-- Website deployments own live installations, separate from private Playground.
CREATE TABLE agent_website_deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  source_installation_id UUID NOT NULL REFERENCES agent_installations(id),
  installation_id UUID NOT NULL UNIQUE REFERENCES agent_installations(id),
  channel_connection_id UUID NOT NULL REFERENCES channel_connections(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'REVOKED')),
  allowed_origins JSONB NOT NULL CHECK (jsonb_typeof(allowed_origins) = 'array'),
  configuration JSONB NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_website_deployments_source_idx
  ON agent_website_deployments (organization_id, source_installation_id);
ALTER TABLE agent_website_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_website_deployments FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON agent_website_deployments TO kasitek_agents_runtime;
CREATE POLICY agent_website_deployments_scope ON agent_website_deployments
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id))
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_installations live
      JOIN agent_installations source ON source.id = agent_website_deployments.source_installation_id
      JOIN agent_definitions definition ON definition.id = live.agent_definition_id
      JOIN channel_connections channel ON channel.id = agent_website_deployments.channel_connection_id
      WHERE live.id = agent_website_deployments.installation_id
        AND live.organization_id = agent_website_deployments.organization_id
        AND source.organization_id = live.organization_id
        AND source.agent_definition_id = live.agent_definition_id
        AND live.execution_mode = 'kasitek_hosted'
        AND definition.protected = false AND definition.agent_audience = 'customer_service'
        AND channel.installation_id = live.id AND channel.organization_id = live.organization_id
        AND channel.channel_type = 'website'
    )
  );
