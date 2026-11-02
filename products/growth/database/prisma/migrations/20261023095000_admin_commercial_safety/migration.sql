CREATE TABLE "AdminCommercialAudit" (
 id TEXT PRIMARY KEY, "actorId" TEXT NOT NULL, action TEXT NOT NULL,
 "resourceId" TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}', "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE "AdminOutreachSendAttempt" (
 id TEXT PRIMARY KEY, "campaignId" TEXT NOT NULL, "leadId" TEXT NOT NULL,
 fingerprint TEXT NOT NULL UNIQUE, "actorId" TEXT NOT NULL,
 recipients JSONB NOT NULL, subject TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('submitting','accepted','partial','rejected','uncertain','not_submitted')),
 accepted JSONB NOT NULL DEFAULT '[]', rejected JSONB NOT NULL DEFAULT '[]',
 "providerMessageId" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "AdminOutreachSendAttempt_active_lead" ON "AdminOutreachSendAttempt" ("leadId") WHERE status IN ('submitting','uncertain');
CREATE INDEX "AdminOutreachSendAttempt_lead" ON "AdminOutreachSendAttempt" ("leadId", "createdAt");
