ALTER TABLE "ProductWaitlistEntry"
  ADD COLUMN "cohort" TEXT NOT NULL DEFAULT 'beta';

CREATE INDEX "ProductWaitlistEntry_cohort_status_createdAt_idx"
  ON "ProductWaitlistEntry"("cohort", status, "createdAt");
