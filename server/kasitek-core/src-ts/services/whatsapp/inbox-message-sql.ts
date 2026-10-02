// Existing scoped reaction and local deletion statements.
export const SEND_MESSAGE_REACTION_0 =
  '\n        SELECT id, "conversationId" AS conversation_id, sender, content, "whatsappMessageId" AS whatsapp_message_id,\n               "whatsappStatus" AS whatsapp_status, "errorCode" AS error_code, "errorMessage" AS error_message,\n               timestamp AT TIME ZONE \'UTC\' AS timestamp\n        FROM "Message"\n        WHERE id = $1 AND "conversationId" = $2\n        LIMIT 1\n        ';
export const DELETE_CONVERSATION_MESSAGE_0 =
  '\n        SELECT sender, "contentType"::text, "providerMetadata"\n        FROM "Message"\n        WHERE id = $1 AND "conversationId" = $2\n        FOR UPDATE\n        ';
export const DELETE_CONVERSATION_MESSAGE_1 =
  'DELETE FROM "Message" WHERE id = $1 AND "conversationId" = $2';
export const DELETE_CONVERSATION_MESSAGE_2 =
  'SELECT timestamp AT TIME ZONE \'UTC\' FROM "Message" WHERE "conversationId" = $1 ORDER BY timestamp DESC LIMIT 1';
export const DELETE_CONVERSATION_MESSAGE_3 =
  'UPDATE "Conversation" SET "lastMessageAt" = $1, "updatedAt" = NOW() WHERE id = $2';
