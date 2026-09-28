-- Reconciliation resolves an unknown receipt to its actual terminal outcome;
-- it is not a separate durable receipt state.
UPDATE agent_effect_receipts
SET status = CASE
  WHEN reconciliation_required THEN 'unknown'
  WHEN provider_receipt IS NOT NULL THEN 'succeeded'
  ELSE 'failed'
END
WHERE status = 'reconciled';

ALTER TABLE agent_effect_receipts
  DROP CONSTRAINT IF EXISTS agent_effect_receipts_status_check;

ALTER TABLE agent_effect_receipts
  ADD CONSTRAINT agent_effect_receipts_status_check
  CHECK (status IN ('reserved', 'executing', 'succeeded', 'failed', 'unknown'));
