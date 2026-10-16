CREATE TABLE agent_website_visitor_sessions (
  id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL,
  deployment_id UUID NOT NULL REFERENCES agent_website_deployments(id),
  origin TEXT NOT NULL,
  secret_hash TEXT NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  conversation_id UUID REFERENCES conversations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 day'
);
ALTER TABLE agent_website_visitor_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_website_visitor_sessions FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON agent_website_visitor_sessions TO kasitek_agents_runtime;
CREATE POLICY agent_website_visitor_sessions_scope ON agent_website_visitor_sessions
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id))
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM agent_website_deployments deployment
      WHERE deployment.id = agent_website_visitor_sessions.deployment_id
        AND deployment.organization_id = agent_website_visitor_sessions.organization_id)
    AND (conversation_id IS NULL OR EXISTS (
      SELECT 1 FROM conversations conversation
      JOIN agent_website_deployments deployment ON deployment.id = agent_website_visitor_sessions.deployment_id
      WHERE conversation.id = agent_website_visitor_sessions.conversation_id
        AND conversation.installation_id = deployment.installation_id
        AND conversation.organization_id = deployment.organization_id
    ))
  );
