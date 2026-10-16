CREATE TABLE IF NOT EXISTS channel_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  channel_type TEXT NOT NULL,
  channel_key TEXT NOT NULL,
  credential_reference TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked', 'failed')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, channel_type, channel_key)
);

CREATE TABLE IF NOT EXISTS channel_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  channel_connection_id UUID NOT NULL REFERENCES channel_connections(id),
  channel_type TEXT NOT NULL,
  external_identity TEXT NOT NULL,
  routing_key TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, channel_type, external_identity)
);

CREATE INDEX IF NOT EXISTS channel_bindings_installation_idx
  ON channel_bindings (organization_id, installation_id, status);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  message_id UUID NOT NULL REFERENCES messages(id),
  channel_type TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'unknown')),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  UNIQUE (message_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS delivery_attempts_scope_idx
  ON delivery_attempts (organization_id, conversation_id, status, created_at DESC);
