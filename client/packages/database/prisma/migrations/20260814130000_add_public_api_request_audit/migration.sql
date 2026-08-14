-- Durable request reservations support public API rate limiting and audit trails
-- across multiple core processes.
CREATE TABLE "PublicApiRequest" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "principalType" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "action" TEXT,
    "statusCode" INTEGER NOT NULL,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PublicApiRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PublicApiRequest_orgId_createdAt_idx"
  ON "PublicApiRequest"("orgId", "createdAt");
CREATE INDEX "PublicApiRequest_orgId_principalId_createdAt_idx"
  ON "PublicApiRequest"("orgId", "principalId", "createdAt");
CREATE INDEX "PublicApiRequest_action_createdAt_idx"
  ON "PublicApiRequest"("action", "createdAt");
ALTER TABLE "PublicApiRequest"
  ADD CONSTRAINT "PublicApiRequest_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
