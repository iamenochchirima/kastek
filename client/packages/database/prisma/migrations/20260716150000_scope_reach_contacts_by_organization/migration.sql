-- A phone number is one contact per workspace, regardless of which member
-- imported it. Repoint dependent records before removing duplicates.
DROP INDEX IF EXISTS "WhatsappContact_userId_phone_key";
DROP INDEX IF EXISTS "WhatsappContactListMembership_userId_contactId_listLabel_key";

CREATE TEMP TABLE "_WhatsappContactDuplicate" ON COMMIT DROP AS
SELECT id AS "duplicateId", "keepId"
FROM (
  SELECT
    id,
    FIRST_VALUE(id) OVER (
      PARTITION BY "orgId", phone
      ORDER BY "updatedAt" DESC, id
    ) AS "keepId",
    ROW_NUMBER() OVER (
      PARTITION BY "orgId", phone
      ORDER BY "updatedAt" DESC, id
    ) AS position
  FROM "WhatsappContact"
  WHERE "orgId" IS NOT NULL
) ranked
WHERE position > 1;

UPDATE "WhatsappContactListMembership" membership
SET "contactId" = duplicate."keepId"
FROM "_WhatsappContactDuplicate" duplicate
WHERE membership."contactId" = duplicate."duplicateId";

UPDATE "WhatsappCampaignRecipient" recipient
SET "contactId" = duplicate."keepId"
FROM "_WhatsappContactDuplicate" duplicate
WHERE recipient."contactId" = duplicate."duplicateId";

UPDATE "WhatsappSendEvent" event
SET "contactId" = duplicate."keepId"
FROM "_WhatsappContactDuplicate" duplicate
WHERE event."contactId" = duplicate."duplicateId";

DELETE FROM "WhatsappContact" contact
USING "_WhatsappContactDuplicate" duplicate
WHERE contact.id = duplicate."duplicateId";

CREATE TEMP TABLE "_WhatsappMembershipDuplicate" ON COMMIT DROP AS
SELECT id AS "duplicateId"
FROM (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "orgId", "contactId", "listLabel"
      ORDER BY "updatedAt" DESC, id
    ) AS position
  FROM "WhatsappContactListMembership"
  WHERE "orgId" IS NOT NULL
) ranked
WHERE position > 1;

DELETE FROM "WhatsappContactListMembership" membership
USING "_WhatsappMembershipDuplicate" duplicate
WHERE membership.id = duplicate."duplicateId";

CREATE UNIQUE INDEX "WhatsappContact_orgId_phone_key"
  ON "WhatsappContact"("orgId", phone);

CREATE UNIQUE INDEX "WhatsappContactListMembership_orgId_contactId_listLabel_key"
  ON "WhatsappContactListMembership"("orgId", "contactId", "listLabel");
