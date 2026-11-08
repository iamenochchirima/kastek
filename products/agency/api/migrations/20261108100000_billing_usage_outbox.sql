CREATE TABLE IF NOT EXISTS billing_usage_outbox (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meter_key text NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  source_type text NOT NULL,
  source_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_usage_outbox_pending
  ON billing_usage_outbox(next_attempt_at, created_at)
  WHERE delivered_at IS NULL;

CREATE INDEX IF NOT EXISTS billing_usage_outbox_tenant
  ON billing_usage_outbox(tenant_id, created_at DESC);
