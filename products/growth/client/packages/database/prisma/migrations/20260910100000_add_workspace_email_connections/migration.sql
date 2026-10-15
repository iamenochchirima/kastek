-- Workspace-owned email provider accounts. Access and refresh tokens are
-- encrypted by Core before they are written; Agents and the browser only see
-- the ExternalConnection projection.
CREATE TABLE "EmailConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "healthStatus" TEXT NOT NULL DEFAULT 'HEALTHY',
    "syncStatus" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailOAuthState" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "returnPath" TEXT NOT NULL DEFAULT '/inbox',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emailConnectionId" TEXT,
    CONSTRAINT "EmailOAuthState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailConnection_orgId_provider_externalAccountId_key"
    ON "EmailConnection"("orgId", "provider", "externalAccountId");
CREATE INDEX "EmailConnection_orgId_provider_idx"
    ON "EmailConnection"("orgId", "provider");
CREATE INDEX "EmailConnection_orgId_status_idx"
    ON "EmailConnection"("orgId", "status");
CREATE INDEX "EmailConnection_emailAddress_idx"
    ON "EmailConnection"("emailAddress");
CREATE UNIQUE INDEX "EmailOAuthState_stateHash_key"
    ON "EmailOAuthState"("stateHash");
CREATE INDEX "EmailOAuthState_orgId_expiresAt_idx"
    ON "EmailOAuthState"("orgId", "expiresAt");
CREATE INDEX "EmailOAuthState_userId_provider_idx"
    ON "EmailOAuthState"("userId", "provider");

ALTER TABLE "EmailConnection"
    ADD CONSTRAINT "EmailConnection_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailConnection"
    ADD CONSTRAINT "EmailConnection_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailOAuthState"
    ADD CONSTRAINT "EmailOAuthState_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailOAuthState"
    ADD CONSTRAINT "EmailOAuthState_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailOAuthState"
    ADD CONSTRAINT "EmailOAuthState_emailConnectionId_fkey"
    FOREIGN KEY ("emailConnectionId") REFERENCES "EmailConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
