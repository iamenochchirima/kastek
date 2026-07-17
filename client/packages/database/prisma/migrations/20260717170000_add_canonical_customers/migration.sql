-- Customers belong to an organization. Channel-specific identifiers remain
-- separate so identities are never merged by display name alone.
CREATE TABLE "Customer" (
    id TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "displayName" TEXT,
    metadata JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY (id),
    CONSTRAINT "Customer_orgId_id_key" UNIQUE ("orgId", id)
);

CREATE TABLE "CustomerIdentity" (
    id TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    channel TEXT NOT NULL,
    "scopeId" TEXT,
    "externalId" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "displayName" TEXT,
    metadata JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerIdentity_pkey" PRIMARY KEY (id)
);

ALTER TABLE "Conversation" ADD COLUMN "customerId" TEXT;
ALTER TABLE "WhatsappContact" ADD COLUMN "customerId" TEXT;

ALTER TABLE "Customer"
    ADD CONSTRAINT "Customer_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"(id)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CustomerIdentity"
    ADD CONSTRAINT "CustomerIdentity_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "CustomerIdentity_customerId_fkey"
    FOREIGN KEY ("orgId", "customerId") REFERENCES "Customer"("orgId", id)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_customerId_fkey"
    FOREIGN KEY ("orgId", "customerId") REFERENCES "Customer"("orgId", id)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WhatsappContact"
    ADD CONSTRAINT "WhatsappContact_customerId_fkey"
    FOREIGN KEY ("orgId", "customerId") REFERENCES "Customer"("orgId", id)
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "CustomerIdentity_orgId_identityKey_key"
    ON "CustomerIdentity"("orgId", "identityKey");
CREATE INDEX "Customer_orgId_displayName_idx" ON "Customer"("orgId", "displayName");
CREATE INDEX "Customer_orgId_updatedAt_idx" ON "Customer"("orgId", "updatedAt");
CREATE INDEX "CustomerIdentity_customerId_channel_idx"
    ON "CustomerIdentity"("customerId", channel);
CREATE INDEX "CustomerIdentity_orgId_channel_externalId_idx"
    ON "CustomerIdentity"("orgId", channel, "externalId");
CREATE INDEX "Conversation_customerId_lastMessageAt_idx"
    ON "Conversation"("customerId", "lastMessageAt");
CREATE INDEX "WhatsappContact_customerId_idx" ON "WhatsappContact"("customerId");

-- Existing WhatsApp contacts are the strongest available identity source.
INSERT INTO "Customer" (id, "orgId", "displayName", metadata, "createdAt", "updatedAt")
SELECT
    'customer_whatsapp_' || contact.id,
    contact."orgId",
    contact."fullName",
    jsonb_build_object('backfilledFrom', 'WhatsappContact', 'sourceId', contact.id),
    contact."createdAt",
    contact."updatedAt"
FROM "WhatsappContact" contact
WHERE contact."orgId" IS NOT NULL
ON CONFLICT (id) DO NOTHING;

INSERT INTO "CustomerIdentity" (
    id, "orgId", "customerId", channel, "scopeId", "externalId", "identityKey",
    "displayName", metadata, "createdAt", "updatedAt"
)
SELECT
    'identity_whatsapp_' || contact.id,
    contact."orgId",
    'customer_whatsapp_' || contact.id,
    'whatsapp',
    NULL,
    contact.phone,
    'whatsapp:' || contact.phone,
    contact."fullName",
    jsonb_build_object('backfilledFrom', 'WhatsappContact', 'sourceId', contact.id),
    contact."createdAt",
    contact."updatedAt"
FROM "WhatsappContact" contact
WHERE contact."orgId" IS NOT NULL
ON CONFLICT ("orgId", "identityKey") DO NOTHING;

UPDATE "WhatsappContact" contact
SET "customerId" = identity."customerId",
    "updatedAt" = GREATEST(contact."updatedAt", identity."updatedAt")
FROM "CustomerIdentity" identity
WHERE contact."orgId" IS NOT NULL
  AND identity."orgId" = contact."orgId"
  AND identity."identityKey" = 'whatsapp:' || contact.phone
  AND contact."customerId" IS DISTINCT FROM identity."customerId";

