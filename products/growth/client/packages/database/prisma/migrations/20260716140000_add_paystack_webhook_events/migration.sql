CREATE TABLE "PaystackWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "errorMessage" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "PaystackWebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaystackWebhookEvent_eventKey_key" ON "PaystackWebhookEvent"("eventKey");
CREATE INDEX "PaystackWebhookEvent_status_receivedAt_idx" ON "PaystackWebhookEvent"("status", "receivedAt");
