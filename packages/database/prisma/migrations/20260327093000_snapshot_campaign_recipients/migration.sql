ALTER TABLE "WhatsappCampaignRecipient"
    ADD COLUMN IF NOT EXISTS "snapshotPhone" TEXT,
    ADD COLUMN IF NOT EXISTS "snapshotFullName" TEXT,
    ADD COLUMN IF NOT EXISTS "snapshotLocation" TEXT,
    ADD COLUMN IF NOT EXISTS "snapshotListLabel" TEXT,
    ADD COLUMN IF NOT EXISTS "snapshotMetadata" JSONB;

UPDATE "WhatsappCampaignRecipient" r
SET
    "snapshotPhone" = COALESCE(
        r."snapshotPhone",
        c.phone
    ),
    "snapshotFullName" = COALESCE(
        r."snapshotFullName",
        m."fullName",
        c."fullName"
    ),
    "snapshotLocation" = COALESCE(
        r."snapshotLocation",
        m.location,
        c.location
    ),
    "snapshotListLabel" = COALESCE(
        r."snapshotListLabel",
        m."listLabel",
        c."listLabel",
        'default'
    ),
    "snapshotMetadata" = COALESCE(
        r."snapshotMetadata",
        m.metadata,
        c.metadata
    )
FROM "WhatsappCampaign" campaign
JOIN "WhatsappContact" c
  ON TRUE
LEFT JOIN "WhatsappContactListMembership" m
  ON m."contactId" = c.id
 AND m."userId" = campaign."userId"
 AND (
    campaign."listLabel" IS NULL
    OR m."listLabel" = campaign."listLabel"
 )
WHERE campaign.id = r."campaignId"
  AND c.id = r."contactId";
