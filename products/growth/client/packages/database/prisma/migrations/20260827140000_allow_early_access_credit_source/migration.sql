ALTER TABLE "CreditGrant"
  DROP CONSTRAINT "CreditGrant_source_check";

ALTER TABLE "CreditGrant"
  ADD CONSTRAINT "CreditGrant_source_check"
  CHECK ("source" IN ('PLAN', 'TRIAL', 'REFERRAL', 'PURCHASE', 'MANUAL', 'PROMOTIONAL', 'MIGRATION', 'COMPENSATION', 'EARLY_ACCESS'));
