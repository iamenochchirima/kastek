ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS run_id UUID REFERENCES agent_runs(id);

CREATE UNIQUE INDEX IF NOT EXISTS messages_run_direction_idx
  ON messages (run_id, direction)
  WHERE run_id IS NOT NULL AND direction IN ('inbound', 'outbound');

CREATE INDEX IF NOT EXISTS messages_conversation_run_idx
  ON messages (conversation_id, run_id, sequence_number);
