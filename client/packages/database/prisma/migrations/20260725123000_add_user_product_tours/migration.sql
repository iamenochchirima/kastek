CREATE TABLE "UserProductTour" (
    id TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserProductTour_pkey" PRIMARY KEY (id)
);

CREATE UNIQUE INDEX "UserProductTour_userId_orgId_key" ON "UserProductTour"("userId", "orgId");
CREATE INDEX "UserProductTour_orgId_idx" ON "UserProductTour"("orgId");

ALTER TABLE "UserProductTour"
  ADD CONSTRAINT "UserProductTour_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"(id)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserProductTour"
  ADD CONSTRAINT "UserProductTour_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"(id)
  ON DELETE CASCADE ON UPDATE CASCADE;
