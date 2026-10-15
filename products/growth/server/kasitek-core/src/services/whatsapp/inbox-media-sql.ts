// Existing human WhatsApp media delivery queries.
export const MEDIA_DELIVERY_0 =
  '\n            SELECT id, "conversationId" AS conversation_id, sender, content, "whatsappMessageId" AS whatsapp_message_id,\n                   "whatsappStatus" AS whatsapp_status, "errorCode" AS error_code, "errorMessage" AS error_message,\n                   timestamp AT TIME ZONE \'UTC\' AS timestamp\n            FROM "Message"\n            WHERE id = $1 AND "conversationId" = $2\n            LIMIT 1\n            ';
export const MEDIA_DELIVERY_1 =
  '\n        INSERT INTO "Message" (id, "conversationId", sender, content, "contentType", "whatsappMessageId", "whatsappStatus", timestamp)\n        VALUES ($1, $2, \'bot\', $3, \'MEDIA\', $4, \'SENT\', $5)\n        ';
export const MEDIA_DELIVERY_2 =
  'UPDATE "Conversation" SET "lastMessageAt" = $1, status = \'active\', "updatedAt" = NOW() WHERE id = $2';
