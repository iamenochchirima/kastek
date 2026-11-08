-- Dynamic plan configuration: capability metadata, plan-version lifecycle,
-- entitlement metadata and a single active version per plan/currency.

ALTER TABLE billing.capabilities
  ADD COLUMN IF NOT EXISTS value_type text NOT NULL DEFAULT 'boolean'
    CHECK (value_type IN ('boolean', 'integer', 'decimal', 'string')),
  ADD COLUMN IF NOT EXISTS display_group text,
  ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS visible_to_customer boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS implementation_status text NOT NULL DEFAULT 'implemented'
    CHECK (implementation_status IN ('implemented', 'product_pending', 'display_only'));

ALTER TABLE billing.plans
  ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE billing.plan_versions
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'active', 'retired')),
  ADD COLUMN IF NOT EXISTS effective_to timestamptz,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_by text,
  ADD COLUMN IF NOT EXISTS notes text;

UPDATE billing.plan_versions
   SET status = CASE WHEN active THEN 'active' ELSE 'draft' END
 WHERE status = 'draft';

-- Keep only the newest active version per plan and currency. Earlier active
-- versions become retired so the unique index can be created safely.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY plan_id, currency
           ORDER BY version DESC, effective_from DESC
         ) AS position
    FROM billing.plan_versions
   WHERE status = 'active'
)
UPDATE billing.plan_versions v
   SET status = 'retired', active = false, updated_at = now()
  FROM ranked r
 WHERE v.id = r.id AND r.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS billing_plan_versions_active_currency
  ON billing.plan_versions(plan_id, currency)
  WHERE status = 'active';

-- A Paystack plan code may back more than one version of the same plan when
-- price and interval are unchanged (for example, an entitlement-only change).
ALTER TABLE billing.plan_versions
  DROP CONSTRAINT IF EXISTS plan_versions_paystack_plan_code_key;

CREATE INDEX IF NOT EXISTS billing_plan_versions_paystack_plan_code
  ON billing.plan_versions(paystack_plan_code)
  WHERE paystack_plan_code IS NOT NULL;

ALTER TABLE billing.plan_entitlements
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS billing.settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO billing.settings(key, value)
VALUES ('catalog_defaults_version', '{"version":1}'::jsonb)
ON CONFLICT (key) DO NOTHING;
