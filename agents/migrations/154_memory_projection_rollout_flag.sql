-- Projection is independently pausable during a staged memory rollout.
-- Canonical revisions remain authoritative while projection work stays queued.
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
    'memory_consolidation_enabled',
    'memory_projection_enabled'
  ));

COMMENT ON COLUMN agent_operator_feature_flags.flag_key IS
  'Runtime rollout controls, including independently staged memory v2 retrieval, writes, consolidation, and projection paths.';
