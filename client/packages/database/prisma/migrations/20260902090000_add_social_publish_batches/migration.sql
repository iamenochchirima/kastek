CREATE TABLE "SocialPublishBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "idempotencyKey" TEXT NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "targetCount" INTEGER NOT NULL,
    "publishedCount" INTEGER NOT NULL DEFAULT 0,
    "processingCount" INTEGER NOT NULL DEFAULT 0,
    "unknownCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "blockedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "metadata" JSONB,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPublishBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SocialPublishBatchItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "channelConnectionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPublishBatchItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocialPublishBatch_orgId_idempotencyKey_key"
    ON "SocialPublishBatch"("orgId", "idempotencyKey");
CREATE INDEX "SocialPublishBatch_postId_status_idx"
    ON "SocialPublishBatch"("postId", "status");
CREATE INDEX "SocialPublishBatch_orgId_status_updatedAt_idx"
    ON "SocialPublishBatch"("orgId", "status", "updatedAt");
CREATE UNIQUE INDEX "SocialPublishBatchItem_batchId_jobId_key"
    ON "SocialPublishBatchItem"("batchId", "jobId");
CREATE INDEX "SocialPublishBatchItem_jobId_idx"
    ON "SocialPublishBatchItem"("jobId");
CREATE INDEX "SocialPublishBatchItem_batchId_status_idx"
    ON "SocialPublishBatchItem"("batchId", "status");

ALTER TABLE "SocialPublishBatch"
    ADD CONSTRAINT "SocialPublishBatch_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialPublishBatch"
    ADD CONSTRAINT "SocialPublishBatch_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialPublishBatch"
    ADD CONSTRAINT "SocialPublishBatch_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "SocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialPublishBatchItem"
    ADD CONSTRAINT "SocialPublishBatchItem_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "SocialPublishBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialPublishBatchItem"
    ADD CONSTRAINT "SocialPublishBatchItem_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "SocialPublishJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialPublishBatchItem"
    ADD CONSTRAINT "SocialPublishBatchItem_channelConnectionId_fkey"
    FOREIGN KEY ("channelConnectionId") REFERENCES "SocialChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
