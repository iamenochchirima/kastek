-- Managed model cost is attributed at root settlement and debited against the AI allowance.
ALTER TABLE agents_platform.usage_ledger
  ADD COLUMN managed_cost_micros bigint NOT NULL DEFAULT 0
  CHECK (managed_cost_micros >= 0);

ALTER TABLE agents_platform.billing_usage_forwarded
  ADD COLUMN managed_cost_micros bigint NOT NULL DEFAULT 0
  CHECK (managed_cost_micros >= 0);

ALTER TABLE agents_platform.root_model_accounts
  ADD COLUMN credit_capped boolean NOT NULL DEFAULT false;
