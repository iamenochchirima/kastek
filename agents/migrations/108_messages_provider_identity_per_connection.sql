DROP INDEX IF EXISTS messages_provider_identity_idx;

CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_connection_identity_idx
  ON messages (organization_id, provider, source_connection_id, provider_message_id)
  WHERE provider IS NOT NULL
    AND source_connection_id IS NOT NULL
    AND provider_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_without_connection_identity_idx
  ON messages (organization_id, provider, provider_message_id)
  WHERE provider IS NOT NULL
    AND source_connection_id IS NULL
    AND provider_message_id IS NOT NULL;
