export const SQL = {
  find_or_create_conversation: [
    '\n        SELECT\n            id,\n            "unreadCount",\n            "lastMessageAt" AT TIME ZONE \'UTC\'\n        FROM "Conversation"\n        WHERE "orgId" = $1 AND channel = \'whatsapp\' AND "customerIdentifier" = $2\n        LIMIT 1\n        ',
    '\n            UPDATE "Conversation"\n            SET "customerName" = COALESCE($1, "customerName"),\n                "orgId" = $2,\n                "customerId" = COALESCE("customerId", $5),\n                "externalConnectionId" = COALESCE(\n                    "externalConnectionId",\n                    (SELECT id FROM "ExternalConnection"\n                     WHERE "orgId" = $2 AND "sourceType" = \'WHATSAPP\' AND "sourceId" = $4\n                     LIMIT 1)\n                )\n            WHERE id = $3\n            ',
    '\n        INSERT INTO "Conversation" (\n            id, "orgId", channel, "customerIdentifier", "customerName", status,\n            "lastMessageAt", "unreadCount", "externalConnectionId", "customerId",\n            "createdAt", "updatedAt"\n        )\n        VALUES (\n            $1, $2, \'whatsapp\', $3, $4, \'active\', $5, 0,\n            (SELECT id FROM "ExternalConnection"\n             WHERE "orgId" = $2 AND "sourceType" = \'WHATSAPP\' AND "sourceId" = $6\n             LIMIT 1),\n            $7, NOW(), NOW()\n        )\n        ',
  ],
  select_list_contact_row: [
    '\n        SELECT\n            m.id,\n            m."contactId" AS contact_id,\n            c."customerId" AS customer_id,\n            m."userId" AS user_id,\n            c.phone,\n            COALESCE(m."fullName", c."fullName") AS full_name,\n            COALESCE(m.tags, ARRAY[]::text[]) AS tags,\n            COALESCE(m.location, c.location) AS location,\n            m."listLabel" AS list_label,\n            m.metadata,\n            m."optIn" AS opt_in,\n            m."optInSource" AS opt_in_source,\n            m."optInDate" AT TIME ZONE \'UTC\' AS opt_in_date,\n            c."lastMarketingSent" AT TIME ZONE \'UTC\' AS last_marketing_sent,\n            m.excluded,\n            m.notes,\n            m."createdAt" AT TIME ZONE \'UTC\' AS created_at,\n            m."updatedAt" AT TIME ZONE \'UTC\' AS updated_at\n        FROM "WhatsappContactListMembership" m\n        JOIN "WhatsappContact" c ON c.id = m."contactId"\n        WHERE m.id = $1 AND m."orgId" = $2\n        LIMIT 1\n        ',
  ],
  select_campaign_contact_row: [
    '\n        SELECT c.id, c."userId" AS user_id,\n               COALESCE(r."snapshotPhone", c.phone) AS phone,\n               COALESCE(r."snapshotFullName", c."fullName") AS full_name,\n               COALESCE(m.tags, ARRAY[]::text[]) AS tags,\n               COALESCE(r."snapshotLocation", m.location, c.location) AS location,\n               COALESCE(r."snapshotListLabel", m."listLabel", c."listLabel", \'default\') AS list_label,\n               COALESCE(r."snapshotMetadata", m.metadata, c.metadata) AS metadata,\n               COALESCE(m."optIn", c."optIn") AS opt_in,\n               COALESCE(m."optInSource", c."optInSource") AS opt_in_source,\n               COALESCE(m."optInDate", c."optInDate") AT TIME ZONE \'UTC\' AS opt_in_date,\n               c."lastMarketingSent" AT TIME ZONE \'UTC\' AS last_marketing_sent,\n               COALESCE(m.excluded, c.excluded) AS excluded,\n               COALESCE(m.notes, c.notes) AS notes,\n               c."createdAt" AT TIME ZONE \'UTC\' AS created_at,\n               GREATEST(c."updatedAt", COALESCE(m."updatedAt", c."updatedAt"), r."updatedAt") AT TIME ZONE \'UTC\' AS updated_at\n        FROM "WhatsappCampaignRecipient" r\n        JOIN "WhatsappContact" c ON c.id = r."contactId"\n        LEFT JOIN "WhatsappContactListMembership" m\n          ON m."contactId" = c.id\n         AND m."orgId" = c."orgId"\n         AND m."listLabel" = COALESCE(r."snapshotListLabel", c."listLabel", \'default\')\n        WHERE r.id = $1 AND c."orgId" = $2\n        LIMIT 1\n        ',
  ],
  org_connection_ids: [
    'SELECT id FROM "WhatsappConnection" WHERE "orgId" = $1',
  ],
  scoped_conversation: [
    '\n        SELECT c.id, c.channel, c."customerIdentifier" AS customer_identifier, c."customerName" AS customer_name,\n               c.status,\n               c."lastMessageAt" AT TIME ZONE \'UTC\' AS last_message_at,\n               c."lastReadAt" AT TIME ZONE \'UTC\' AS last_read_at,\n               c.starred,\n               c."unreadCount" AS unread_count,\n               c."createdAt" AT TIME ZONE \'UTC\' AS created_at,\n               c."updatedAt" AT TIME ZONE \'UTC\' AS updated_at\n        FROM "Conversation" c\n        WHERE c.id = $1\n          AND c."orgId" = $2\n          AND c.channel = \'whatsapp\'\n          AND c."customerIdentifier" LIKE \'wa:%\'\n        LIMIT 1\n        ',
  ],
  load_conversation_by_id: [
    '\n        SELECT id, channel, "customerIdentifier" AS customer_identifier, "customerName" AS customer_name,\n               status,\n               "lastMessageAt" AT TIME ZONE \'UTC\' AS last_message_at,\n               "lastReadAt" AT TIME ZONE \'UTC\' AS last_read_at,\n               starred,\n               "unreadCount" AS unread_count,\n               "createdAt" AT TIME ZONE \'UTC\' AS created_at,\n               "updatedAt" AT TIME ZONE \'UTC\' AS updated_at\n        FROM "Conversation"\n        WHERE id = $1\n        LIMIT 1\n        ',
  ],
  load_message_by_id: [
    '\n        SELECT id, "conversationId" AS conversation_id, sender, content, "whatsappMessageId" AS whatsapp_message_id,\n               "whatsappStatus" AS whatsapp_status, "errorCode" AS error_code, "errorMessage" AS error_message,\n               timestamp AT TIME ZONE \'UTC\' AS timestamp\n        FROM "Message"\n        WHERE id = $1\n        LIMIT 1\n        ',
  ],
  conversation_org_id: [
    'SELECT "orgId" FROM "Conversation" WHERE id = $1 AND "orgId" IS NOT NULL',
  ],
  publish_campaign_updated: [
    'SELECT "orgId" FROM "WhatsappCampaign" WHERE id = $1 LIMIT 1',
  ],
  publish_conversation_updated: [
    'SELECT COALESCE("phoneDisplayNumber", "phoneNumberId") FROM "WhatsappConnection" WHERE id = $1 LIMIT 1',
  ],
  publish_message_created: [
    'SELECT COALESCE("phoneDisplayNumber", "phoneNumberId") FROM "WhatsappConnection" WHERE id = $1 LIMIT 1',
  ],
} as const;
