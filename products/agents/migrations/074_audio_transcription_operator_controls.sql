ALTER TABLE agent_operator_commands
  DROP CONSTRAINT IF EXISTS agent_operator_commands_command_type_check;

ALTER TABLE agent_operator_commands
  ADD CONSTRAINT agent_operator_commands_command_type_check
  CHECK (command_type IN (
    'cancel_run', 'retry_run', 'retry_audio_transcription', 'replay_delivery',
    'delete_memory', 'assign_run', 'reconcile_effect', 'request_export',
    'set_feature_flag', 'clear_feature_flag', 'create_hold', 'release_hold',
    'set_retention_policy', 'apply_retention_policy', 'create_legal_hold',
    'release_legal_hold', 'kill_switch_enable', 'kill_switch_disable',
    'suspend_installation', 'resume_installation', 'revoke_credential',
    'pause_schedule', 'resume_schedule'
  ));

ALTER TABLE agent_operator_feature_flags
  DROP CONSTRAINT IF EXISTS agent_operator_feature_flags_flag_key_check;

ALTER TABLE agent_operator_feature_flags
  ADD CONSTRAINT agent_operator_feature_flags_flag_key_check
  CHECK (flag_key IN (
    'agent_execution_enabled', 'effect_execution_enabled', 'mcp_enabled',
    'rest_enabled', 'customer_handoff_enabled', 'audio_transcription_enabled'
  ));
