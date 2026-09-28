-- Complete the v2 evidence boundary for all journal-admitted events. The
-- original table was introduced for compaction checkpoints; these columns
-- make the same table the source of truth for inbound, assistant, tool,
-- approval, channel, and memory-command events without creating a transcript
-- copy.

ALTER TABLE memory_source_events
  ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'memory.checkpoint',
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS event_sequence BIGINT,
  ADD COLUMN IF NOT EXISTS channel TEXT,
  ADD COLUMN IF NOT EXISTS extraction_version TEXT NOT NULL DEFAULT 'capture-v2';

ALTER TABLE memory_source_events
  DROP CONSTRAINT IF EXISTS memory_source_events_event_type_check;
ALTER TABLE memory_source_events
  ADD CONSTRAINT memory_source_events_event_type_check
  CHECK (length(trim(event_type)) BETWEEN 1 AND 160);

ALTER TABLE memory_source_events
  DROP CONSTRAINT IF EXISTS memory_source_events_idempotency_key_check;
ALTER TABLE memory_source_events
  ADD CONSTRAINT memory_source_events_idempotency_key_check
  CHECK (idempotency_key IS NULL OR length(trim(idempotency_key)) BETWEEN 1 AND 240);

CREATE UNIQUE INDEX IF NOT EXISTS memory_source_events_idempotency_idx
  ON memory_source_events (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS memory_source_events_cursor_idx
  ON memory_source_events (organization_id, run_id, event_sequence, occurred_at, id);

COMMENT ON COLUMN memory_source_events.evidence IS
  'Redacted evidence envelope. Tool/effect payloads are referenced by receipt ID and are not copied into summaries.';
