-- Make the audio job migration safe to resume after a partially applied 073 migration,
-- then add the terminal deletion state used by Core-backed retention cleanup.
ALTER TABLE audio_transcription_jobs
  ADD COLUMN IF NOT EXISTS result_conversation_id UUID,
  ADD COLUMN IF NOT EXISTS result_message_id UUID,
  ADD COLUMN IF NOT EXISTS result_run_id UUID,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE audio_transcription_jobs
  DROP CONSTRAINT IF EXISTS audio_transcription_jobs_status_check;

ALTER TABLE audio_transcription_jobs
  ADD CONSTRAINT audio_transcription_jobs_status_check
  CHECK (status IN ('queued', 'processing', 'dispatching', 'completed', 'retryable_failed', 'failed', 'deleted'));

ALTER TABLE audio_transcription_jobs
  DROP CONSTRAINT IF EXISTS audio_transcription_jobs_deleted_at_check;

ALTER TABLE audio_transcription_jobs
  ADD CONSTRAINT audio_transcription_jobs_deleted_at_check
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL));

CREATE INDEX IF NOT EXISTS audio_transcription_jobs_retention_idx
  ON audio_transcription_jobs (organization_id, created_at)
  WHERE status IN ('completed', 'retryable_failed', 'failed');

ALTER TABLE agent_operator_commands
  DROP CONSTRAINT IF EXISTS agent_operator_commands_command_type_check;

ALTER TABLE agent_operator_commands
  ADD CONSTRAINT agent_operator_commands_command_type_check
  CHECK (command_type IN (
    'cancel_run', 'retry_run', 'retry_audio_transcription', 'delete_audio_transcription', 'replay_delivery',
    'delete_memory', 'assign_run', 'reconcile_effect', 'request_export',
    'set_feature_flag', 'clear_feature_flag', 'create_hold', 'release_hold',
    'set_retention_policy', 'apply_retention_policy', 'create_legal_hold',
    'release_legal_hold', 'kill_switch_enable', 'kill_switch_disable',
    'suspend_installation', 'resume_installation', 'revoke_credential',
    'pause_schedule', 'resume_schedule'
  ));
