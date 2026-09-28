-- Capability awareness and automatic published-version movement are part of
-- the active runtime contract. Remove their old operator controls so no
-- installation can silently fall back to an un-aware or auto-following path.
DELETE FROM agent_operator_feature_flags
WHERE flag_key IN ('capability_awareness_enabled', 'agent_version_deployment_enabled');

ALTER TABLE agent_operator_feature_flags
  DROP CONSTRAINT IF EXISTS agent_operator_feature_flags_flag_key_check;

ALTER TABLE agent_operator_feature_flags
  ADD CONSTRAINT agent_operator_feature_flags_flag_key_check
  CHECK (flag_key IN (
    'agent_execution_enabled',
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
  'Runtime execution, effect, transport, handoff, audio, dynamic UI, and memory controls.';
