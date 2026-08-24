-- Generic installation-scoped integrations. Provider-specific adapters stay in
-- the agent runtime; this schema only stores connection state and encrypted
-- credentials so new integrations do not require new tables.
CREATE TABLE IF NOT EXISTS integration_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  integration_id TEXT NOT NULL CHECK (length(trim(integration_id)) BETWEEN 1 AND 120),
  label TEXT NOT NULL DEFAULT 'integration credential' CHECK (length(trim(label)) BETWEEN 1 AND 160),
  encrypted_payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS integration_credentials_scope_idx
  ON integration_credentials (organization_id, integration_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS integration_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL CHECK (length(trim(integration_id)) BETWEEN 1 AND 120),
  credential_id UUID REFERENCES integration_credentials(id),
  status TEXT NOT NULL DEFAULT 'not_configured'
    CHECK (status IN ('not_configured', 'connected', 'unhealthy', 'requires_connector', 'revoked')),
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  health_message TEXT,
  last_checked_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (installation_id, integration_id)
);

CREATE INDEX IF NOT EXISTS integration_connections_scope_idx
  ON integration_connections (organization_id, installation_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS integration_oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL CHECK (length(trim(integration_id)) BETWEEN 1 AND 120),
  state_hash TEXT NOT NULL UNIQUE,
  redirect_uri TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS integration_oauth_states_expiry_idx
  ON integration_oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS internal_calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 240),
  description TEXT NOT NULL DEFAULT '',
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  location TEXT NOT NULL DEFAULT '',
  attendees JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  idempotency_key TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  UNIQUE (installation_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS internal_calendar_events_window_idx
  ON internal_calendar_events (organization_id, installation_id, status, start_at);
