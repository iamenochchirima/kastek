// Existing Agent WhatsApp delivery queries.
export const AGENT_DELIVERY_0 =
  '\n        SELECT id, "whatsappMessageId" AS provider_message_id, "whatsappStatus" AS status\n        FROM "Message"\n        WHERE "conversationId" = $1\n          AND "providerMetadata"->>\'_kasitek_agent_idempotency_key\' = $2\n        ORDER BY timestamp DESC\n        LIMIT 1\n        ';
export const AGENT_DELIVERY_1 =
  '\n        INSERT INTO "Message" (id, "conversationId", sender, content, "contentType", "whatsappStatus", "providerMetadata", timestamp)\n        VALUES ($1, $2, \'bot\', $3, \'TEXT\', \'SENDING\', $4::jsonb, $5)\n        ';
export const AGENT_DELIVERY_2 =
  'UPDATE "Conversation" SET "lastMessageAt" = NOW(), status = \'active\', "updatedAt" = NOW() WHERE id = $1 AND "orgId" = $2';
export const AGENT_DELIVERY_3 =
  'UPDATE "Message" SET "whatsappMessageId" = $1, "providerMessageId" = $1, "providerStatus" = \'sent\', "whatsappStatus" = \'SENT\' WHERE id = $2 AND "conversationId" = $3';
export const AGENT_DELIVERY_4 =
  'UPDATE "Message" SET "providerStatus" = \'failed\', "whatsappStatus" = \'FAILED\', "errorCode" = $1, "errorMessage" = $2 WHERE id = $3 AND "conversationId" = $4';
