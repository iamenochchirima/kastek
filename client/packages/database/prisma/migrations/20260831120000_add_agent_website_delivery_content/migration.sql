ALTER TABLE "AgentWebsiteDeliveryEvent"
ADD COLUMN "messageContent" JSONB NOT NULL DEFAULT '{}'::jsonb;
