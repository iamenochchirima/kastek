ALTER TABLE agent_operator_commands DROP CONSTRAINT IF EXISTS agent_operator_commands_command_type_check;
ALTER TABLE agent_operator_commands ADD CONSTRAINT agent_operator_commands_command_type_check
  CHECK (command_type IN (
    'cancel_run', 'reconcile_effect', 'kill_switch_enable', 'kill_switch_disable',
    'retry_run', 'retry_audio_transcription', 'delete_audio_transcription',
    'replay_delivery', 'delete_memory', 'review_memory', 'assign_run',
    'reconcile_budget', 'request_export', 'set_feature_flag', 'clear_feature_flag',
    'create_hold', 'release_hold', 'set_retention_policy', 'apply_retention_policy',
    'create_legal_hold', 'release_legal_hold', 'suspend_installation',
    'resume_installation', 'revoke_credential', 'pause_schedule', 'resume_schedule'
  ));