-- Some WhatsApp conversations may not yet have a contact. Create one customer
-- per organization and normalized phone identity, regardless of connection.
WITH whatsapp_conversations AS (
    SELECT DISTINCT ON (conversation."orgId", phone)
        conversation."orgId" AS org_id,
        phone,
        conversation."customerName" AS display_name,
        conversation."createdAt" AS created_at,
        conversation."updatedAt" AS updated_at
    FROM "Conversation" conversation
    CROSS JOIN LATERAL (
        SELECT NULLIF(
            substring(conversation."customerIdentifier" from '^[^:]+:[^:]+:(.*)$'),
            ''
        ) AS phone
    ) parsed
    WHERE conversation."orgId" IS NOT NULL
      AND conversation.channel = 'whatsapp'
      AND conversation."customerIdentifier" LIKE 'wa:%'
      AND phone IS NOT NULL
    ORDER BY conversation."orgId", phone, conversation."createdAt" ASC
)
INSERT INTO "Customer" (id, "orgId", "displayName", metadata, "createdAt", "updatedAt")
SELECT
    'customer_whatsapp_identity_' || md5(source.org_id || ':' || source.phone),
    source.org_id,
    source.display_name,
    jsonb_build_object('backfilledFrom', 'Conversation'),
    source.created_at,
    source.updated_at
FROM whatsapp_conversations source
WHERE NOT EXISTS (
    SELECT 1
    FROM "CustomerIdentity" identity
    WHERE identity."orgId" = source.org_id
      AND identity."identityKey" = 'whatsapp:' || source.phone
)
ON CONFLICT (id) DO NOTHING;

WITH whatsapp_conversations AS (
    SELECT DISTINCT ON (conversation."orgId", phone)
        conversation."orgId" AS org_id,
        phone,
        conversation."customerName" AS display_name,
        conversation."createdAt" AS created_at,
        conversation."updatedAt" AS updated_at
    FROM "Conversation" conversation
    CROSS JOIN LATERAL (
        SELECT NULLIF(
            substring(conversation."customerIdentifier" from '^[^:]+:[^:]+:(.*)$'),
            ''
        ) AS phone
    ) parsed
    WHERE conversation."orgId" IS NOT NULL
      AND conversation.channel = 'whatsapp'
      AND conversation."customerIdentifier" LIKE 'wa:%'
      AND phone IS NOT NULL
    ORDER BY conversation."orgId", phone, conversation."createdAt" ASC
)
INSERT INTO "CustomerIdentity" (
    id, "orgId", "customerId", channel, "scopeId", "externalId", "identityKey",
    "displayName", metadata, "createdAt", "updatedAt"
)
SELECT
    'identity_whatsapp_conversation_' || md5(source.org_id || ':' || source.phone),
    source.org_id,
    'customer_whatsapp_identity_' || md5(source.org_id || ':' || source.phone),
    'whatsapp',
    NULL,
    source.phone,
    'whatsapp:' || source.phone,
    source.display_name,
    jsonb_build_object('backfilledFrom', 'Conversation'),
    source.created_at,
    source.updated_at
FROM whatsapp_conversations source
ON CONFLICT ("orgId", "identityKey") DO NOTHING;

-- Meta IDs are scoped to the connected Facebook Page or Instagram account.
-- Including that channel connection in the identity key prevents accidental
-- merging when two provider accounts emit the same participant ID.
WITH meta_conversations AS (
    SELECT DISTINCT ON (
        conversation."orgId",
        conversation.channel,
        split_part(conversation."customerIdentifier", ':', 2),
        external_id
    )
        conversation."orgId" AS org_id,
        conversation.channel,
        split_part(conversation."customerIdentifier", ':', 2) AS scope_id,
        external_id,
        conversation."customerName" AS display_name,
        conversation."createdAt" AS created_at,
        conversation."updatedAt" AS updated_at
    FROM "Conversation" conversation
    CROSS JOIN LATERAL (
        SELECT NULLIF(
            substring(conversation."customerIdentifier" from '^[^:]+:[^:]+:(.*)$'),
            ''
        ) AS external_id
    ) parsed
    WHERE conversation."orgId" IS NOT NULL
      AND conversation.channel IN ('facebook', 'instagram')
      AND conversation."customerIdentifier" LIKE 'meta:%'
      AND split_part(conversation."customerIdentifier", ':', 2) <> ''
      AND external_id IS NOT NULL
    ORDER BY
        conversation."orgId",
        conversation.channel,
        split_part(conversation."customerIdentifier", ':', 2),
        external_id,
        conversation."createdAt" ASC
)
INSERT INTO "Customer" (id, "orgId", "displayName", metadata, "createdAt", "updatedAt")
SELECT
    'customer_meta_identity_' || md5(
        source.org_id || ':' || source.channel || ':' || source.scope_id || ':' || source.external_id
    ),
    source.org_id,
    source.display_name,
    jsonb_build_object('backfilledFrom', 'Conversation'),
    source.created_at,
    source.updated_at
