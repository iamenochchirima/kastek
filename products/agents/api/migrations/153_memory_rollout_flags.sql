-- Scoped memory v2 rollout controls.
-- These flags default to enabled when absent so existing deployments preserve
-- behaviour, while operators can stage or pause each memory path at global,
-- organization, or installation scope through the dual-control command path.
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
    'dynamic_ui_enabled',
    'memory_v2_retrieval_enabled',
    'memory_v2_writes_enabled',
    'memory_consolidation_enabled'
  ));

COMMENT ON COLUMN agent_operator_feature_flags.flag_key IS
  'Runtime rollout controls, including independently staged memory v2 retrieval, writes, and consolidation paths.';
