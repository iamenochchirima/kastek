-- Kept beside the core deployment SQL inventory for environments that apply
-- core-owned SQL separately from the Prisma database migration.
CREATE TABLE IF NOT EXISTS "AdminSupportAccessGrant" (
    "id" TEXT PRIMARY KEY,
    "adminId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "reason" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "AdminSupportAccessGrant_adminId_expiresAt_idx"
  ON "AdminSupportAccessGrant"("adminId", "expiresAt");
CREATE INDEX IF NOT EXISTS "AdminSupportAccessGrant_organizationId_expiresAt_idx"
  ON "AdminSupportAccessGrant"("organizationId", "expiresAt");
CREATE TABLE IF NOT EXISTS "AdminSupportAccessAuditEvent" (
    "id" TEXT PRIMARY KEY,
    "grantId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "AdminSupportAccessAuditEvent_grantId_createdAt_idx"
  ON "AdminSupportAccessAuditEvent"("grantId", "createdAt");
