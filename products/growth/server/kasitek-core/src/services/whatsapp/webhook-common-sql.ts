export const WEBHOOK_COMMON_SQL = {
  find_or_create_conversation: [
    '\n        SELECT\n            id,\n            "unreadCount",\n            "lastMessageAt" AT TIME ZONE \'UTC\'\n        FROM "Conversation"\n        WHERE "orgId" = $1 AND channel = \'whatsapp\' AND "customerIdentifier" = $2\n        LIMIT 1\n        ',
    '\n            UPDATE "Conversation"\n            SET "customerName" = COALESCE($1, "customerName"),\n                "orgId" = $2,\n                "customerId" = COALESCE("customerId", $5),\n                "externalConnectionId" = COALESCE(\n                    "externalConnectionId",\n                    (SELECT id FROM "ExternalConnection"\n                     WHERE "orgId" = $2 AND "sourceType" = \'WHATSAPP\' AND "sourceId" = $4\n                     LIMIT 1)\n                )\n            WHERE id = $3\n            ',
    '\n        INSERT INTO "Conversation" (\n            id, "orgId", channel, "customerIdentifier", "customerName", status,\n            "lastMessageAt", "unreadCount", "externalConnectionId", "customerId",\n            "createdAt", "updatedAt"\n        )\n        VALUES (\n            $1, $2, \'whatsapp\', $3, $4, \'active\', $5, 0,\n            (SELECT id FROM "ExternalConnection"\n             WHERE "orgId" = $2 AND "sourceType" = \'WHATSAPP\' AND "sourceId" = $6\n             LIMIT 1),\n            $7, NOW(), NOW()\n        )\n        ',
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
  publish_conversation_updated: [
    'SELECT COALESCE("phoneDisplayNumber", "phoneNumberId") FROM "WhatsappConnection" WHERE id = $1 LIMIT 1',
  ],
  publish_message_created: [
    'SELECT COALESCE("phoneDisplayNumber", "phoneNumberId") FROM "WhatsappConnection" WHERE id = $1 LIMIT 1',
  ],
} as const;
