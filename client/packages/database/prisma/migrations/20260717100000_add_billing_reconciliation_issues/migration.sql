CREATE TABLE "BillingReconciliationIssue" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "orgId" TEXT,
    "provider" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "issueType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "details" JSONB NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingReconciliationIssue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingReconciliationIssue_fingerprint_key"
ON "BillingReconciliationIssue"("fingerprint");
CREATE INDEX "BillingReconciliationIssue_status_detectedAt_idx"
ON "BillingReconciliationIssue"("status", "detectedAt");
CREATE INDEX "BillingReconciliationIssue_orgId_status_idx"
ON "BillingReconciliationIssue"("orgId", "status");
ALTER TABLE "BillingReconciliationIssue"
ADD CONSTRAINT "BillingReconciliationIssue_orgId_fkey"
FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
