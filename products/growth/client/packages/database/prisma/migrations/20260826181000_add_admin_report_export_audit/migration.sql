CREATE TABLE "AdminReportExportAuditEvent" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'csv',
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminReportExportAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminReportExportAuditEvent_adminId_createdAt_idx" ON "AdminReportExportAuditEvent"("adminId", "createdAt");
CREATE INDEX "AdminReportExportAuditEvent_reportKey_createdAt_idx" ON "AdminReportExportAuditEvent"("reportKey", "createdAt");

ALTER TABLE "AdminReportExportAuditEvent"
  ADD CONSTRAINT "AdminReportExportAuditEvent_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
