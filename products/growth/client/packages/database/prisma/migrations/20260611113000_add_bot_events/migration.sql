CREATE TABLE IF NOT EXISTS "BotEvent" (
    id TEXT PRIMARY KEY,
    "botId" TEXT NOT NULL REFERENCES "BotConfiguration"(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    "orgId" TEXT REFERENCES "Organization"(id) ON DELETE SET NULL,
    "eventType" TEXT NOT NULL,
    channel TEXT,
    status TEXT,
    "conversationId" TEXT,
    "responseTimeMs" INTEGER,
    metadata JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "BotEvent_botId_createdAt_idx"
    ON "BotEvent"("botId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "BotEvent_userId_createdAt_idx"
    ON "BotEvent"("userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "BotEvent_orgId_createdAt_idx"
    ON "BotEvent"("orgId", "createdAt" DESC);
