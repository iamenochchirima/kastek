-- Durable approval records are the only approval source of truth. The
-- denormalized tool-invocations.approval payload was never authoritative and
-- allowed the execution evidence row to look like a second decision record.
ALTER TABLE tool_invocations
  DROP COLUMN IF EXISTS approval;
