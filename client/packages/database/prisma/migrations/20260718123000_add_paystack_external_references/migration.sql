-- Provider identifiers support reconciliation only. Internal checkout,
-- subscription, invoice, and entitlement records remain the access source.

ALTER TABLE "BillingCheckout"
  ADD COLUMN "providerTransactionId" TEXT,
  ADD COLUMN "providerAuthorizationId" TEXT;

CREATE INDEX "BillingCheckout_provider_providerTransactionId_idx"
  ON "BillingCheckout"("provider", "providerTransactionId");

-- Previous verified checkouts used the provider transaction reference as their
-- internal reference. Preserve that relationship for future support lookup.
UPDATE "BillingCheckout"
SET "providerTransactionId" = COALESCE("providerResponse"->>'transactionId', reference)
WHERE status = 'COMPLETED' AND "providerTransactionId" IS NULL;
