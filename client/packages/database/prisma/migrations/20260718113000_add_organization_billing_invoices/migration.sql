-- Customer-facing billing invoices are organisation-owned records. They retain
-- provider references for reconciliation but never grant access on their own.

CREATE TABLE "BillingInvoice" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "provider" TEXT NOT NULL,
    "providerInvoiceId" TEXT,
    "providerTransactionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PAID',
    "currency" TEXT NOT NULL,
    "amountMinor" INTEGER,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingInvoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingInvoice_invoiceNumber_key" ON "BillingInvoice"("invoiceNumber");
CREATE UNIQUE INDEX "BillingInvoice_checkoutId_key" ON "BillingInvoice"("checkoutId");
CREATE UNIQUE INDEX "BillingInvoice_provider_providerInvoiceId_key"
  ON "BillingInvoice"("provider", "providerInvoiceId");
CREATE INDEX "BillingInvoice_orgId_issuedAt_idx" ON "BillingInvoice"("orgId", "issuedAt");
CREATE INDEX "BillingInvoice_subscriptionId_idx" ON "BillingInvoice"("subscriptionId");

ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_checkoutId_fkey"
  FOREIGN KEY ("checkoutId") REFERENCES "BillingCheckout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "OrganizationSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Preserve already verified payments as customer billing documents. The
-- transaction reference is retained as the provider reference until a provider
-- supplies a distinct invoice identifier.
INSERT INTO "BillingInvoice" (
  "id", "invoiceNumber", "orgId", "checkoutId", "subscriptionId", "provider",
  "providerTransactionId", "status", "currency", "amountMinor", "issuedAt",
  "paidAt", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  'KS-' || checkout.reference,
  checkout."orgId",
  checkout.id,
  subscription.id,
  checkout.provider,
  checkout.reference,
  'PAID',
  plan.currency,
  COALESCE((checkout."providerResponse"->>'amountMinor')::integer, plan."amountMinor"),
  COALESCE(checkout."completedAt", checkout."createdAt"),
  checkout."completedAt",
  NOW(),
  NOW()
FROM "BillingCheckout" checkout
JOIN "ProductPlan" plan ON plan.id = checkout."planId"
LEFT JOIN "OrganizationSubscription" subscription
  ON subscription."orgId" = checkout."orgId"
 AND subscription."planId" = checkout."planId"
 AND subscription.provider = checkout.provider
 AND subscription.status = 'ACTIVE'::"OrganizationSubscriptionStatus"
WHERE checkout.status = 'COMPLETED'
ON CONFLICT ("checkoutId") DO NOTHING;
