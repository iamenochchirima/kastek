CREATE TABLE "DeveloperApiKey" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY['api:read', 'api:write']::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeveloperApiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeveloperApiKey_keyHash_key" ON "DeveloperApiKey"("keyHash");
CREATE INDEX "DeveloperApiKey_orgId_status_idx" ON "DeveloperApiKey"("orgId", "status");
CREATE INDEX "DeveloperApiKey_orgId_createdAt_idx" ON "DeveloperApiKey"("orgId", "createdAt");

ALTER TABLE "DeveloperApiKey"
  ADD CONSTRAINT "DeveloperApiKey_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DeveloperApiKey"
  ADD CONSTRAINT "DeveloperApiKey_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
