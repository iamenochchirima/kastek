CREATE TABLE "EarlyAccessInvitation" (
  id TEXT PRIMARY KEY,
  "waitlistEntryId" TEXT NOT NULL REFERENCES "ProductWaitlistEntry"(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
  "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  "lastDeliveryAttemptAt" TIMESTAMPTZ,
  "lastDeliveryErrorCode" TEXT,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "acceptedAt" TIMESTAMPTZ,
  "revokedAt" TIMESTAMPTZ,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EarlyAccessInvitation_status_check" CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  CONSTRAINT "EarlyAccessInvitation_delivery_status_check" CHECK ("deliveryStatus" IN ('pending', 'sent', 'failed'))
);

CREATE UNIQUE INDEX "EarlyAccessInvitation_pending_application_key"
  ON "EarlyAccessInvitation" ("waitlistEntryId") WHERE status = 'pending';
CREATE INDEX "EarlyAccessInvitation_token_hash_idx" ON "EarlyAccessInvitation" ("tokenHash");
CREATE INDEX "EarlyAccessInvitation_status_expiry_idx" ON "EarlyAccessInvitation" (status, "expiresAt");

ALTER TABLE "ProductWaitlistEntry"
  DROP COLUMN IF EXISTS "invitationId",
  ADD COLUMN "earlyAccessInvitationId" TEXT,
  ADD COLUMN "packageKey" TEXT,
  ADD COLUMN "packageSnapshot" JSONB;

CREATE UNIQUE INDEX "ProductWaitlistEntry_earlyAccessInvitationId_key"
  ON "ProductWaitlistEntry" ("earlyAccessInvitationId");

ALTER TABLE "ProductWaitlistEntry"
  ADD CONSTRAINT "ProductWaitlistEntry_earlyAccessInvitationId_fkey"
  FOREIGN KEY ("earlyAccessInvitationId") REFERENCES "EarlyAccessInvitation"(id)
  ON DELETE SET NULL ON UPDATE CASCADE;
