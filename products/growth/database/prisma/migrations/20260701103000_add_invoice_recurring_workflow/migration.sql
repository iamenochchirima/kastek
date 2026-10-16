ALTER TABLE "Invoice"
ADD COLUMN IF NOT EXISTS "billingMode" TEXT NOT NULL DEFAULT 'one_off',
ADD COLUMN IF NOT EXISTS "recurringActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "billingAnchorDay" INTEGER,
ADD COLUMN IF NOT EXISTS "reminderDaysAfterDue" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN IF NOT EXISTS "lastSentAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "lastReminderAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "lastPaidAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Invoice_billingMode_recurringActive_idx"
ON "Invoice"("billingMode", "recurringActive");

CREATE TABLE IF NOT EXISTS "InvoiceRun" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "cycleKey" TEXT NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sendStatus" TEXT NOT NULL DEFAULT 'pending',
    "reminderStatus" TEXT NOT NULL DEFAULT 'not_needed',
    "sentAt" TIMESTAMP(3),
    "reminderDueAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "pricingItemsSnapshot" JSONB NOT NULL DEFAULT '[]',
    "titleSnapshot" TEXT NOT NULL,
    "contactEmailSnapshot" TEXT NOT NULL,
    "businessNameSnapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "InvoiceRun_invoiceId_cycleKey_key"
ON "InvoiceRun"("invoiceId", "cycleKey");

CREATE INDEX IF NOT EXISTS "InvoiceRun_invoiceId_issueDate_idx"
ON "InvoiceRun"("invoiceId", "issueDate");

CREATE INDEX IF NOT EXISTS "InvoiceRun_status_dueDate_idx"
ON "InvoiceRun"("status", "dueDate");

CREATE INDEX IF NOT EXISTS "InvoiceRun_sendStatus_issueDate_idx"
ON "InvoiceRun"("sendStatus", "issueDate");

CREATE INDEX IF NOT EXISTS "InvoiceRun_reminderStatus_reminderDueAt_idx"
ON "InvoiceRun"("reminderStatus", "reminderDueAt");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceRun_invoiceId_fkey'
    ) THEN
        ALTER TABLE "InvoiceRun"
        ADD CONSTRAINT "InvoiceRun_invoiceId_fkey"
        FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
