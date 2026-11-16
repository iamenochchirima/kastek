ALTER TABLE "GrowthAgentChannelGrant"
  ADD COLUMN IF NOT EXISTS "assistantTarget" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "GrowthAgentChannelConversation" (
  id text PRIMARY KEY,
  "orgId" text NOT NULL,
  "grantId" uuid NOT NULL,
  "externalConversationId" text NOT NULL,
  "conversationId" uuid NOT NULL,
  "createdAt" timestamp(3) with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp(3) with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "GrowthAgentChannelConversation_grant_thread_key"
  ON "GrowthAgentChannelConversation" ("grantId", "externalConversationId");

ALTER TABLE "GrowthAgentChannelConversation"
  ADD CONSTRAINT "GrowthAgentChannelConversation_grantId_fkey"
  FOREIGN KEY ("grantId") REFERENCES "GrowthAgentChannelGrant"(id) ON DELETE CASCADE;
