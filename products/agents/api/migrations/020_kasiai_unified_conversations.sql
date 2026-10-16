ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS owner_actor_id TEXT,
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rotated_from_id UUID REFERENCES conversations(id);

UPDATE conversations c
SET owner_actor_id = p.external_id
FROM participants p
WHERE c.owner_actor_id IS NULL
  AND p.conversation_id = c.id
  AND p.organization_id = c.organization_id
  AND p.participant_type = 'user'
  AND p.external_id IS NOT NULL;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY installation_id, owner_actor_id
           ORDER BY updated_at DESC, created_at DESC, id DESC
         ) AS owner_rank
  FROM conversations
  WHERE owner_actor_id IS NOT NULL AND status = 'active'
)
UPDATE conversations c
SET is_primary = ranked.owner_rank = 1
FROM ranked
WHERE c.id = ranked.id;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_current_owner_idx
  ON conversations (installation_id, owner_actor_id)
  WHERE is_primary = TRUE AND status = 'active' AND owner_actor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS conversations_owner_history_idx
  ON conversations (organization_id, installation_id, owner_actor_id, updated_at DESC)
  WHERE owner_actor_id IS NOT NULL;

ALTER TABLE channel_bindings
  ADD COLUMN IF NOT EXISTS owner_actor_id TEXT;

ALTER TABLE channel_pairing_tokens
  ADD COLUMN IF NOT EXISTS owner_actor_id TEXT;

UPDATE channel_pairing_tokens SET owner_actor_id = created_by
WHERE owner_actor_id IS NULL;

CREATE INDEX IF NOT EXISTS channel_bindings_owner_idx
  ON channel_bindings (organization_id, installation_id, owner_actor_id, status)
  WHERE owner_actor_id IS NOT NULL;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS source_channel TEXT,
  ADD COLUMN IF NOT EXISTS source_connection_id UUID REFERENCES channel_connections(id),
  ADD COLUMN IF NOT EXISTS source_binding_id UUID REFERENCES channel_bindings(id),
  ADD COLUMN IF NOT EXISTS external_conversation_id TEXT,
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_status TEXT;

UPDATE messages
SET source_channel = CASE
      WHEN provider IN ('platform', 'kasitek-platform') THEN 'platform'
      WHEN provider IS NOT NULL THEN provider
      ELSE 'platform'
    END,
    occurred_at = COALESCE(occurred_at, created_at)
WHERE source_channel IS NULL OR occurred_at IS NULL;

ALTER TABLE messages
  ALTER COLUMN source_channel SET DEFAULT 'platform',
  ALTER COLUMN source_channel SET NOT NULL,
  ALTER COLUMN occurred_at SET DEFAULT now(),
  ALTER COLUMN occurred_at SET NOT NULL;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_delivery_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_delivery_status_check
  CHECK (delivery_status IS NULL OR delivery_status IN (
    'local', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'unknown'
  ));

CREATE INDEX IF NOT EXISTS messages_unified_timeline_idx
  ON messages (organization_id, conversation_id, source_channel, sequence_number);

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS reply_channel_type TEXT,
  ADD COLUMN IF NOT EXISTS reply_binding_id UUID REFERENCES channel_bindings(id);

CREATE INDEX IF NOT EXISTS agent_runs_conversation_open_idx
  ON agent_runs (conversation_id, created_at)
  WHERE status IN (
    'received', 'queued', 'running', 'awaiting_approval', 'awaiting_human',
    'awaiting_external_event'
  );
