-- Dedicated rollout control for automatic publication deployment. The flag
-- defaults to enabled when absent so existing follow-published behavior is
-- unchanged; operators can disable it at global, organization, or
-- installation scope through the existing dual-control command path.
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
    'audio_transcription_enabled'
  ));

COMMENT ON COLUMN agent_operator_feature_flags.flag_key IS
  'Runtime rollout controls. agent_version_deployment_enabled gates automatic follow-published installation movement; existing deployed versions remain runnable when rollout is disabled.';
