CREATE TYPE "WhatsappCallDirection" AS ENUM ('INBOUND', 'OUTBOUND');
CREATE TYPE "WhatsappCallStatus" AS ENUM ('RINGING', 'CONNECTING', 'ACTIVE', 'COMPLETED', 'REJECTED', 'MISSED', 'FAILED', 'CANCELLED');

CREATE TABLE "WhatsappCallSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "conversationId" TEXT,
    "direction" "WhatsappCallDirection" NOT NULL,
    "status" "WhatsappCallStatus" NOT NULL DEFAULT 'RINGING',
    "waCallId" TEXT,
    "fromPhone" TEXT NOT NULL,
    "toPhone" TEXT NOT NULL,
    "agentLabel" TEXT,
    "startedAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappCallSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhatsappCallEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" "WhatsappCallStatus",
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappCallEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhatsappCallSession_waCallId_key" ON "WhatsappCallSession"("waCallId");
CREATE INDEX "WhatsappCallSession_userId_createdAt_idx" ON "WhatsappCallSession"("userId", "createdAt");
CREATE INDEX "WhatsappCallSession_connectionId_createdAt_idx" ON "WhatsappCallSession"("connectionId", "createdAt");
CREATE INDEX "WhatsappCallSession_conversationId_createdAt_idx" ON "WhatsappCallSession"("conversationId", "createdAt");
CREATE INDEX "WhatsappCallSession_status_createdAt_idx" ON "WhatsappCallSession"("status", "createdAt");
CREATE INDEX "WhatsappCallEvent_sessionId_createdAt_idx" ON "WhatsappCallEvent"("sessionId", "createdAt");
CREATE INDEX "WhatsappCallEvent_eventType_createdAt_idx" ON "WhatsappCallEvent"("eventType", "createdAt");

ALTER TABLE "WhatsappCallSession"
ADD CONSTRAINT "WhatsappCallSession_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WhatsappCallSession"
ADD CONSTRAINT "WhatsappCallSession_connectionId_fkey"
FOREIGN KEY ("connectionId") REFERENCES "WhatsappConnection"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WhatsappCallSession"
ADD CONSTRAINT "WhatsappCallSession_conversationId_fkey"
FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsappCallEvent"
ADD CONSTRAINT "WhatsappCallEvent_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "WhatsappCallSession"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
