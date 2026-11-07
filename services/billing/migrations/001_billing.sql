-- Central billing service schema. Money is stored in integer minor units or
-- exact numeric values; never floating point.

CREATE SCHEMA IF NOT EXISTS billing;

CREATE TABLE IF NOT EXISTS billing.accounts (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  currency text NOT NULL DEFAULT 'ZAR' CHECK (currency ~ '^[A-Z]{3}$'),
  tax_rate_bps integer NOT NULL DEFAULT 1500 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  vat_number text,
  billing_email text NOT NULL CHECK (length(billing_email) BETWEEN 3 AND 320),
  billing_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_customer_id text,
  entitlements_revision bigint NOT NULL DEFAULT 1 CHECK (entitlements_revision > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing.account_links (
  id text PRIMARY KEY,
  billing_account_id text NOT NULL REFERENCES billing.accounts(id) ON DELETE CASCADE,
  product text NOT NULL CHECK (product IN ('growth', 'agents', 'agency')),
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 256),
  role text NOT NULL DEFAULT 'payer' CHECK (role IN ('payer', 'member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product, tenant_id)
);

CREATE INDEX IF NOT EXISTS billing_account_links_account ON billing.account_links(billing_account_id);

CREATE TABLE IF NOT EXISTS billing.account_grants (
  id text PRIMARY KEY,
  billing_account_id text NOT NULL REFERENCES billing.accounts(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 120),
  value jsonb NOT NULL,
  source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'TRIAL', 'MIGRATION', 'PROMOTION')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  reason text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS billing_account_grants_active
  ON billing.account_grants(billing_account_id, key, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS billing.catalog_products (
  key text PRIMARY KEY CHECK (key ~ '^[a-z0-9._-]{1,80}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing.capabilities (
  key text PRIMARY KEY CHECK (key ~ '^[a-z0-9._-]{1,120}$'),
  product text NOT NULL REFERENCES billing.catalog_products(key) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text,
  kind text NOT NULL DEFAULT 'feature' CHECK (kind IN ('feature', 'limit', 'meter')),
  unit text,
  credit_cost_per_unit numeric(20, 6) CHECK (credit_cost_per_unit IS NULL OR credit_cost_per_unit >= 0),
  credit_cost_minimum bigint NOT NULL DEFAULT 0 CHECK (credit_cost_minimum >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing.plans (
  id text PRIMARY KEY,
  product_key text NOT NULL REFERENCES billing.catalog_products(key) ON DELETE RESTRICT,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9._-]{1,80}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_plans_product ON billing.plans(product_key, status);

CREATE TABLE IF NOT EXISTS billing.plan_versions (
  id text PRIMARY KEY,
  plan_id text NOT NULL REFERENCES billing.plans(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  interval text NOT NULL DEFAULT 'monthly' CHECK (interval IN ('monthly')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  tax_inclusive boolean NOT NULL DEFAULT true,
  tax_rate_bps integer NOT NULL DEFAULT 1500 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  credits_per_period bigint CHECK (credits_per_period IS NULL OR credits_per_period >= 0),
  paystack_plan_code text UNIQUE,
  active boolean NOT NULL DEFAULT false,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version)
);

CREATE INDEX IF NOT EXISTS billing_plan_versions_active
  ON billing.plan_versions(plan_id, active, effective_from DESC);

CREATE TABLE IF NOT EXISTS billing.plan_entitlements (
  id text PRIMARY KEY,
  plan_version_id text NOT NULL REFERENCES billing.plan_versions(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 120),
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_version_id, key)
);

CREATE INDEX IF NOT EXISTS billing_plan_entitlements_key ON billing.plan_entitlements(key);

CREATE TABLE IF NOT EXISTS billing.subscriptions (
  id text PRIMARY KEY,
  billing_account_id text NOT NULL REFERENCES billing.accounts(id) ON DELETE CASCADE,
  plan_version_id text NOT NULL REFERENCES billing.plan_versions(id) ON DELETE RESTRICT,
  product_key text NOT NULL REFERENCES billing.catalog_products(key) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'incomplete'
    CHECK (status IN ('trialing', 'active', 'past_due', 'grace', 'canceled', 'incomplete')),
  provider text,
  provider_customer_id text,
  provider_subscription_id text UNIQUE,
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  grace_ends_at timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_subscriptions_current
  ON billing.subscriptions(billing_account_id, product_key)
  WHERE status IN ('trialing', 'active', 'past_due', 'grace');

CREATE INDEX IF NOT EXISTS billing_subscriptions_provider
  ON billing.subscriptions(provider, provider_subscription_id);

CREATE TABLE IF NOT EXISTS billing.checkouts (
  id text PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  idempotency_key text NOT NULL,
  billing_account_id text NOT NULL REFERENCES billing.accounts(id) ON DELETE CASCADE,
  plan_version_id text NOT NULL REFERENCES billing.plan_versions(id) ON DELETE RESTRICT,
  product_key text NOT NULL REFERENCES billing.catalog_products(key) ON DELETE RESTRICT,
  provider text NOT NULL DEFAULT 'paystack',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed', 'abandoned', 'reversed')),
  authorization_url text,
  return_url text,
  expected_amount_minor bigint NOT NULL CHECK (expected_amount_minor >= 0),
  expected_currency text NOT NULL CHECK (expected_currency ~ '^[A-Z]{3}$'),
  expected_tax_inclusive boolean NOT NULL,
  expected_tax_rate_bps integer NOT NULL CHECK (expected_tax_rate_bps BETWEEN 0 AND 10000),
  provider_transaction_id text,
  provider_response jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (billing_account_id, provider, idempotency_key)
);

CREATE INDEX IF NOT EXISTS billing_checkouts_pending ON billing.checkouts(status, created_at);

CREATE SEQUENCE IF NOT EXISTS billing.invoice_number_seq;

CREATE TABLE IF NOT EXISTS billing.invoices (
  id text PRIMARY KEY,
  invoice_number text NOT NULL UNIQUE,
  billing_account_id text NOT NULL REFERENCES billing.accounts(id) ON DELETE CASCADE,
  subscription_id text REFERENCES billing.subscriptions(id) ON DELETE SET NULL,
  checkout_id text REFERENCES billing.checkouts(id) ON DELETE SET NULL,
  provider text,
  provider_invoice_id text,
  provider_transaction_id text,
  status text NOT NULL DEFAULT 'paid'
    CHECK (status IN ('draft', 'open', 'paid', 'void', 'refunded', 'partially_refunded')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  tax_rate_bps integer NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  tax_inclusive boolean NOT NULL,
  period_start timestamptz,
  period_end timestamptz,
  issued_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz,
  paid_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_invoices_provider
  ON billing.invoices(provider, provider_invoice_id)
  WHERE provider_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS billing_invoices_checkout
  ON billing.invoices(checkout_id)
  WHERE checkout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS billing_invoices_account ON billing.invoices(billing_account_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS billing_invoices_subscription ON billing.invoices(subscription_id, period_start);

CREATE TABLE IF NOT EXISTS billing.invoice_lines (
  id text PRIMARY KEY,
  invoice_id text NOT NULL REFERENCES billing.invoices(id) ON DELETE CASCADE,
  product_key text,
  plan_key text,
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_amount_minor bigint NOT NULL CHECK (unit_amount_minor >= 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  period_start timestamptz,
  period_end timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS billing_invoice_lines_invoice ON billing.invoice_lines(invoice_id);

CREATE TABLE IF NOT EXISTS billing.provider_transactions (
  id text PRIMARY KEY,
  billing_account_id text NOT NULL REFERENCES billing.accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_transaction_id text NOT NULL,
  reference text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('charge', 'refund', 'dispute')),
  status text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  invoice_id text REFERENCES billing.invoices(id) ON DELETE SET NULL,
  subscription_id text REFERENCES billing.subscriptions(id) ON DELETE SET NULL,
  checkout_id text REFERENCES billing.checkouts(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_transaction_id)
);

CREATE INDEX IF NOT EXISTS billing_provider_transactions_reference
  ON billing.provider_transactions(provider, reference);

CREATE TABLE IF NOT EXISTS billing.credit_accounts (
  id text PRIMARY KEY,
  billing_account_id text NOT NULL UNIQUE REFERENCES billing.accounts(id) ON DELETE CASCADE,
  balance bigint NOT NULL DEFAULT 0,
  reserved_balance bigint NOT NULL DEFAULT 0 CHECK (reserved_balance >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing.credit_grants (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES billing.credit_accounts(id) ON DELETE CASCADE,
  product_key text NOT NULL REFERENCES billing.catalog_products(key) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN ('PLAN', 'TRIAL', 'PURCHASE', 'REFERRAL', 'MIGRATION', 'PROMOTION', 'ADJUSTMENT')),
  amount bigint NOT NULL CHECK (amount > 0),
  remaining bigint NOT NULL CHECK (remaining >= 0 AND remaining <= amount),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  reference text,
  idempotency_key text UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS billing_credit_grants_spendable
  ON billing.credit_grants(account_id, product_key, remaining, ends_at);

CREATE TABLE IF NOT EXISTS billing.credit_ledger (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES billing.credit_accounts(id) ON DELETE CASCADE,
  product_key text NOT NULL REFERENCES billing.catalog_products(key) ON DELETE RESTRICT,
  grant_id text REFERENCES billing.credit_grants(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('grant', 'debit', 'refund', 'adjustment', 'expiry', 'release')),
  amount bigint NOT NULL,
  balance_after bigint NOT NULL,
  reference text,
  idempotency_key text UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_credit_ledger_account ON billing.credit_ledger(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS billing_credit_ledger_product ON billing.credit_ledger(account_id, product_key, created_at DESC);

CREATE TABLE IF NOT EXISTS billing.usage_events (
  id text PRIMARY KEY,
  billing_account_id text NOT NULL REFERENCES billing.accounts(id) ON DELETE CASCADE,
  product text NOT NULL CHECK (product IN ('growth', 'agents', 'agency')),
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 256),
  meter_key text NOT NULL CHECK (length(meter_key) BETWEEN 1 AND 120),
  quantity numeric(20, 6) NOT NULL CHECK (quantity >= 0),
  occurred_at timestamptz NOT NULL,
  source_type text,
  source_id text,
  idempotency_key text NOT NULL UNIQUE,
  provider_cost_minor bigint,
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  credits_charged bigint NOT NULL DEFAULT 0 CHECK (credits_charged >= 0),
  credit_ledger_id text REFERENCES billing.credit_ledger(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_usage_events_account
  ON billing.usage_events(billing_account_id, product, occurred_at DESC);
CREATE INDEX IF NOT EXISTS billing_usage_events_meter
  ON billing.usage_events(billing_account_id, product, meter_key, occurred_at DESC);

CREATE TABLE IF NOT EXISTS billing.webhook_events (
  id text PRIMARY KEY,
  provider text NOT NULL,
  event_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processing', 'processed', 'ignored', 'failed')),
  error_message text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS billing_webhook_events_retry
  ON billing.webhook_events(status, received_at);

CREATE TABLE IF NOT EXISTS billing.reconciliation_issues (
  id text PRIMARY KEY,
  fingerprint text NOT NULL UNIQUE,
  billing_account_id text REFERENCES billing.accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  issue_type text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_reconciliation_issues_open
  ON billing.reconciliation_issues(status, detected_at DESC);

CREATE TABLE IF NOT EXISTS billing.request_nonces (
  nonce text PRIMARY KEY,
  issuer text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS billing_request_nonces_expiry ON billing.request_nonces(expires_at);

CREATE TABLE IF NOT EXISTS billing.audit (
  id text PRIMARY KEY,
  actor_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_audit_created ON billing.audit(created_at DESC);

INSERT INTO billing.catalog_products (key, name, description)
VALUES
  ('growth', 'KasiTek Growth', 'Customer conversations, campaigns, content, bookings, and workspace agents.'),
  ('agents', 'KasiTek Agents', 'Standalone customer-service agents for website and messaging channels.'),
  ('agency', 'KasiTek Agency', 'Partner and tenant platform for managing client workspaces.')
ON CONFLICT (key) DO NOTHING;
