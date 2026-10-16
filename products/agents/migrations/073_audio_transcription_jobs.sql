-- Durable audio transcription state. Audio bytes remain owned by Core; this table stores only
-- the opaque Core asset id and the normalized dispatch request needed after transcription.
CREATE TABLE IF NOT EXISTS audio_transcription_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  correlation_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  dispatch_kind TEXT NOT NULL CHECK (dispatch_kind IN ('platform', 'external')),
  dispatch_input JSONB NOT NULL CHECK (jsonb_typeof(dispatch_input) = 'object'),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'dispatching', 'completed', 'retryable_failed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  transcript TEXT,
  language_code TEXT,
  result_conversation_id UUID,
  result_message_id UUID,
  result_run_id UUID,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  CHECK ((status IN ('processing', 'dispatching')) = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CHECK (transcript IS NULL OR length(transcript) BETWEEN 1 AND 200000),
  CHECK (language_code IS NULL OR length(language_code) BETWEEN 1 AND 32),
  CHECK ((status = 'completed') = (result_run_id IS NOT NULL)),
  CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 120),
  CHECK (error_message IS NULL OR length(error_message) BETWEEN 1 AND 2_000)
);

CREATE INDEX IF NOT EXISTS audio_transcription_jobs_claim_idx
  ON audio_transcription_jobs (status, next_attempt_at, created_at)
  WHERE status IN ('queued', 'retryable_failed', 'dispatching');

CREATE INDEX IF NOT EXISTS audio_transcription_jobs_scope_idx
  ON audio_transcription_jobs (organization_id, installation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audio_transcription_jobs_asset_idx
  ON audio_transcription_jobs (organization_id, asset_id);

CREATE OR REPLACE FUNCTION audio_transcription_jobs_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audio_transcription_jobs_updated_at_trigger ON audio_transcription_jobs;
CREATE TRIGGER audio_transcription_jobs_updated_at_trigger
BEFORE UPDATE ON audio_transcription_jobs
FOR EACH ROW EXECUTE FUNCTION audio_transcription_jobs_set_updated_at();

COMMENT ON TABLE audio_transcription_jobs IS
  'Durable Core-asset-backed audio transcription jobs; dispatch_input never contains raw audio bytes.';
