-- Archived conversations stay readable and restorable; deletion remains a one-way retention event.
ALTER TABLE agents_platform.conversations ADD COLUMN archived_at timestamptz;
CREATE INDEX conversations_archive ON agents_platform.conversations (organization_id, agent_id, archived_at)
  WHERE archived_at IS NOT NULL;
