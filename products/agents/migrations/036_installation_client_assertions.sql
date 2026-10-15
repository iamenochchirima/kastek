-- Bind an installation credential to a caller-owned P-256 key so external agents
-- can exchange short-lived tokens without transmitting the copy-once secret.
ALTER TABLE agent_installation_credentials
  ADD COLUMN IF NOT EXISTS client_key_id TEXT,
  ADD COLUMN IF NOT EXISTS client_public_key TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_installation_credentials_client_key_pair_check'
  ) THEN
    ALTER TABLE agent_installation_credentials
      ADD CONSTRAINT agent_installation_credentials_client_key_pair_check
      CHECK ((client_key_id IS NULL) = (client_public_key IS NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS agent_installation_credentials_active_client_key_idx
  ON agent_installation_credentials (installation_id, client_key_id)
  WHERE status = 'active' AND client_key_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_client_assertion_replays (
  credential_id UUID NOT NULL REFERENCES agent_installation_credentials(id) ON DELETE CASCADE,
  jti TEXT NOT NULL CHECK (length(trim(jti)) BETWEEN 1 AND 200),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (credential_id, jti)
);

CREATE INDEX IF NOT EXISTS agent_client_assertion_replays_expiry_idx
  ON agent_client_assertion_replays (expires_at);