FROM meta_conversations source
WHERE NOT EXISTS (
    SELECT 1
    FROM "CustomerIdentity" identity
    WHERE identity."orgId" = source.org_id
      AND identity."identityKey" =
        source.channel || ':' || source.scope_id || ':' || source.external_id
)
ON CONFLICT (id) DO NOTHING;

WITH meta_conversations AS (
    SELECT DISTINCT ON (
        conversation."orgId",
        conversation.channel,
        split_part(conversation."customerIdentifier", ':', 2),
        external_id
    )
        conversation."orgId" AS org_id,
        conversation.channel,
        split_part(conversation."customerIdentifier", ':', 2) AS scope_id,
        external_id,
        conversation."customerName" AS display_name,
        conversation."createdAt" AS created_at,
        conversation."updatedAt" AS updated_at
    FROM "Conversation" conversation
    CROSS JOIN LATERAL (
        SELECT NULLIF(
            substring(conversation."customerIdentifier" from '^[^:]+:[^:]+:(.*)$'),
            ''
        ) AS external_id
    ) parsed
    WHERE conversation."orgId" IS NOT NULL
      AND conversation.channel IN ('facebook', 'instagram')
      AND conversation."customerIdentifier" LIKE 'meta:%'
      AND split_part(conversation."customerIdentifier", ':', 2) <> ''
      AND external_id IS NOT NULL
    ORDER BY
        conversation."orgId",
        conversation.channel,
        split_part(conversation."customerIdentifier", ':', 2),
        external_id,
        conversation."createdAt" ASC
)
INSERT INTO "CustomerIdentity" (
    id, "orgId", "customerId", channel, "scopeId", "externalId", "identityKey",
    "displayName", metadata, "createdAt", "updatedAt"
)
SELECT
    'identity_meta_conversation_' || md5(
        source.org_id || ':' || source.channel || ':' || source.scope_id || ':' || source.external_id
    ),
    source.org_id,
    'customer_meta_identity_' || md5(
        source.org_id || ':' || source.channel || ':' || source.scope_id || ':' || source.external_id
    ),
    source.channel,
    source.scope_id,
    source.external_id,
    source.channel || ':' || source.scope_id || ':' || source.external_id,
    source.display_name,
    jsonb_build_object('backfilledFrom', 'Conversation'),
    source.created_at,
    source.updated_at
FROM meta_conversations source
ON CONFLICT ("orgId", "identityKey") DO NOTHING;

UPDATE "Conversation" conversation
SET "customerId" = identity."customerId",
    "updatedAt" = GREATEST(conversation."updatedAt", identity."updatedAt")
FROM "CustomerIdentity" identity
WHERE conversation."orgId" IS NOT NULL
  AND identity."orgId" = conversation."orgId"
  AND (
    (
      conversation.channel = 'whatsapp'
      AND conversation."customerIdentifier" LIKE 'wa:%'
      AND identity."identityKey" = 'whatsapp:' || NULLIF(
        substring(conversation."customerIdentifier" from '^[^:]+:[^:]+:(.*)$'),
        ''
      )
    )
    OR
    (
      conversation.channel IN ('facebook', 'instagram')
      AND conversation."customerIdentifier" LIKE 'meta:%'
      AND identity."identityKey" = conversation.channel || ':' ||
        split_part(conversation."customerIdentifier", ':', 2) || ':' ||
        NULLIF(
          substring(conversation."customerIdentifier" from '^[^:]+:[^:]+:(.*)$'),
          ''
        )
    )
  )
  AND conversation."customerId" IS DISTINCT FROM identity."customerId";
