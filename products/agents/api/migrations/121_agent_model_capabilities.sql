-- Tenant-scoped model capacity evidence. This cache is advisory, but it is
-- durable so a worker replacement cannot silently forget a provider correction.

CREATE TABLE IF NOT EXISTS agent_model_capabilities (
  organization_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  credential_route_id TEXT NOT NULL DEFAULT 'default',
  runtime_environment TEXT NOT NULL DEFAULT 'development',
  context_window_tokens INTEGER CHECK (context_window_tokens IS NULL OR context_window_tokens > 0),
  max_output_tokens INTEGER CHECK (max_output_tokens IS NULL OR max_output_tokens > 0),
  source TEXT NOT NULL CHECK (source IN ('provider_metadata', 'catalog', 'configured_override', 'provider_error_correction', 'unknown')),
  resolved_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, provider, model, endpoint_id, credential_route_id, runtime_environment)
);

CREATE INDEX IF NOT EXISTS agent_model_capabilities_expiry_idx
  ON agent_model_capabilities (organization_id, expires_at);

GRANT SELECT, INSERT, UPDATE ON agent_model_capabilities TO kasitek_agents_runtime;

ALTER TABLE agent_model_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_model_capabilities FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_model_capabilities_agents_scope ON agent_model_capabilities;
CREATE POLICY agent_model_capabilities_agents_scope ON agent_model_capabilities
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id))
  WITH CHECK (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id));
