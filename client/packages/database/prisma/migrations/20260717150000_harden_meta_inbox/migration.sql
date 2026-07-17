ALTER TABLE "Conversation"
    ADD COLUMN IF NOT EXISTS "starred" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "externalConnectionId" TEXT;

UPDATE "Conversation" conversation
SET "externalConnectionId" = connection.id
FROM "ExternalConnection" connection
WHERE conversation."externalConnectionId" IS NULL
  AND conversation."orgId" = connection."orgId"
  AND (
    (conversation.channel = 'whatsapp'
      AND connection."sourceType" = 'WHATSAPP'
      AND connection."sourceId" = split_part(conversation."customerIdentifier", ':', 2))
    OR
    (conversation.channel IN ('facebook', 'instagram')
      AND connection."sourceType" = 'SOCIAL'
      AND connection."sourceId" = split_part(conversation."customerIdentifier", ':', 2))
  );

ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_externalConnectionId_fkey"
    FOREIGN KEY ("externalConnectionId") REFERENCES "ExternalConnection"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Conversation_externalConnectionId_lastMessageAt_idx"
    ON "Conversation"("externalConnectionId", "lastMessageAt");

DELETE FROM "Message" duplicate
USING "Message" original
WHERE duplicate."conversationId" = original."conversationId"
  AND duplicate."providerMessageId" = original."providerMessageId"
  AND duplicate."providerMessageId" IS NOT NULL
  AND (
    duplicate.timestamp > original.timestamp
    OR (duplicate.timestamp = original.timestamp AND duplicate.id > original.id)
  );

CREATE UNIQUE INDEX "Message_conversationId_providerMessageId_key"
    ON "Message"("conversationId", "providerMessageId");
