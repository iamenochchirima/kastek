ALTER TABLE channel_pairing_tokens
  ALTER COLUMN external_identity DROP NOT NULL;

CREATE INDEX IF NOT EXISTS channel_pairing_tokens_owner_idx
  ON channel_pairing_tokens (organization_id, installation_id, owner_actor_id, expires_at)
  WHERE consumed_at IS NULL;
