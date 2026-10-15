ALTER TABLE "Message"
    ADD COLUMN "providerMessageId" TEXT,
    ADD COLUMN "providerStatus" TEXT,
    ADD COLUMN "providerMetadata" JSONB;

CREATE INDEX "Message_providerMessageId_idx" ON "Message"("providerMessageId");
CREATE INDEX "Message_providerStatus_idx" ON "Message"("providerStatus");
