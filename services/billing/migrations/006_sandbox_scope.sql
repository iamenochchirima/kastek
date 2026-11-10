ALTER TABLE billing.accounts
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'production'
  CHECK (environment IN ('production', 'sandbox'));

ALTER TABLE billing.plans
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'public'
  CHECK (audience IN ('public', 'sandbox'));

CREATE INDEX IF NOT EXISTS billing_accounts_environment
  ON billing.accounts(environment, created_at DESC);

CREATE INDEX IF NOT EXISTS billing_plans_audience
  ON billing.plans(audience, product_key, status);
