ALTER TABLE "WhatsappCampaignRecipient"
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3);

CREATE INDEX "WhatsappCampaignRecipient_campaignId_attemptCount_idx"
  ON "WhatsappCampaignRecipient"("campaignId", "attemptCount");
