CREATE TABLE IF NOT EXISTS "WhatsappContactListMembership" (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "listLabel" TEXT NOT NULL DEFAULT 'default',
    "fullName" TEXT,
    tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    location TEXT,
    metadata JSONB,
    "optIn" BOOLEAN NOT NULL DEFAULT false,
    "optInSource" TEXT,
    "optInDate" TIMESTAMP(3),
    excluded BOOLEAN NOT NULL DEFAULT false,
    notes TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WhatsappContactListMembership_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WhatsappContactListMembership_contactId_fkey"
        FOREIGN KEY ("contactId") REFERENCES "WhatsappContact"(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappContactListMembership_userId_contactId_listLabel_key"
    ON "WhatsappContactListMembership"("userId", "contactId", "listLabel");

CREATE INDEX IF NOT EXISTS "WhatsappContactListMembership_userId_listLabel_idx"
    ON "WhatsappContactListMembership"("userId", "listLabel");

CREATE INDEX IF NOT EXISTS "WhatsappContactListMembership_contactId_idx"
    ON "WhatsappContactListMembership"("contactId");

INSERT INTO "WhatsappContactListMembership" (
    id,
    "userId",
    "contactId",
    "listLabel",
    "fullName",
    tags,
    location,
    metadata,
    "optIn",
    "optInSource",
    "optInDate",
    excluded,
    notes,
    "createdAt",
    "updatedAt"
)
SELECT
    'wclm_' || substr(md5(c.id || ':' || COALESCE(c."listLabel", 'default')), 1, 24) AS id,
    c."userId",
    c.id AS "contactId",
    COALESCE(c."listLabel", 'default') AS "listLabel",
    c."fullName",
    COALESCE(c.tags, ARRAY[]::TEXT[]),
    c.location,
    c.metadata,
    c."optIn",
    c."optInSource",
    c."optInDate",
    c.excluded,
    c.notes,
    c."createdAt",
    c."updatedAt"
FROM "WhatsappContact" c
ON CONFLICT ("userId", "contactId", "listLabel") DO NOTHING;
