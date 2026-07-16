-- Server-side checkout records are the only link between a provider callback and a workspace.
CREATE TABLE "BillingCheckout" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingCheckout_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BillingCheckout_reference_key" ON "BillingCheckout"("reference");
CREATE INDEX "BillingCheckout_orgId_status_idx" ON "BillingCheckout"("orgId", "status");
ALTER TABLE "BillingCheckout" ADD CONSTRAINT "BillingCheckout_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillingCheckout" ADD CONSTRAINT "BillingCheckout_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ProductPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BillingCheckout" ADD CONSTRAINT "BillingCheckout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
