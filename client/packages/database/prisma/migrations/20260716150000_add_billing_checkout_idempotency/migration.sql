ALTER TABLE "BillingCheckout"
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "authorizationUrl" TEXT,
ADD COLUMN "providerResponse" JSONB;

CREATE UNIQUE INDEX "BillingCheckout_orgId_provider_idempotencyKey_key"
ON "BillingCheckout"("orgId", "provider", "idempotencyKey");
