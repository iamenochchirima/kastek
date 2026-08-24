CREATE TABLE "SocialPostInsightSyncState" (
    id TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    platform "SocialPlatform" NOT NULL,
    status TEXT NOT NULL DEFAULT 'IDLE',
    retryable BOOLEAN NOT NULL DEFAULT false,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    metadata JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPostInsightSyncState_pkey" PRIMARY KEY (id)
);

CREATE UNIQUE INDEX "SocialPostInsightSyncState_orgId_platform_key"
  ON "SocialPostInsightSyncState"("orgId", platform);
CREATE INDEX "SocialPostInsightSyncState_status_nextRetryAt_idx"
  ON "SocialPostInsightSyncState"(status, "nextRetryAt");
CREATE INDEX "SocialPostInsightSyncState_orgId_platform_lastAttemptAt_idx"
  ON "SocialPostInsightSyncState"("orgId", platform, "lastAttemptAt");

ALTER TABLE "SocialPostInsightSyncState"
  ADD CONSTRAINT "SocialPostInsightSyncState_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"(id)
  ON DELETE CASCADE ON UPDATE CASCADE;
