-- A provider effect can be interrupted after the side effect boundary and before
-- the result is durable. Keep that operation explicitly reconcilable instead of
-- misreporting it as an ordinary terminal failure.
ALTER TABLE tool_invocations
  DROP CONSTRAINT IF EXISTS tool_invocations_status_check;

ALTER TABLE tool_invocations
  ADD CONSTRAINT tool_invocations_status_check
  CHECK (status IN ('proposed', 'awaiting_approval', 'approved', 'rejected', 'executing', 'completed', 'failed', 'unknown'));
