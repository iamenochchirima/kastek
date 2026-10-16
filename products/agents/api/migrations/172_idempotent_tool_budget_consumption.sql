ALTER TABLE tool_invocations
  ADD COLUMN IF NOT EXISTS tool_budget_consumed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS tool_invocations_budget_consumed_idx
  ON tool_invocations (run_id, runtime_operation_id)
  WHERE tool_budget_consumed_at IS NOT NULL;
