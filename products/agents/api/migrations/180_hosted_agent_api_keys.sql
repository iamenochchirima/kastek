-- Hosted invocation keys do not authenticate external runtimes or model providers.
CREATE TABLE hosted_agent_api_keys (
  id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  label TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 160),
  secret_hash TEXT NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  created_by UUID NOT NULL REFERENCES platform_accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT
);
CREATE INDEX hosted_agent_api_keys_installation_idx
  ON hosted_agent_api_keys (organization_id, installation_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON hosted_agent_api_keys TO kasitek_agents_runtime;
ALTER TABLE hosted_agent_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_agent_api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY hosted_agent_api_keys_scope ON hosted_agent_api_keys
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id)
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      JOIN agent_definitions definition ON definition.id = installation.agent_definition_id
      WHERE installation.id = hosted_agent_api_keys.installation_id
        AND installation.organization_id = hosted_agent_api_keys.organization_id
        AND installation.execution_mode = 'kasitek_hosted'
        AND definition.protected = false
    )
  );
