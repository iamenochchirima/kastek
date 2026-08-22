CREATE TABLE IF NOT EXISTS channel_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('telegram', 'discord')),
  label TEXT NOT NULL DEFAULT 'Telegram bot credential',
  encrypted_payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS channel_credentials_scope_idx
  ON channel_credentials (organization_id, provider, status, created_at DESC);

ALTER TABLE channel_connections
  ADD COLUMN IF NOT EXISTS webhook_secret_hash TEXT,
  ADD COLUMN IF NOT EXISTS webhook_url TEXT;
