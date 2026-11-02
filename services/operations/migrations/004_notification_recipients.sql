ALTER TABLE ops_outbox ADD COLUMN IF NOT EXISTS recipient_outcomes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(recipient_outcomes)='object');
