DROP INDEX IF EXISTS messages_provider_identity_idx;

CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_identity_idx
  ON messages (organization_id, provider, provider_message_id)
  WHERE provider IS NOT NULL AND provider_message_id IS NOT NULL;
