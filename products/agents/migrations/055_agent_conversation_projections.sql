-- Installation-local conversation projections.
-- These records are intentionally independent from kasitek-core /inbox.  The
-- Agent Platform owns the transcript for each hosted installation; a later
-- integration can add a reference to a core conversation without changing
-- this ownership model.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS conversation_kind TEXT NOT NULL DEFAULT 'personal',
  ADD COLUMN IF NOT EXISTS assigned_actor_id TEXT,
  ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_message_direction TEXT,
  ADD COLUMN IF NOT EXISTS last_message_preview TEXT,
  ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_kind_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_kind_check
  CHECK (conversation_kind IN ('personal', 'customer', 'test', 'external'));

-- Preserve existing personal KasiAi chats. Hosted platform-only chats are
-- internal tests; hosted channel transcripts become customer conversations.
UPDATE conversations c
SET conversation_kind = CASE
      WHEN ai.execution_mode = 'system_hosted' THEN 'personal'
      WHEN EXISTS (
        SELECT 1
        FROM messages m
        WHERE m.conversation_id = c.id
          AND m.source_channel IS NOT NULL
          AND m.source_channel <> 'platform'
      ) THEN 'customer'
      ELSE 'test'
    END
FROM agent_installations ai
WHERE ai.id = c.installation_id;

WITH latest AS (
  SELECT DISTINCT ON (m.conversation_id)
    m.conversation_id,
    COALESCE(m.occurred_at, m.created_at) AS last_message_at,
    m.direction AS last_message_direction,
    LEFT(COALESCE(m.content->>'text', m.message_type), 500) AS last_message_preview
  FROM messages m
  ORDER BY m.conversation_id, m.sequence_number DESC
), counts AS (
  SELECT conversation_id, COUNT(*)::integer AS message_count
  FROM messages
  GROUP BY conversation_id
)
UPDATE conversations c
SET last_message_at = latest.last_message_at,
    last_message_direction = latest.last_message_direction,
    last_message_preview = latest.last_message_preview,
    message_count = counts.message_count
FROM latest
JOIN counts ON counts.conversation_id = latest.conversation_id
WHERE c.id = latest.conversation_id;

CREATE INDEX IF NOT EXISTS conversations_installation_kind_idx
  ON conversations (organization_id, installation_id, conversation_kind, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS conversations_customer_thread_idx
  ON conversations (organization_id, installation_id, channel_type, channel_key, external_conversation_id)
  WHERE conversation_kind = 'customer' AND status <> 'deleted';

CREATE INDEX IF NOT EXISTS conversations_assignment_idx
  ON conversations (organization_id, installation_id, assigned_actor_id, updated_at DESC)
  WHERE assigned_actor_id IS NOT NULL AND status <> 'deleted';
