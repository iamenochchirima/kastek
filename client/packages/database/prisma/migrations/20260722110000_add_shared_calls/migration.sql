CREATE TABLE "CommunicationCall" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerCallId" TEXT,
    "connectionId" TEXT,
    "conversationId" TEXT,
    "whatsappSessionId" TEXT,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
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
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommunicationCall_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommunicationCallLeg" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "providerLegId" TEXT,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "fromPhone" TEXT,
    "toPhone" TEXT,
    "startedAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommunicationCallLeg_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommunicationCall_provider_providerCallId_key"
    ON "CommunicationCall"("provider", "providerCallId");
CREATE UNIQUE INDEX "CommunicationCall_whatsappSessionId_key"
    ON "CommunicationCall"("whatsappSessionId");
CREATE INDEX "CommunicationCall_orgId_createdAt_idx"
    ON "CommunicationCall"("orgId", "createdAt");
CREATE INDEX "CommunicationCall_orgId_status_createdAt_idx"
    ON "CommunicationCall"("orgId", "status", "createdAt");
CREATE INDEX "CommunicationCall_connectionId_createdAt_idx"
    ON "CommunicationCall"("connectionId", "createdAt");
CREATE INDEX "CommunicationCall_conversationId_createdAt_idx"
    ON "CommunicationCall"("conversationId", "createdAt");
CREATE UNIQUE INDEX "CommunicationCallLeg_callId_providerLegId_key"
    ON "CommunicationCallLeg"("callId", "providerLegId");
CREATE INDEX "CommunicationCallLeg_callId_createdAt_idx"
    ON "CommunicationCallLeg"("callId", "createdAt");

ALTER TABLE "CommunicationCall"
    ADD CONSTRAINT "CommunicationCall_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunicationCall"
    ADD CONSTRAINT "CommunicationCall_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "ExternalConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommunicationCall"
    ADD CONSTRAINT "CommunicationCall_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommunicationCall"
    ADD CONSTRAINT "CommunicationCall_whatsappSessionId_fkey"
    FOREIGN KEY ("whatsappSessionId") REFERENCES "WhatsappCallSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommunicationCallLeg"
    ADD CONSTRAINT "CommunicationCallLeg_callId_fkey"
    FOREIGN KEY ("callId") REFERENCES "CommunicationCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "CommunicationCall" (
    "id", "orgId", provider, "providerCallId", "connectionId", "conversationId", "whatsappSessionId",
    direction, status, "fromPhone", "toPhone", "agentLabel", "startedAt", "answeredAt", "endedAt",
    "durationSeconds", "errorCode", "errorMessage", "rawPayload", "createdAt", "updatedAt"
)
SELECT
    'call_' || session.id,
    COALESCE(session."orgId", connection."orgId"),
    'WHATSAPP',
    session."waCallId",
    external.id,
    session."conversationId",
    session.id,
    session.direction::text,
    session.status::text,
    session."fromPhone",
    session."toPhone",
    session."agentLabel",
    session."startedAt",
    session."answeredAt",
    session."endedAt",
    session."durationSeconds",
    session."errorCode",
    session."errorMessage",
    session."rawPayload",
    session."createdAt",
    session."updatedAt"
FROM "WhatsappCallSession" session
INNER JOIN "WhatsappConnection" connection ON connection.id = session."connectionId"
LEFT JOIN "ExternalConnection" external
    ON external."orgId" = connection."orgId"
   AND external."sourceType" = 'WHATSAPP'
   AND external."sourceId" = connection.id
WHERE COALESCE(session."orgId", connection."orgId") IS NOT NULL
ON CONFLICT ("whatsappSessionId") DO NOTHING;
