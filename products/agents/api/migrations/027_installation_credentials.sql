-- External runtime credentials are separate from model-provider vault entries.
-- The plaintext secret is generated once by the API and never persisted.
CREATE TABLE IF NOT EXISTS agent_installation_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  organization_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 160),
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT
);

CREATE INDEX IF NOT EXISTS agent_installation_credentials_active_idx
  ON agent_installation_credentials (organization_id, installation_id, status);

CREATE TABLE IF NOT EXISTS agent_installation_resource_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  resource_type TEXT NOT NULL CHECK (length(trim(resource_type)) BETWEEN 1 AND 120),
  resource_id TEXT NOT NULL CHECK (length(trim(resource_id)) BETWEEN 1 AND 240),
  granted_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (installation_id, resource_type, resource_id)
);

CREATE TABLE IF NOT EXISTS agent_installation_connector_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  connector_id TEXT NOT NULL CHECK (length(trim(connector_id)) BETWEEN 1 AND 240),
  granted_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (installation_id, connector_id)
);

CREATE TABLE IF NOT EXISTS agent_usage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  credential_id UUID REFERENCES agent_installation_credentials(id),
  usage_type TEXT NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_usage_records_installation_idx
  ON agent_usage_records (organization_id, installation_id, occurred_at DESC);
