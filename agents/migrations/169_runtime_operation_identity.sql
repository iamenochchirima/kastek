-- A provider tool-call id is a wire-level value and is not guaranteed to be
-- unique across model rounds. Runtime operation identity is owned by the
-- agent loop and is the durable replay/idempotency key.
ALTER TABLE tool_invocations
  ADD COLUMN IF NOT EXISTS runtime_operation_id TEXT;

UPDATE tool_invocations
SET runtime_operation_id = provider_tool_call_id
WHERE runtime_operation_id IS NULL;

ALTER TABLE tool_invocations
  ALTER COLUMN runtime_operation_id SET NOT NULL;

ALTER TABLE tool_invocations
  DROP CONSTRAINT IF EXISTS tool_invocations_run_id_provider_tool_call_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS tool_invocations_run_runtime_operation_uidx
  ON tool_invocations (run_id, runtime_operation_id);

ALTER TABLE agent_approval_records
  ADD COLUMN IF NOT EXISTS runtime_operation_id TEXT;

UPDATE agent_approval_records
SET runtime_operation_id = provider_tool_call_id
WHERE runtime_operation_id IS NULL;

ALTER TABLE agent_approval_records
  ALTER COLUMN runtime_operation_id SET NOT NULL;

ALTER TABLE agent_approval_records
  DROP CONSTRAINT IF EXISTS agent_approval_records_run_id_provider_tool_call_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS agent_approval_records_run_runtime_operation_uidx
  ON agent_approval_records (run_id, runtime_operation_id);

ALTER TABLE agent_effect_receipts
  ADD COLUMN IF NOT EXISTS runtime_operation_id TEXT;

UPDATE agent_effect_receipts
SET runtime_operation_id = provider_tool_call_id
WHERE runtime_operation_id IS NULL;

ALTER TABLE agent_effect_receipts
  ALTER COLUMN runtime_operation_id SET NOT NULL;

ALTER TABLE agent_effect_receipts
  DROP CONSTRAINT IF EXISTS agent_effect_receipts_run_id_provider_tool_call_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS agent_effect_receipts_run_runtime_operation_uidx
  ON agent_effect_receipts (run_id, runtime_operation_id);
