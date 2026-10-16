-- A model response is one logical batch, while each tool call is one durable
-- operation. Keep the batch and safety segment identity beside the operation
-- evidence so recovery and observability do not have to infer it from events.
ALTER TABLE tool_invocations
  ADD COLUMN IF NOT EXISTS batch_id TEXT,
  ADD COLUMN IF NOT EXISTS segment_id TEXT,
  ADD COLUMN IF NOT EXISTS temporal_activity_id TEXT;

CREATE INDEX IF NOT EXISTS tool_invocations_run_batch_idx
  ON tool_invocations (run_id, batch_id, sequence_number);

CREATE INDEX IF NOT EXISTS tool_invocations_temporal_activity_idx
  ON tool_invocations (run_id, temporal_activity_id)
  WHERE temporal_activity_id IS NOT NULL;
