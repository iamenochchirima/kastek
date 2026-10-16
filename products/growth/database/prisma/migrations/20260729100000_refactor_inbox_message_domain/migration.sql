-- Inbox rich-content clean cutover. This project is pre-production, so opaque
-- text-envelope rows are intentionally removed instead of being kept behind a
-- compatibility parser. New rich message state is stored in the tables below.

DELETE FROM "Message"
WHERE content LIKE '__kasiai_wa_%';

ALTER TABLE "Message"
    ADD COLUMN "contentType" TEXT NOT NULL DEFAULT 'TEXT',
    ADD COLUMN "editedAt" TIMESTAMP(3),
    ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "Message_contentType_idx" ON "Message"("contentType");
CREATE INDEX "Message_deletedAt_idx" ON "Message"("deletedAt");

CREATE TABLE "MessageAttachment" (
    id TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "providerAttachmentId" TEXT,
    "providerMediaId" TEXT,
    kind TEXT NOT NULL,
    "mimeType" TEXT,
    "fileName" TEXT,
    "byteSize" INTEGER,
    checksum TEXT,
    width INTEGER,
    height INTEGER,
    "durationMs" INTEGER,
    "storageKey" TEXT,
    "previewStorageKey" TEXT,
    "downloadStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "scanStatus" TEXT NOT NULL DEFAULT 'PENDING',
    metadata JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY (id),
    CONSTRAINT "MessageAttachment_messageId_fkey"
      FOREIGN KEY ("messageId") REFERENCES "Message"(id)
      ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "MessageAttachment_messageId_idx" ON "MessageAttachment"("messageId");
CREATE INDEX "MessageAttachment_providerMediaId_idx" ON "MessageAttachment"("providerMediaId");
CREATE INDEX "MessageAttachment_downloadStatus_idx" ON "MessageAttachment"("downloadStatus");

CREATE TABLE "MessageReference" (
    id TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "referencedMessageId" TEXT,
    "referencedProviderMessageId" TEXT,
    kind TEXT NOT NULL DEFAULT 'REPLY',
    "previewText" TEXT,
    "previewKind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageReference_pkey" PRIMARY KEY (id),
    CONSTRAINT "MessageReference_messageId_key" UNIQUE ("messageId"),
    CONSTRAINT "MessageReference_messageId_fkey"
      FOREIGN KEY ("messageId") REFERENCES "Message"(id)
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MessageReference_referencedMessageId_fkey"
      FOREIGN KEY ("referencedMessageId") REFERENCES "Message"(id)
      ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "MessageReference_referencedMessageId_idx" ON "MessageReference"("referencedMessageId");
CREATE INDEX "MessageReference_referencedProviderMessageId_idx" ON "MessageReference"("referencedProviderMessageId");

CREATE TABLE "MessageReaction" (
    id TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "actorIdentifier" TEXT NOT NULL,
    emoji TEXT,
    "providerEventId" TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageReaction_pkey" PRIMARY KEY (id),
    CONSTRAINT "MessageReaction_messageId_actorIdentifier_key" UNIQUE ("messageId", "actorIdentifier"),
    CONSTRAINT "MessageReaction_messageId_fkey"
      FOREIGN KEY ("messageId") REFERENCES "Message"(id)
      ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "MessageReaction_providerEventId_idx" ON "MessageReaction"("providerEventId");
CREATE INDEX "MessageReaction_messageId_active_idx" ON "MessageReaction"("messageId", active);

CREATE TABLE "MessageEvent" (
    id TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "providerEventId" TEXT,
    kind TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageEvent_pkey" PRIMARY KEY (id),
    CONSTRAINT "MessageEvent_conversationId_providerEventId_key" UNIQUE ("conversationId", "providerEventId"),
    CONSTRAINT "MessageEvent_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "Conversation"(id)
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MessageEvent_messageId_fkey"
      FOREIGN KEY ("messageId") REFERENCES "Message"(id)
      ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "MessageEvent_messageId_occurredAt_idx" ON "MessageEvent"("messageId", "occurredAt");
CREATE INDEX "MessageEvent_conversationId_occurredAt_idx" ON "MessageEvent"("conversationId", "occurredAt");
