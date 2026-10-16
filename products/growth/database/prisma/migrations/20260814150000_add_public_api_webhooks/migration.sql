CREATE TABLE "PublicApiWebhookSubscription" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secretCiphertext" TEXT NOT NULL,
    "eventTypes" JSONB NOT NULL DEFAULT '["public_api.request.completed"]',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastDeliveredAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "disabledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublicApiWebhookSubscription_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PublicApiWebhookSubscription_orgId_fkey"
        FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PublicApiWebhookSubscription_orgId_status_idx"
    ON "PublicApiWebhookSubscription"("orgId", "status");

CREATE TABLE "PublicApiWebhookDelivery" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastStatusCode" INTEGER,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublicApiWebhookDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PublicApiWebhookDelivery_subscriptionId_fkey"
        FOREIGN KEY ("subscriptionId") REFERENCES "PublicApiWebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PublicApiWebhookDelivery_subscriptionId_eventId_key"
    ON "PublicApiWebhookDelivery"("subscriptionId", "eventId");

CREATE INDEX "PublicApiWebhookDelivery_status_nextAttemptAt_idx"
    ON "PublicApiWebhookDelivery"("status", "nextAttemptAt");

CREATE INDEX "PublicApiWebhookDelivery_subscriptionId_createdAt_idx"
    ON "PublicApiWebhookDelivery"("subscriptionId", "createdAt");
