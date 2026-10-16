-- Inbox owns a binding and sync/readiness state for each workspace mailbox.
-- Credentials remain exclusively in EmailConnection.
CREATE TABLE "EmailInboxBinding" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "emailConnectionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "inboundStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "outboundStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "syncCursor" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailInboxBinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailInboxBinding_emailConnectionId_key"
    ON "EmailInboxBinding"("emailConnectionId");
CREATE INDEX "EmailInboxBinding_orgId_status_idx"
    ON "EmailInboxBinding"("orgId", "status");
CREATE INDEX "EmailInboxBinding_emailConnectionId_status_idx"
    ON "EmailInboxBinding"("emailConnectionId", "status");

ALTER TABLE "EmailInboxBinding"
    ADD CONSTRAINT "EmailInboxBinding_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailInboxBinding"
    ADD CONSTRAINT "EmailInboxBinding_emailConnectionId_fkey"
    FOREIGN KEY ("emailConnectionId") REFERENCES "EmailConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing connected mailboxes are already visible in Inbox. Give them an
-- explicit binding so readiness is no longer inferred from the projection.
INSERT INTO "EmailInboxBinding" ("id", "orgId", "emailConnectionId", "status", "inboundStatus", "outboundStatus", "lastSyncedAt", "lastError", "createdAt", "updatedAt")
SELECT
    'eib_' || ec.id,
    ec."orgId",
    ec.id,
    CASE WHEN ec.status = 'CONNECTED' THEN 'ACTIVE' ELSE 'PAUSED' END,
    CASE WHEN ec.status = 'CONNECTED' THEN 'PENDING' ELSE 'BLOCKED' END,
    CASE WHEN ec.status = 'CONNECTED' THEN 'READY' ELSE 'BLOCKED' END,
    ec."lastSyncedAt",
    ec."lastError",
    ec."createdAt",
    CURRENT_TIMESTAMP
FROM "EmailConnection" ec
ON CONFLICT ("emailConnectionId") DO NOTHING;
