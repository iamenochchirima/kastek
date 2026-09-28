ALTER TABLE run_budget_reservations
  DROP CONSTRAINT IF EXISTS run_budget_reservations_status_check;

ALTER TABLE run_budget_reservations
  ADD CONSTRAINT run_budget_reservations_status_check
  CHECK (status IN ('reserved', 'captured', 'released', 'unknown'));

ALTER TABLE run_budget_reservations
  ADD COLUMN IF NOT EXISTS reconciliation_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reconciliation_reason TEXT;

CREATE INDEX IF NOT EXISTS run_budget_reconciliation_idx
  ON run_budget_reservations (organization_id, created_at)
  WHERE reconciliation_required = true;
