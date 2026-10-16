CREATE TABLE "AgentWebsiteDeployment" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "channelConnectionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "allowedOrigins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "displayName" TEXT,
    "welcomeText" TEXT,
    "launcherPosition" TEXT NOT NULL DEFAULT 'bottom-right',
    "colorPreset" TEXT NOT NULL DEFAULT 'indigo',
    "avatarUrl" TEXT,
    "privacyPolicyUrl" TEXT,
    "createdById" TEXT NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "pausedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentWebsiteDeployment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentWebsiteDeployment_publicId_key" ON "AgentWebsiteDeployment"("publicId");
CREATE UNIQUE INDEX "AgentWebsiteDeployment_channelConnectionId_key" ON "AgentWebsiteDeployment"("channelConnectionId");
CREATE INDEX "AgentWebsiteDeployment_orgId_installationId_status_idx" ON "AgentWebsiteDeployment"("orgId", "installationId", "status");
CREATE INDEX "AgentWebsiteDeployment_orgId_createdAt_idx" ON "AgentWebsiteDeployment"("orgId", "createdAt");

ALTER TABLE "AgentWebsiteDeployment"
  ADD CONSTRAINT "AgentWebsiteDeployment_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentWebsiteDeployment"
  ADD CONSTRAINT "AgentWebsiteDeployment_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AgentWebsiteVisitorSession" (
    "id" TEXT NOT NULL,
    "publicSessionId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "externalIdentity" TEXT NOT NULL,
    "externalConversationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentWebsiteVisitorSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentWebsiteVisitorSession_publicSessionId_key" ON "AgentWebsiteVisitorSession"("publicSessionId");
CREATE UNIQUE INDEX "AgentWebsiteVisitorSession_externalIdentity_key" ON "AgentWebsiteVisitorSession"("externalIdentity");
CREATE UNIQUE INDEX "AgentWebsiteVisitorSession_externalConversationId_key" ON "AgentWebsiteVisitorSession"("externalConversationId");
CREATE INDEX "AgentWebsiteVisitorSession_deploymentId_status_expiresAt_idx" ON "AgentWebsiteVisitorSession"("deploymentId", "status", "expiresAt");
ALTER TABLE "AgentWebsiteVisitorSession"
  ADD CONSTRAINT "AgentWebsiteVisitorSession_deploymentId_fkey"
  FOREIGN KEY ("deploymentId") REFERENCES "AgentWebsiteDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentWebsiteDeliveryEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "messageText" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentWebsiteDeliveryEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentWebsiteDeliveryEvent_eventKey_key" ON "AgentWebsiteDeliveryEvent"("eventKey");
CREATE INDEX "AgentWebsiteDeliveryEvent_sessionId_createdAt_idx" ON "AgentWebsiteDeliveryEvent"("sessionId", "createdAt");
ALTER TABLE "AgentWebsiteDeliveryEvent"
  ADD CONSTRAINT "AgentWebsiteDeliveryEvent_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "AgentWebsiteVisitorSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
