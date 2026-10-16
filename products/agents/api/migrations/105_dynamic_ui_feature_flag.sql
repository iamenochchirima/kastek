-- Rich dynamic UI attachment defaults to enabled when no override exists.
-- Operators can disable it at global, organization, or installation scope
-- using the existing feature-flag command path.
ALTER TABLE agent_operator_feature_flags
  DROP CONSTRAINT IF EXISTS agent_operator_feature_flags_flag_key_check;

ALTER TABLE agent_operator_feature_flags
  ADD CONSTRAINT agent_operator_feature_flags_flag_key_check
  CHECK (flag_key IN (
    'agent_execution_enabled',
    'agent_version_deployment_enabled',
    'effect_execution_enabled',
    'mcp_enabled',
    'rest_enabled',
    'customer_handoff_enabled',
    'audio_transcription_enabled',
    'dynamic_ui_enabled'
  ));

COMMENT ON COLUMN agent_operator_feature_flags.flag_key IS
  'Runtime rollout controls. dynamic_ui_enabled gates server-owned rich UI attachment while preserving text and media responses.';
