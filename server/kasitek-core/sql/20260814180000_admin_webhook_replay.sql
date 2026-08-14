CREATE TABLE IF NOT EXISTS "AdminWebhookReplayCommand" (
    "id" TEXT PRIMARY KEY,
    "idempotencyKey" TEXT NOT NULL UNIQUE,
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
    "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS "AdminWebhookReplayCommand_status_updatedAt_idx"
  ON "AdminWebhookReplayCommand"("status", "updatedAt");
CREATE INDEX IF NOT EXISTS "AdminWebhookReplayCommand_deliveryId_createdAt_idx"
  ON "AdminWebhookReplayCommand"("deliveryId", "createdAt");

CREATE TABLE IF NOT EXISTS "AdminWebhookReplayAuditEvent" (
    "id" TEXT PRIMARY KEY,
    "commandId" TEXT NOT NULL REFERENCES "AdminWebhookReplayCommand"("id") ON DELETE RESTRICT,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "AdminWebhookReplayAuditEvent_commandId_createdAt_idx"
  ON "AdminWebhookReplayAuditEvent"("commandId", "createdAt");
