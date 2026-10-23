CREATE TABLE "GrowthAgentSetup" (
  "orgId" TEXT PRIMARY KEY REFERENCES "Organization"("id") ON DELETE CASCADE,
  "requestId" TEXT NOT NULL UNIQUE,
  "defaultsRevision" TEXT NOT NULL DEFAULT '1',
  "modelProfileId" TEXT NOT NULL,
  "modelProfileRevision" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','running','ready','blocked','failed','cancelled')),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "generation" INTEGER NOT NULL DEFAULT 0,
  "failureCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3)
);
CREATE INDEX "GrowthAgentSetup_status_nextAttemptAt_idx" ON "GrowthAgentSetup"("status", "nextAttemptAt");
CREATE INDEX "GrowthAgentSetup_status_leaseExpiresAt_idx" ON "GrowthAgentSetup"("status", "leaseExpiresAt");
