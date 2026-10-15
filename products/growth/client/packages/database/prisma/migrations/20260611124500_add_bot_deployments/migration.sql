CREATE TABLE IF NOT EXISTS "BotDeployment" (
    id TEXT PRIMARY KEY,
    "botId" TEXT NOT NULL REFERENCES "BotConfiguration"(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    "orgId" TEXT REFERENCES "Organization"(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    target TEXT NOT NULL,
    status TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "workflowId" TEXT,
    "templateKey" TEXT,
    "configSnapshot" JSONB,
    "responsePayload" JSONB,
    "errorMessage" TEXT,
    "deployedAt" TIMESTAMPTZ,
    "pausedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "BotDeployment_botId_createdAt_idx"
    ON "BotDeployment"("botId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "BotDeployment_userId_createdAt_idx"
    ON "BotDeployment"("userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "BotDeployment_orgId_createdAt_idx"
    ON "BotDeployment"("orgId", "createdAt" DESC);
