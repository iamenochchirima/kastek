CREATE TABLE IF NOT EXISTS channel_pairing_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  connection_id UUID NOT NULL REFERENCES channel_connections(id),
  token_hash TEXT NOT NULL UNIQUE,
  external_identity TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS channel_pairing_tokens_lookup_idx
  ON channel_pairing_tokens (organization_id, installation_id, expires_at)
  WHERE consumed_at IS NULL;
