ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS spec_version TEXT NOT NULL DEFAULT '1.0';
ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'kasitek://agents';
ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS data_content_type TEXT NOT NULL DEFAULT 'application/json';

CREATE INDEX IF NOT EXISTS agent_events_subject_idx ON agent_events (subject, sequence_number);
