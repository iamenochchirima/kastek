-- Recurring Paystack charges need billing records even when they do not have
-- an initial checkout row. Period boundaries make credit grants recoverable
-- after a transient failure between payment settlement and credit granting.

ALTER TABLE "BillingInvoice"
  ALTER COLUMN "checkoutId" DROP NOT NULL;

ALTER TABLE "BillingInvoice"
  ADD COLUMN "periodStart" TIMESTAMP(3),
  ADD COLUMN "periodEnd" TIMESTAMP(3);

DROP INDEX IF EXISTS "BillingInvoice_subscriptionId_idx";
CREATE INDEX "BillingInvoice_subscriptionId_periodStart_idx"
  ON "BillingInvoice"("subscriptionId", "periodStart");
