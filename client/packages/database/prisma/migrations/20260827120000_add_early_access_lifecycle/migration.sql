-- Early access keeps the existing waitlist table as the applicant record and adds
-- a small append-only transition log. All additions are nullable/defaulted so
-- existing website submissions remain readable and actionable.
ALTER TABLE "ProductWaitlistEntry"
  ADD COLUMN "contactConsentAt" TIMESTAMP(3),
  ADD COLUMN "reviewNotes" TEXT,
  ADD COLUMN "decisionReason" TEXT,
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "approvedById" TEXT,
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "organizationId" TEXT,
  ADD COLUMN "invitationId" TEXT,
  ADD COLUMN "activatedAt" TIMESTAMP(3),
  ADD COLUMN "earlyAccessEndsAt" TIMESTAMP(3),
  ADD COLUMN "entitlementGrantIds" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "creditGrantId" TEXT;

CREATE INDEX "ProductWaitlistEntry_status_createdAt_idx"
  ON "ProductWaitlistEntry"("status", "createdAt");
CREATE INDEX "ProductWaitlistEntry_email_idx"
  ON "ProductWaitlistEntry"("email");
CREATE INDEX "ProductWaitlistEntry_organizationId_idx"
  ON "ProductWaitlistEntry"("organizationId");
CREATE INDEX "ProductWaitlistEntry_earlyAccessEndsAt_idx"
  ON "ProductWaitlistEntry"("earlyAccessEndsAt");

CREATE TABLE "ProductWaitlistEvent" (
    "id" TEXT NOT NULL,
    "waitlistEntryId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductWaitlistEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProductWaitlistEvent_waitlistEntryId_fkey"
      FOREIGN KEY ("waitlistEntryId") REFERENCES "ProductWaitlistEntry"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ProductWaitlistEvent_waitlistEntryId_createdAt_idx"
  ON "ProductWaitlistEvent"("waitlistEntryId", "createdAt");
CREATE INDEX "ProductWaitlistEvent_action_createdAt_idx"
  ON "ProductWaitlistEvent"("action", "createdAt");
