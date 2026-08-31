CREATE TABLE "ExternalConnectionPermission" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "providerPermission" TEXT,
    "state" TEXT NOT NULL,
    "requestable" BOOLEAN NOT NULL DEFAULT false,
    "reasonCode" TEXT,
    "authMode" TEXT,
    "verificationSource" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalConnectionPermission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalConnectionAuthorizationAttempt" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "authMode" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "requestedCapabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'STARTED',
    "failureCode" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalConnectionAuthorizationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalConnectionPermission_connectionId_key_key"
    ON "ExternalConnectionPermission"("connectionId", "key");
CREATE INDEX "ExternalConnectionPermission_connectionId_state_idx"
    ON "ExternalConnectionPermission"("connectionId", "state");
CREATE INDEX "ExternalConnectionPermission_key_state_idx"
    ON "ExternalConnectionPermission"("key", "state");
CREATE UNIQUE INDEX "ExternalConnectionAuthorizationAttempt_state_key"
    ON "ExternalConnectionAuthorizationAttempt"("state");
CREATE INDEX "ExternalConnectionAuthorizationAttempt_connectionId_status_idx"
    ON "ExternalConnectionAuthorizationAttempt"("connectionId", "status");
CREATE INDEX "ExternalConnectionAuthorizationAttempt_orgId_expiresAt_idx"
    ON "ExternalConnectionAuthorizationAttempt"("orgId", "expiresAt");

ALTER TABLE "ExternalConnectionPermission"
    ADD CONSTRAINT "ExternalConnectionPermission_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "ExternalConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExternalConnectionAuthorizationAttempt"
    ADD CONSTRAINT "ExternalConnectionAuthorizationAttempt_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "ExternalConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
