CREATE TABLE "AdminWebhookReplayCommand" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "expectedStatus" TEXT NOT NULL,
    "expectedAttemptCount" INTEGER NOT NULL,
    "approverIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'awaiting_approval',
    "error" TEXT,
    "result" JSONB,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdminWebhookReplayCommand_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminWebhookReplayCommand_idempotencyKey_key"
    ON "AdminWebhookReplayCommand"("idempotencyKey");
CREATE INDEX "AdminWebhookReplayCommand_status_updatedAt_idx"
    ON "AdminWebhookReplayCommand"("status", "updatedAt");
CREATE INDEX "AdminWebhookReplayCommand_deliveryId_createdAt_idx"
    ON "AdminWebhookReplayCommand"("deliveryId", "createdAt");

CREATE TABLE "AdminWebhookReplayAuditEvent" (
    "id" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminWebhookReplayAuditEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AdminWebhookReplayAuditEvent"
  ADD CONSTRAINT "AdminWebhookReplayAuditEvent_commandId_fkey"
  FOREIGN KEY ("commandId") REFERENCES "AdminWebhookReplayCommand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "AdminWebhookReplayAuditEvent_commandId_createdAt_idx"
  ON "AdminWebhookReplayAuditEvent"("commandId", "createdAt");
