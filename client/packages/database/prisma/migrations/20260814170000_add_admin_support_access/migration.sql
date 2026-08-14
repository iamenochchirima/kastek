-- Time-limited, attributable support access is separate from the admin role.
CREATE TABLE "AdminSupportAccessGrant" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "reason" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminSupportAccessGrant_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AdminSupportAccessGrant"
  ADD CONSTRAINT "AdminSupportAccessGrant_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminSupportAccessGrant"
  ADD CONSTRAINT "AdminSupportAccessGrant_grantedById_fkey"
  FOREIGN KEY ("grantedById") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdminSupportAccessGrant"
  ADD CONSTRAINT "AdminSupportAccessGrant_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "AdminSupportAccessGrant_adminId_expiresAt_idx"
  ON "AdminSupportAccessGrant"("adminId", "expiresAt");
CREATE INDEX "AdminSupportAccessGrant_organizationId_expiresAt_idx"
  ON "AdminSupportAccessGrant"("organizationId", "expiresAt");

CREATE TABLE "AdminSupportAccessAuditEvent" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminSupportAccessAuditEvent_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "AdminSupportAccessAuditEvent"
  ADD CONSTRAINT "AdminSupportAccessAuditEvent_grantId_fkey"
  FOREIGN KEY ("grantId") REFERENCES "AdminSupportAccessGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "AdminSupportAccessAuditEvent_grantId_createdAt_idx"
  ON "AdminSupportAccessAuditEvent"("grantId", "createdAt");
