ALTER TABLE "AgentWebsiteDeployment"
  ADD COLUMN "appearance" JSONB NOT NULL DEFAULT '{}'::jsonb;
