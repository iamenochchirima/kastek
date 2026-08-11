CREATE TABLE "SocialWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "externalAccountId" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "errorMessage" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocialWebhookEvent_provider_eventKey_key"
    ON "SocialWebhookEvent"("provider", "eventKey");

CREATE INDEX "SocialWebhookEvent_provider_status_nextAttemptAt_idx"
    ON "SocialWebhookEvent"("provider", "status", "nextAttemptAt");

CREATE INDEX "SocialWebhookEvent_receivedAt_idx"
    ON "SocialWebhookEvent"("receivedAt");
