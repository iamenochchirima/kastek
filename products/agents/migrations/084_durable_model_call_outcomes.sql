ALTER TABLE model_calls
  ADD COLUMN IF NOT EXISTS operation_key TEXT,
  ADD COLUMN IF NOT EXISTS response JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS model_calls_operation_key_uidx
  ON model_calls (operation_key)
  WHERE operation_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS model_calls_unknown_operation_idx
  ON model_calls (organization_id, created_at)
  WHERE operation_key IS NOT NULL AND status = 'started';
