-- Customer handoff rollout control.
-- The flag is intentionally organization/installation scoped so operators can
-- pause new handoff requests without changing the transcript ownership model
-- or hiding already-created requests from the live queue.
ALTER TABLE agent_operator_feature_flags
  DROP CONSTRAINT IF EXISTS agent_operator_feature_flags_flag_key_check;

ALTER TABLE agent_operator_feature_flags
  ADD CONSTRAINT agent_operator_feature_flags_flag_key_check
  CHECK (flag_key IN (
    'agent_execution_enabled',
    'effect_execution_enabled',
    'mcp_enabled',
    'rest_enabled',
    'customer_handoff_enabled'
  ));

COMMENT ON COLUMN agent_operator_feature_flags.flag_key IS
  'Runtime rollout controls. customer_handoff_enabled gates new agent/workflow handoff requests; existing requests remain operator-resolvable.';
