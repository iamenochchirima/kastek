-- Cross-product billing accounts are keyed by the owner's shared identity and
-- normalized billing email. A second product tenant can auto-link only when both
-- match and the account does not already hold that product.

ALTER TABLE billing.accounts
  ADD COLUMN IF NOT EXISTS billing_email_normalized text,
  ADD COLUMN IF NOT EXISTS owner_issuer text,
  ADD COLUMN IF NOT EXISTS owner_subject text;

UPDATE billing.accounts
   SET billing_email_normalized = lower(trim(billing_email))
 WHERE billing_email_normalized IS NULL;

ALTER TABLE billing.accounts
  ALTER COLUMN billing_email_normalized SET NOT NULL;

CREATE INDEX IF NOT EXISTS billing_accounts_email
  ON billing.accounts(billing_email_normalized);

CREATE INDEX IF NOT EXISTS billing_accounts_owner_identity
  ON billing.accounts(owner_issuer, owner_subject);

-- One active tenant per product per payer account. A second workspace for the
-- same product must use a different billing account.
CREATE UNIQUE INDEX IF NOT EXISTS billing_account_links_active_product
  ON billing.account_links(billing_account_id, product)
  WHERE status = 'active';
