CREATE TABLE "AdminSavedReport" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminSavedReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminSavedReport_createdById_updatedAt_idx" ON "AdminSavedReport"("createdById", "updatedAt");
CREATE INDEX "AdminSavedReport_reportKey_updatedAt_idx" ON "AdminSavedReport"("reportKey", "updatedAt");

ALTER TABLE "AdminSavedReport"
  ADD CONSTRAINT "AdminSavedReport_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
